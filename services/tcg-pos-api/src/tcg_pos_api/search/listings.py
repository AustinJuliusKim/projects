"""Listings indexer: keeps the `listings` OpenSearch alias in step with what
each published storefront sells online.

    python -m tcg_pos_api.search.listings rebuild [--keep N]
    python -m tcg_pos_api.search.listings drain [--batch N]
    python -m tcg_pos_api.search.listings follow [--batch N] [--poll SECONDS]
    python -m tcg_pos_api.search.listings status

  rebuild  a new versioned index (`listings-YYYYMMDD-HHMMSSmmm`) from
           published_storefronts() x their sellable stock, then an atomic
           alias swap; the previous index is kept for rollback. Events that
           queued meanwhile are drained into the new index afterwards.
  drain    apply queued search_outbox events until the queue is empty.
  follow   LISTEN search_outbox and drain on every wake-up, polling every
           5 s as a fallback; SIGTERM/SIGINT finish the current batch and
           exit 0. Runs as the local systemd service tcg-search-listings.
  status   outbox backlog and oldest event age, alias target, doc counts.

Env: DATABASE_URL — a login role granted tcg_pos_worker (claim/ack,
published_storefronts) and tcg_pos_app (tenant reads, RLS-bound); see
OPS.md. OPENSEARCH_URL (+ auth/TLS vars) as for tcg_search.

Design:
  * Single writer: drain and rebuild both hold the session advisory lock
    pg_advisory_lock(hashtext('listings_index')). `follow` only try-locks per
    cycle, so a nightly rebuild waits for at most one batch and `follow`
    skips cycles (events stay queued) while a rebuild runs.
  * Outbox contract (0007): claim <= --batch events as tcg_pos_worker, build
    every affected doc, bulk-index, and ack only after the bulk request had
    no item errors; any failure rolls back and the events are claimed again
    (at-least-once; docs are rebuilt whole, so replays are harmless).
  * Coalescing: events become {tenant: printings | ALL}; a whole-store event
    (printing_id NULL) subsumes that tenant's printing events.
  * Card data comes from the catalog index, not mtg_dev: a nested terms
    query on printings.printing_id maps printings to their card doc, whose
    `_source` already holds the card fields (tcg_search.docs.card_fields
    output) and every paper printing. So the POS still never reads the mtg
    database, both indices agree field for field, and one query yields the
    printing -> oracle_id map and the card's full printing list. Printings
    the catalog doesn't have (digital-only, too new, bad ids) are skipped,
    counted, and acked.
  * A card's doc is rebuilt from ALL of the store's offers for ALL of the
    card's printings (storefront.storefront_offers: web location, priced,
    holdback applied, > 0) and deleted when nothing is sellable (a 404 on
    delete is success).
  * A store that is unpublished or gone loses all its docs. Its doc ids are
    listed with a routed, tenant-filtered search and bulk-deleted, rather
    than delete_by_query: the deletes go through the same bulk call and
    per-item error check as everything else, so "ack only after success"
    holds, and no extra client surface is needed. A whole-store rebuild
    uses the same id list to drop docs for cards no longer in stock.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import logging
import signal
import sys
import threading
import time
import uuid
from collections.abc import Callable, Iterable, Iterator, Mapping
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from typing import Any

import psycopg
from psycopg.rows import dict_row
from tcg_search.catalog.build import cleanup, current, new_index_name, versions
from tcg_search.client import BulkAction, OpenSearch, OpenSearchError
from tcg_search.docs import listing_doc_from_catalog, listing_id
from tcg_search.mappings import listings_index_body

from tcg_pos_api import storefront
from tcg_pos_api.config import connect_kwargs, database_url
from tcg_pos_api.search import catalog_alias, listings_alias
from tcg_pos_api.storefront import Storefront

log = logging.getLogger("tcg_pos_api.search.listings")

LOCK_SQL = "hashtext('listings_index')"
DEFAULT_BATCH = 500
POLL_SECONDS = 5.0
CATALOG_CHUNK = 500  # printing ids per catalog lookup
ID_PAGE = 1000  # listing ids per page when listing a tenant's docs
DEFAULT_KEEP = 2  # current + previous, for rollback
DOC_VERSION = "1"


class IndexingError(Exception):
    """The bulk request had item errors: nothing is acked."""

    def __init__(self, errors: list[dict[str, Any]]):
        sample = "; ".join(f"{e.get('_id')}: {e.get('status')} {e.get('error')}"
                           for e in errors[:3])
        super().__init__(f"{len(errors)} bulk item errors ({sample})")
        self.errors = errors


@dataclass
class Stats:
    claimed: int = 0
    tenants: int = 0
    indexed: int = 0
    deleted: int = 0
    unknown_printings: int = 0
    stores_removed: int = 0

    def add(self, other: Stats) -> None:
        for k, v in asdict(other).items():
            setattr(self, k, getattr(self, k) + v)


def _now() -> datetime:
    return datetime.now(UTC)


def _chunks(items: list[Any], n: int) -> Iterator[list[Any]]:
    for i in range(0, len(items), n):
        yield items[i : i + n]


# --- pure planning -------------------------------------------------------------


def coalesce(events: Iterable[Mapping[str, Any]]) -> dict[uuid.UUID, set[uuid.UUID] | None]:
    """{tenant: printing ids to rebuild, or None = the whole store}. A
    whole-store event wins over that tenant's printing events."""
    plan: dict[uuid.UUID, set[uuid.UUID] | None] = {}
    for e in events:
        tenant, printing = e["tenant_id"], e["printing_id"]
        if printing is None:
            plan[tenant] = None
        elif tenant not in plan:
            plan[tenant] = {printing}
        elif plan[tenant] is not None:
            plan[tenant].add(printing)
    return plan


def _meta(tenant_id: Any, oracle_id: Any) -> dict[str, str]:
    return {"_id": listing_id(tenant_id, oracle_id), "routing": str(tenant_id)}


def card_actions(
    tenant_id: Any,
    cards: Mapping[str, Mapping[str, Any]],
    offers: Mapping[str, list[Mapping[str, Any]]],
    *,
    now: datetime,
) -> list[BulkAction]:
    """One index-or-delete action per card. `cards` is {oracle_id: catalog
    _source}; `offers` is {str(printing_id): live offers} for (at least)
    every printing of those cards."""
    out: list[BulkAction] = []
    for oracle_id, src in cards.items():
        mine = [o for p in src.get("printings") or [] for o in offers.get(p["printing_id"], [])]
        doc = listing_doc_from_catalog(src, tenant_id, mine, updated_at=now)
        meta = _meta(tenant_id, oracle_id)
        out.append(("index", meta, doc) if doc else ("delete", meta, None))
    return out


# --- reads ------------------------------------------------------------------------


def catalog_cards(
    os_: OpenSearch, printing_ids: Iterable[Any], *, index: str
) -> dict[str, dict[str, Any]]:
    """{str(printing_id): catalog card _source} for every given printing the
    catalog knows (paper printings only). Each _source has all its printings."""
    wanted = sorted({str(p) for p in printing_ids})
    out: dict[str, dict[str, Any]] = {}
    for chunk in _chunks(wanted, CATALOG_CHUNK):
        raw = os_.search(index, {
            "size": len(chunk),
            "query": {"nested": {"path": "printings", "query": {
                "terms": {"printings.printing_id": chunk}}}},
        })
        want = set(chunk)
        for hit in raw.get("hits", {}).get("hits", []):
            src = hit["_source"]
            for p in src.get("printings") or []:
                if p["printing_id"] in want:
                    out[p["printing_id"]] = src
    return out


def tenant_doc_ids(os_: OpenSearch, index: str, tenant_id: Any) -> set[str]:
    """Every listing doc id the tenant has in `index` (routed, paged)."""
    ids: set[str] = set()
    after = None
    while True:
        body: dict[str, Any] = {
            "size": ID_PAGE,
            "_source": False,
            "query": {"bool": {"filter": [{"term": {"tenant_id": str(tenant_id)}}]}},
            "sort": [{"oracle_id": "asc"}],
        }
        if after is not None:
            body["search_after"] = after
        raw = os_.search(index, body, params={"routing": str(tenant_id)})
        hits = raw.get("hits", {}).get("hits", [])
        ids.update(h["_id"] for h in hits)
        if len(hits) < ID_PAGE:
            return ids
        after = hits[-1]["sort"]


@contextlib.contextmanager
def tenant_tx(reader: psycopg.Connection, tenant_id: Any) -> Iterator[psycopg.Connection]:
    """A transaction as the API's tenant connection: tcg_pos_app + app.tenant_id."""
    with reader.transaction():
        reader.execute("SET LOCAL ROLE tcg_pos_app")
        reader.execute("SELECT set_config('app.tenant_id', %s, true)", (str(tenant_id),))
        yield reader


def read_offers(
    reader: psycopg.Connection, store: Storefront, printing_ids: Iterable[Any] | None
) -> dict[str, list[dict[str, Any]]]:
    """{str(printing_id): offers} with storefront_offers semantics; None =
    every printing the store sells online."""
    with tenant_tx(reader, store.tenant_id) as conn:
        if printing_ids is None:
            got = storefront.all_storefront_offers(conn, store)
        else:
            got = {}
            ids = sorted({uuid.UUID(str(p)) for p in printing_ids})
            for chunk in _chunks(ids, storefront.OFFER_PRINTINGS_MAX):
                got.update(storefront.storefront_offers(conn, store, chunk))
    return {str(k): v for k, v in got.items()}


def published_stores(db: psycopg.Connection) -> dict[uuid.UUID, Storefront]:
    """Call inside a transaction that already did SET LOCAL ROLE tcg_pos_worker."""
    rows = db.execute("SELECT * FROM published_storefronts()").fetchall()
    return {r["tenant_id"]: Storefront(**r) for r in rows}


# --- action builders (reads + pure planning) -----------------------------------------


@dataclass
class Sources:
    os_: OpenSearch
    reader: psycopg.Connection
    catalog_index: str
    now: Callable[[], datetime] = _now


def store_actions(
    src: Sources, store: Storefront, stats: Stats, *, existing: set[str] | None
) -> list[BulkAction]:
    """Every doc for a whole store; with `existing` (the store's current doc
    ids), also deletes for cards that are no longer sellable."""
    offers = read_offers(src.reader, store, None)
    by_printing = catalog_cards(src.os_, offers, index=src.catalog_index)
    stats.unknown_printings += len(set(offers) - set(by_printing))
    cards = {c["oracle_id"]: c for c in by_printing.values()}
    acts = card_actions(store.tenant_id, cards, offers, now=src.now())
    if existing:
        keep = {a[1]["_id"] for a in acts}
        acts += [("delete", {"_id": i, "routing": str(store.tenant_id)}, None)
                 for i in sorted(existing - keep)]
    return acts


def printing_actions(
    src: Sources, store: Storefront, printing_ids: set[Any], stats: Stats
) -> list[BulkAction]:
    """Docs for the cards these printings belong to, each rebuilt from the
    store's offers for every printing of the card."""
    by_printing = catalog_cards(src.os_, printing_ids, index=src.catalog_index)
    unknown = {str(p) for p in printing_ids} - set(by_printing)
    if unknown:
        stats.unknown_printings += len(unknown)
        log.info("tenant %s: %d printing(s) not in the catalog, skipped: %s", store.tenant_id,
                 len(unknown), sorted(unknown)[:5])
    cards = {c["oracle_id"]: c for c in by_printing.values()}
    all_printings = {p["printing_id"] for c in cards.values() for p in c.get("printings") or []}
    offers = read_offers(src.reader, store, all_printings) if all_printings else {}
    return card_actions(store.tenant_id, cards, offers, now=src.now())


def removal_actions(os_: OpenSearch, index: str, tenant_id: Any) -> list[BulkAction]:
    return [("delete", {"_id": i, "routing": str(tenant_id)}, None)
            for i in sorted(tenant_doc_ids(os_, index, tenant_id))]


def _count(acts: list[BulkAction], stats: Stats) -> None:
    stats.indexed += sum(1 for a in acts if a[0] == "index")
    stats.deleted += sum(1 for a in acts if a[0] == "delete")


# --- drain --------------------------------------------------------------------------


def drain_once(
    db: psycopg.Connection, src: Sources, *, alias: str, batch: int = DEFAULT_BATCH
) -> Stats:
    """Claim <= batch events, apply them, ack on success. Returns the stats
    (claimed == 0: the queue was empty). Raises IndexingError / OpenSearchError
    / psycopg errors with nothing acked. `db` must be autocommit (it also
    carries the session advisory lock)."""
    stats = Stats()
    with db.transaction():
        db.execute("SET LOCAL ROLE tcg_pos_worker")
        rows = db.execute(
            "SELECT id, tenant_id, printing_id, created_at FROM claim_search_outbox(%s)",
            (batch,),
        ).fetchall()
        stats.claimed = len(rows)
        if not rows:
            return stats
        stores = published_stores(db)
        plan = coalesce(rows)
        stats.tenants = len(plan)
        actions: list[BulkAction] = []
        for tenant, printings in plan.items():
            store = stores.get(tenant)
            if store is None:
                acts = removal_actions(src.os_, alias, tenant)
                stats.stores_removed += 1
            elif printings is None:
                acts = store_actions(src, store, stats,
                                     existing=tenant_doc_ids(src.os_, alias, tenant))
            else:
                acts = printing_actions(src, store, printings, stats)
            _count(acts, stats)
            actions += acts
        if actions:
            result = src.os_.bulk(actions, index=alias)
            if result.errors:
                raise IndexingError(result.errors)
        db.execute("SELECT ack_search_outbox(%s)", ([r["id"] for r in rows],))
    return stats


def drain(
    db: psycopg.Connection, src: Sources, *, alias: str, batch: int = DEFAULT_BATCH,
    stop: threading.Event | None = None,
) -> Stats:
    """drain_once until the queue is empty (or stop is set)."""
    total = Stats()
    while not (stop and stop.is_set()):
        stats = drain_once(db, src, alias=alias, batch=batch)
        total.add(stats)
        if stats.claimed:
            log.info("drained %s", asdict(stats))
        if stats.claimed < batch:
            break
    return total


# --- rebuild ------------------------------------------------------------------------


@dataclass
class RebuildResult:
    index: str
    previous: str | None = None
    stores: int = 0
    docs: int = 0
    seconds: float = 0.0
    stats: Stats = field(default_factory=Stats)
    deleted_versions: list[str] = field(default_factory=list)


class RebuildError(Exception):
    pass


def rebuild(
    db: psycopg.Connection, src: Sources, *, alias: str, keep: int = DEFAULT_KEEP
) -> RebuildResult:
    """Build a new versioned listings index from every published store and
    swap `alias` to it. Refuses to swap on any bulk item error or a doc count
    mismatch (the failed index is marked in _meta and cleaned up by the next
    good rebuild). The caller holds the writer lock and drains afterwards."""
    started = time.monotonic()
    with db.transaction():
        db.execute("SET LOCAL ROLE tcg_pos_worker")
        stores = published_stores(db)
    index = new_index_name(alias, src.now())
    result = RebuildResult(index=index, stores=len(stores))
    catalog_target = src.os_.get_alias(src.catalog_index) or [src.catalog_index]
    src.os_.create_index(index, listings_index_body())
    errors: list[dict[str, Any]] = []
    for store in stores.values():
        acts = store_actions(src, store, result.stats, existing=None)
        _count(acts, result.stats)
        if acts:
            errors += src.os_.bulk(acts, index=index).errors
        log.info("store %s: %d docs", store.slug, len(acts))
    src.os_.refresh(index)
    result.docs = src.os_.count(index, {"match_all": {}}) if result.stats.indexed else 0
    failure = None
    if errors:
        failure = str(IndexingError(errors))
    elif result.docs != result.stats.indexed:
        failure = f"index holds {result.docs} docs but {result.stats.indexed} were built"
    result.seconds = round(time.monotonic() - started, 1)
    src.os_.put_mapping(index, {"_meta": {
        "built_at": src.now().isoformat(timespec="seconds"),
        "doc_version": DOC_VERSION,
        "catalog": catalog_target[0],
        "stores": len(stores),
        "docs": result.stats.indexed,
        "unknown_printings": result.stats.unknown_printings,
        "build_seconds": result.seconds,
        **({"failed": failure} if failure else {}),
    }})
    if failure:
        raise RebuildError(f"{failure}; not swapping {index}")
    result.previous = current(src.os_, alias)
    src.os_.swap_alias(alias, index)
    log.info("alias %s -> %s (was %s)", alias, index, result.previous)
    result.deleted_versions = cleanup(src.os_, alias, keep=keep)
    return result


# --- locking + follow -------------------------------------------------------------------


@contextlib.contextmanager
def writer_lock(db: psycopg.Connection, *, wait: bool = True) -> Iterator[bool]:
    """The single-writer session lock (db must be autocommit). With
    wait=False, yields False instead of blocking when someone holds it."""
    if wait:
        db.execute(f"SELECT pg_advisory_lock({LOCK_SQL})")
    elif not db.execute(f"SELECT pg_try_advisory_lock({LOCK_SQL}) AS ok").fetchone()["ok"]:
        yield False
        return
    try:
        yield True
    finally:
        db.execute(f"SELECT pg_advisory_unlock({LOCK_SQL})")


def ensure_alias(db: psycopg.Connection, src: Sources, *, alias: str) -> RebuildResult | None:
    """First run: build the index if the alias doesn't exist yet."""
    if src.os_.get_alias(alias):
        return None
    log.info("alias %s missing: rebuilding", alias)
    return rebuild(db, src, alias=alias)


def follow(
    db: psycopg.Connection,
    listen: psycopg.Connection,
    src: Sources,
    *,
    alias: str,
    stop: threading.Event,
    batch: int = DEFAULT_BATCH,
    poll: float = POLL_SECONDS,
) -> None:
    """Drain on every NOTIFY search_outbox, and every `poll` seconds anyway
    (a missed notify, a failed batch, a cycle skipped during a rebuild).
    Returns when `stop` is set. OpenSearch and indexing errors are logged and
    retried next cycle; database errors propagate (systemd restarts us)."""
    listen.execute("LISTEN search_outbox")
    log.info("following search_outbox -> %s (poll %.0fs)", alias, poll)
    while not stop.is_set():
        try:
            with writer_lock(db, wait=False) as got:
                if got:
                    ensure_alias(db, src, alias=alias)
                    drain(db, src, alias=alias, batch=batch, stop=stop)
                else:
                    log.info("another writer holds the listings lock; skipping this cycle")
        except (OpenSearchError, IndexingError, RebuildError) as err:
            log.error("drain failed, will retry: %s", err)
        deadline = time.monotonic() + poll
        while not stop.is_set():
            left = deadline - time.monotonic()
            if left <= 0:
                break
            if any(True for _ in listen.notifies(timeout=min(left, 1.0), stop_after=1)):
                break
    log.info("stopped")


# --- status -------------------------------------------------------------------------


def status(db: psycopg.Connection, os_: OpenSearch, *, alias: str) -> dict[str, Any]:
    with db.transaction():
        db.execute("SET LOCAL ROLE tcg_pos_worker")
        q = db.execute("SELECT * FROM search_outbox_stats()").fetchone()
        age = db.execute("SELECT extract(epoch FROM now() - %s::timestamptz) AS s",
                         (q["oldest"],)).fetchone()["s"]
        stores = published_stores(db)
    out: dict[str, Any] = {
        "outbox": {"backlog": q["backlog"], "whole_store": q["whole_store"],
                   "tenants": q["tenants"],
                   "oldest_age_seconds": round(float(age), 1) if age is not None else None},
        "alias": alias,
    }
    try:
        cur = current(os_, alias)
        out["current"] = cur
        out["versions"] = [{"index": v, "current": v == cur, "docs": os_.count(v)}
                           for v in versions(os_, alias)]
        out["stores"] = [
            {"slug": s.slug, "tenant_id": str(t),
             "docs": os_.count(alias, {"term": {"tenant_id": str(t)}}) if cur else 0}
            for t, s in stores.items()
        ]
    except OpenSearchError as err:
        out["opensearch_error"] = str(err)
    return out


# --- CLI ----------------------------------------------------------------------------------


def _connect(**kw: Any) -> psycopg.Connection:
    return psycopg.connect(database_url(), autocommit=True, row_factory=dict_row,
                           **connect_kwargs(), **kw)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m tcg_pos_api.search.listings",
                                     description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="cmd", required=True)
    p_rebuild = sub.add_parser("rebuild", help="new index from every published store, swap")
    p_rebuild.add_argument("--keep", type=int, default=DEFAULT_KEEP)
    p_drain = sub.add_parser("drain", help="apply queued outbox events, then exit")
    p_follow = sub.add_parser("follow", help="LISTEN and drain until SIGTERM")
    for p in (p_drain, p_follow, p_rebuild):
        p.add_argument("--batch", type=int, default=DEFAULT_BATCH)
    p_follow.add_argument("--poll", type=float, default=POLL_SECONDS)
    sub.add_parser("status", help="outbox backlog, alias and doc counts (JSON)")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

    alias = listings_alias()
    with OpenSearch() as os_, _connect() as db:
        if args.cmd == "status":
            print(json.dumps(status(db, os_, alias=alias), indent=2, default=str))
            return 0
        with _connect() as reader:
            src = Sources(os_=os_, reader=reader, catalog_index=catalog_alias())
            if args.cmd == "rebuild":
                with writer_lock(db):
                    try:
                        res = rebuild(db, src, alias=alias, keep=args.keep)
                    except RebuildError as err:
                        log.error("%s", err)
                        return 2
                    log.info("rebuilt %s: %d stores, %d docs, %d unknown printings, %.1fs",
                             res.index, res.stores, res.docs, res.stats.unknown_printings,
                             res.seconds)
                    after = drain(db, src, alias=alias, batch=args.batch)
                    log.info("drained after rebuild: %s", asdict(after))
                return 0
            if args.cmd == "drain":
                with writer_lock(db):
                    ensure_alias(db, src, alias=alias)
                    total = drain(db, src, alias=alias, batch=args.batch)
                log.info("drain done: %s", asdict(total))
                return 0
            # follow
            stop = threading.Event()
            for sig in (signal.SIGTERM, signal.SIGINT):
                signal.signal(sig, lambda *_: stop.set())
            with _connect() as listen:
                follow(db, listen, src, alias=alias, stop=stop, batch=args.batch,
                       poll=args.poll)
            return 0


if __name__ == "__main__":
    sys.exit(main())
