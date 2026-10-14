"""The listings indexer (tcg_pos_api.search.listings) against the real test
database and a fake OpenSearch (tests/fake_opensearch.py): coalescing,
holdback and unpriced stock, deletes, whole-store events, unpublished
stores, and "ack only after the bulk request succeeded". Pure planning
tests need no database; the rest skip without TEST_DATABASE_URL. The
real-OpenSearch end-to-end is test_listings_os.py."""

import threading
import uuid
from datetime import UTC, datetime

import psycopg
import pytest
from psycopg.rows import dict_row
from tcg_search.client import OpenSearchError

from conftest import TEST_DATABASE_URL, requires_db
from fake_opensearch import FakeOpenSearch, card_row, printing_row
from tcg_pos_api.search import listings as L

NOW = datetime(2026, 10, 10, 12, 0, tzinfo=UTC)


# --- pure ---------------------------------------------------------------------------------


def test_coalesce_whole_store_wins_and_dedupes():
    t1, t2, t3 = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    p1, p2 = uuid.uuid4(), uuid.uuid4()
    events = [
        {"tenant_id": t1, "printing_id": p1},
        {"tenant_id": t1, "printing_id": p1},
        {"tenant_id": t1, "printing_id": p2},
        {"tenant_id": t2, "printing_id": p1},
        {"tenant_id": t2, "printing_id": None},
        {"tenant_id": t2, "printing_id": p2},  # after the whole-store event: still whole
        {"tenant_id": t3, "printing_id": None},
    ]
    assert L.coalesce(events) == {t1: {p1, p2}, t2: None, t3: None}


def test_card_actions_index_or_delete():
    fake = FakeOpenSearch()
    pa, pb = uuid.uuid4(), uuid.uuid4()
    bolt = fake.add_card(card_row("Lightning Bolt", [printing_row(pa, "m11", "149"),
                                                     printing_row(pb, "lea", "161")]))
    other = fake.add_card(card_row("Shock", [printing_row(uuid.uuid4(), "m19", "156")]))
    offers = {str(pa): [{"printing_id": pa, "condition": "NM", "finish": "nonfoil", "lang": "en",
                         "price_cents": 150, "available": 2}],
              str(pb): [{"printing_id": pb, "condition": "LP", "finish": "nonfoil", "lang": "en",
                         "price_cents": 0, "available": 1}]}  # 0 = unpriced: never lists
    acts = L.card_actions("t1", {bolt["oracle_id"]: bolt, other["oracle_id"]: other}, offers,
                          now=NOW)
    (op1, meta1, doc1), (op2, meta2, doc2) = acts
    assert op1 == "index" and meta1 == {"_id": f"t1:{bolt['oracle_id']}", "routing": "t1"}
    assert [o["printing_id"] for o in doc1["offers"]] == [str(pa)]
    assert doc1["offers"][0]["set"] == "m11" and doc1["in_stock"] == 2
    assert doc1["updated_at"] == NOW.isoformat()
    assert (op2, meta2, doc2) == ("delete", {"_id": f"t1:{other['oracle_id']}",
                                             "routing": "t1"}, None)


# --- against the test database ------------------------------------------------------------


@pytest.fixture
def env(make_shop, admin_conn):
    """A fake cluster with two cards, a clean outbox, and worker/reader
    connections like the CLI's."""
    admin_conn.execute("DELETE FROM search_outbox")
    fake = FakeOpenSearch()
    p = {k: uuid.uuid4() for k in ("bolt_m11", "bolt_lea", "shock", "unknown")}
    bolt = fake.add_card(card_row("Lightning Bolt", [
        printing_row(p["bolt_m11"], "m11", "149", released="2010-07-16"),
        printing_row(p["bolt_lea"], "lea", "161", released="1993-08-05"),
    ]))
    shock = fake.add_card(card_row("Shock", [printing_row(p["shock"], "m19", "156")]))

    def shop(*args, **kw):
        # Creating the storefront enqueues a whole-store event; drop it so each
        # test starts from per-printing events only.
        made = make_shop(*args, **kw)
        admin_conn.execute("DELETE FROM search_outbox")
        return made

    with psycopg.connect(TEST_DATABASE_URL, autocommit=True, row_factory=dict_row) as db, \
            psycopg.connect(TEST_DATABASE_URL, autocommit=True, row_factory=dict_row) as reader:
        os_ = fake.client()
        src = L.Sources(os_=os_, reader=reader, catalog_index="catalog", now=lambda: NOW)
        yield {"fake": fake, "p": p, "bolt": bolt, "shock": shock, "db": db, "src": src,
               "admin": admin_conn, "make_shop": shop}


def drain(env, **kw):
    return L.drain(env["db"], env["src"], alias="listings", **kw)


def backlog(env):
    return env["admin"].execute("SELECT count(*) AS n FROM search_outbox").fetchone()["n"]


def doc_id(shop, card):
    return f"{shop['tenant']['id']}:{card['oracle_id']}"


@requires_db
def test_drain_builds_card_from_every_printing_with_holdback(env):
    shop = env["make_shop"](holdback_copies=1)
    p = env["p"]
    shop["stock"](3, 150, printing_id=p["bolt_m11"])  # web-available 2
    shop["stock"](1, 900, printing_id=p["bolt_lea"])  # held back entirely
    shop["stock"](5, None, printing_id=p["bolt_lea"], condition="LP")  # unpriced
    shop["stock"](4, 300, printing_id=p["bolt_lea"], finish="foil")  # web-available 3
    shop["stock"](2, 100, printing_id=p["unknown"])  # not in the catalog
    assert backlog(env) == 5

    stats = drain(env)
    assert (stats.claimed, stats.tenants, stats.indexed, stats.deleted,
            stats.unknown_printings) == (5, 1, 1, 0, 1)
    assert backlog(env) == 0
    doc = env["fake"].listings[doc_id(shop, env["bolt"])]
    assert doc["routing"] == str(shop["tenant"]["id"])
    got = sorted((o["set"], o["finish"], o["condition"], o["available"], o["price_cents"])
                 for o in doc["doc"]["offers"])
    assert got == [("lea", "foil", "NM", 3, 300), ("m11", "nonfoil", "NM", 2, 150)]
    assert doc["doc"]["in_stock"] == 5 and doc["doc"]["price_cents"] == 150
    assert doc["doc"]["tenant_id"] == str(shop["tenant"]["id"])
    # One bulk request, every write routed by tenant.
    (bulk,) = env["fake"].bulk_requests()
    assert bulk["index"] == "listings"
    # The card lookup asked the catalog for exactly the claimed printings.
    lookups = [r for r in env["fake"].searches("catalog")]
    assert sorted(lookups[0]["body"]["query"]["nested"]["query"]["terms"][
        "printings.printing_id"]) == sorted(str(p[k]) for k in ("bolt_m11", "bolt_lea",
                                                                  "unknown"))


@requires_db
def test_sold_out_card_is_deleted_and_404_counts_as_success(env):
    shop = env["make_shop"]()
    item = shop["stock"](1, 150, printing_id=env["p"]["shock"])
    drain(env)
    assert doc_id(shop, env["shock"]) in env["fake"].listings
    env["admin"].execute("UPDATE inventory_item SET qty = 0 WHERE id = %s", (item,))
    stats = drain(env)
    assert (stats.indexed, stats.deleted) == (0, 1)
    assert doc_id(shop, env["shock"]) not in env["fake"].listings
    # Deleting again (doc already gone -> 404) still acks.
    env["admin"].execute("UPDATE inventory_item SET price_cents = 200 WHERE id = %s", (item,))
    assert drain(env).deleted == 1 and backlog(env) == 0


@requires_db
def test_failed_bulk_acks_nothing_then_retries(env):
    shop = env["make_shop"]()
    shop["stock"](2, 150, printing_id=env["p"]["bolt_m11"])
    shop["stock"](2, 150, printing_id=env["p"]["shock"])
    env["fake"].fail_ids = {doc_id(shop, env["shock"])}
    with pytest.raises(L.IndexingError):
        drain(env)
    assert backlog(env) == 2  # rolled back: still queued
    env["fake"].fail_ids = set()
    assert drain(env).indexed == 2 and backlog(env) == 0


@requires_db
def test_opensearch_down_acks_nothing(env):
    shop = env["make_shop"]()
    shop["stock"](2, 150, printing_id=env["p"]["shock"])
    env["fake"].down = True
    with pytest.raises(OpenSearchError):
        drain(env)
    assert backlog(env) == 1


@requires_db
def test_whole_store_event_rebuilds_and_drops_stale_docs(env):
    shop = env["make_shop"]()
    tenant = str(shop["tenant"]["id"])
    shop["stock"](2, 150, printing_id=env["p"]["bolt_m11"])
    drain(env)
    # A doc the store no longer backs (e.g. left over from a lost event).
    stale = f"{tenant}:{env['shock']['oracle_id']}"
    env["fake"].listings[stale] = {"routing": tenant, "doc": {"tenant_id": tenant}}
    env["admin"].execute("UPDATE storefront SET holdback_pct = 10 WHERE tenant_id = %s",
                         (shop["tenant"]["id"],))
    stats = drain(env)
    assert (stats.indexed, stats.deleted) == (1, 1)
    assert stale not in env["fake"].listings
    assert doc_id(shop, env["bolt"]) in env["fake"].listings
    # The id listing was routed + tenant-filtered.
    (ids_q,) = [r for r in env["fake"].searches("listings") if r["body"].get("_source") is False]
    assert ids_q["params"] == {"routing": tenant}
    assert ids_q["body"]["query"]["bool"]["filter"] == [{"term": {"tenant_id": tenant}}]


@requires_db
def test_unpublished_store_loses_every_doc_and_only_its_own(env):
    a, b = env["make_shop"]("A"), env["make_shop"]("B")
    a["stock"](2, 150, printing_id=env["p"]["bolt_m11"])
    a["stock"](2, 150, printing_id=env["p"]["shock"])
    b["stock"](2, 150, printing_id=env["p"]["shock"])
    drain(env)
    assert len(env["fake"].listings) == 3
    env["admin"].execute("UPDATE storefront SET published = false WHERE tenant_id = %s",
                         (a["tenant"]["id"],))
    stats = drain(env)
    assert (stats.stores_removed, stats.deleted, stats.indexed) == (1, 2, 0)
    assert list(env["fake"].listings) == [doc_id(b, env["shock"])]


@requires_db
def test_events_of_many_tenants_coalesce_into_one_bulk(env):
    shops = [env["make_shop"](f"S{i}") for i in range(3)]
    for s in shops:
        for cond in ("NM", "LP", "MP"):
            s["stock"](1, 100, printing_id=env["p"]["shock"], condition=cond)
    stats = drain(env, batch=500)
    assert (stats.claimed, stats.tenants, stats.indexed) == (9, 3, 3)
    assert len(env["fake"].bulk_requests()) == 1
    # Small batches still drain everything.
    for s in shops:
        s["stock"](1, 100, printing_id=env["p"]["bolt_lea"])
    stats = drain(env, batch=2)
    assert stats.claimed == 3 and backlog(env) == 0


@requires_db
def test_writer_lock_is_exclusive(env):
    with psycopg.connect(TEST_DATABASE_URL, autocommit=True, row_factory=dict_row) as other:
        with L.writer_lock(env["db"]) as got:
            assert got
            with L.writer_lock(other, wait=False) as got2:
                assert got2 is False
        with L.writer_lock(other, wait=False) as got3:
            assert got3


@requires_db
def test_follow_drains_on_notify_and_stops(env):
    shop = env["make_shop"]()
    stop = threading.Event()
    with psycopg.connect(TEST_DATABASE_URL, autocommit=True, row_factory=dict_row) as listen:
        t = threading.Thread(target=L.follow, args=(env["db"], listen, env["src"]),
                             kwargs={"alias": "listings", "stop": stop, "poll": 30})
        t.start()
        try:
            shop["stock"](2, 150, printing_id=env["p"]["shock"])
            for _ in range(100):
                if doc_id(shop, env["shock"]) in env["fake"].listings:
                    break
                threading.Event().wait(0.05)
            assert doc_id(shop, env["shock"]) in env["fake"].listings  # long before the poll
        finally:
            stop.set()
            t.join(5)
        assert not t.is_alive()


@requires_db
def test_status_reports_backlog(env):
    shop = env["make_shop"]()
    shop["stock"](2, 150, printing_id=env["p"]["shock"])
    out = L.status(env["db"], env["fake"].client(), alias="listings")
    assert out["outbox"]["backlog"] == 1 and out["outbox"]["tenants"] == 1
    assert out["outbox"]["oldest_age_seconds"] >= 0
