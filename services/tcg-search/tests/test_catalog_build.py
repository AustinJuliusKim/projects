"""Catalog build guards and alias lifecycle, against an in-memory fake of
the client (no network)."""

from datetime import UTC, datetime, timedelta

import pytest

from fixtures_cards import sample_rows
from tcg_search.catalog import build as b
from tcg_search.client import BulkResult


class FakeOS:
    def __init__(self, bulk_errors=None, drop=0):
        self.indices: dict[str, dict] = {}
        self.aliases: dict[str, list[str]] = {}
        self.bulk_errors = bulk_errors or []
        self.drop = drop  # docs the "cluster" silently loses

    def create_index(self, name, body):
        assert name not in self.indices
        self.indices[name] = {"docs": {}, "body": body, "meta": {}}

    def bulk(self, actions, *, index=None, **kw):
        res = BulkResult()
        for _op, meta, doc in actions:
            self.indices[index]["docs"][meta["_id"]] = doc
            res.ok += 1
        res.errors = list(self.bulk_errors)
        return res

    def put_settings(self, index, settings):
        pass

    def refresh(self, index):
        pass

    def forcemerge(self, index):
        self.merged = index

    def put_mapping(self, index, body):
        self.indices[index]["meta"] = body["_meta"]

    def count(self, index):
        return max(0, len(self.indices[index]["docs"]) - self.drop)

    def get_alias(self, alias):
        return list(self.aliases.get(alias, []))

    def swap_alias(self, alias, new_index):
        old = [i for i in self.aliases.get(alias, []) if i != new_index]
        self.aliases[alias] = [new_index]
        return old

    def list_indices(self, pattern):
        prefix = pattern.rstrip("*")
        return [{"index": i, "docs.count": str(len(v["docs"])), "store.size": "100"}
                for i, v in sorted(self.indices.items()) if i.startswith(prefix)]

    def delete_index(self, name, missing_ok=False):
        self.indices.pop(name, None)
        return True

    def get_index(self, name):
        return {name: {"mappings": {"_meta": self.indices[name]["meta"]}}}


def clock(start=datetime(2026, 10, 10, 21, 0, tzinfo=UTC)):
    t = {"now": start}

    def now():
        t["now"] += timedelta(seconds=61)
        return t["now"]

    return now


def test_build_and_swap_records_meta():
    os_ = FakeOS()
    res = b.build(os_, sample_rows(), alias="t_catalog", swap=True, meta={"source_db": "x"},
                  now=clock())
    assert res.swapped and res.previous is None
    assert res.docs == 7 and res.printings == 9 - 2  # 2 digital printings dropped
    assert os_.aliases["t_catalog"] == [res.index]
    assert res.index.startswith("t_catalog-20261010-")
    meta = os_.indices[res.index]["meta"]
    assert meta["docs"] == 7 and meta["source_db"] == "x" and meta["bulk_errors"] == 0
    assert "Tarmogoyf" not in meta["unresolved_nicknames"]
    assert "Dark Confidant" in meta["unresolved_nicknames"]
    # Built with refresh disabled; build() turns it back on.
    assert os_.indices[res.index]["body"]["settings"]["index"]["refresh_interval"] == "-1"


def test_no_swap_without_flag():
    os_ = FakeOS()
    res = b.build(os_, sample_rows(), alias="t_catalog", now=clock())
    assert not res.swapped and "t_catalog" not in os_.aliases


def test_bulk_errors_block_the_swap():
    os_ = FakeOS(bulk_errors=[{"_id": "x", "status": 400, "error": "mapper"}])
    with pytest.raises(b.BuildError, match="1 bulk errors"):
        b.build(os_, sample_rows(), alias="t_catalog", swap=True, now=clock())
    assert "t_catalog" not in os_.aliases


def test_count_mismatch_blocks_the_swap():
    os_ = FakeOS(drop=1)
    with pytest.raises(b.BuildError, match="were extracted"):
        b.build(os_, sample_rows(), alias="t_catalog", swap=True, now=clock())


def test_empty_extract_blocks_the_swap():
    with pytest.raises(b.BuildError, match="no cards"):
        b.build(FakeOS(), [], alias="t_catalog", swap=True, now=clock())


def test_shrink_guard():
    os_ = FakeOS()
    now = clock()
    first = b.build(os_, sample_rows(), alias="t_catalog", swap=True, now=now)
    with pytest.raises(b.BuildError, match="below 95%"):
        b.build(os_, sample_rows()[:5], alias="t_catalog", swap=True, now=now)
    assert os_.aliases["t_catalog"] == [first.index]  # unchanged


def test_cleanup_keeps_current_and_previous_and_rollback():
    os_ = FakeOS()
    now = clock()
    built = [b.build(os_, sample_rows(), alias="t_catalog", swap=True, now=now).index
             for _ in range(4)]
    assert b.versions(os_, "t_catalog") == built[-2:]
    prev, target = b.rollback(os_, "t_catalog")
    assert (prev, target) == (built[-1], built[-2])
    with pytest.raises(b.BuildError, match="no version older"):
        b.rollback(os_, "t_catalog")
    _, target = b.swap(os_, "t_catalog")  # default: newest
    assert target == built[-1]
    with pytest.raises(b.BuildError, match="no such good version"):
        b.swap(os_, "t_catalog", "t_catalog-nope")


def test_failed_build_is_left_then_cleaned():
    os_ = FakeOS()
    now = clock()
    good = b.build(os_, sample_rows(), alias="t_catalog", swap=True, now=now).index
    os_.bulk_errors = [{"_id": "x", "status": 400}]
    with pytest.raises(b.BuildError):
        b.build(os_, sample_rows(), alias="t_catalog", swap=True, now=now)
    assert len(b.versions(os_, "t_catalog")) == 2  # the failed one is kept for inspection
    os_.bulk_errors = []
    newest = b.build(os_, sample_rows(), alias="t_catalog", swap=True, now=now).index
    # The failed build is not kept as the rollback target; the good one is.
    assert b.versions(os_, "t_catalog") == [good, newest]
    assert b.rollback(os_, "t_catalog") == (newest, good)


def test_status():
    os_ = FakeOS()
    res = b.build(os_, sample_rows(), alias="t_catalog", swap=True, now=clock())
    st = b.status(os_, "t_catalog")
    assert st["current"] == res.index
    assert st["versions"][0]["current"] is True
    assert st["versions"][0]["meta"]["docs"] == 7


def test_alias_pointing_at_two_indices_is_an_error():
    os_ = FakeOS()
    os_.aliases["t_catalog"] = ["a", "b"]
    with pytest.raises(b.BuildError, match="2 indices"):
        b.current(os_, "t_catalog")
