"""Storefront logic shared by the public routes (routes/storefront.py), the
staff web-order routes (routes/web_orders.py) and the expiry job
(jobs/expire_reservations.py). Like queries.py, every function takes a
connection already scoped to one tenant (deps.StorefrontConn or
deps.TenantConn), so RLS does the tenant filtering.

The holdback rule lives in SQL (web_available(), migrations/0006) and is
always applied there, never re-implemented here."""

import dataclasses
import secrets
import uuid
from collections.abc import Iterable, Sequence
from typing import Any

import psycopg

from tcg_pos_api import queries

# The public columns storefront_by_slug() / published_storefronts() return.


@dataclasses.dataclass(frozen=True)
class Storefront:
    tenant_id: uuid.UUID
    slug: str
    display_name: str
    location_id: uuid.UUID
    holdback_copies: int
    holdback_pct: int
    reservation_hours: int
    pickup_text: str | None
    policy_text: str | None


CONDITION_ORDER = "ARRAY['NM', 'LP', 'MP', 'HP', 'DMG']"
OFFER_PRINTINGS_MAX = 500


def storefront_offers(
    conn: psycopg.Connection, store: Storefront, printing_ids: Iterable[uuid.UUID]
) -> dict[uuid.UUID, list[dict[str, Any]]]:
    """Live, sellable offers for these printings at the storefront's
    location: priced (price_cents not null) with web_available > 0 after
    holdback. Returns {printing_id: [offer, ...]} for printings that have
    any, each list ordered finish, condition (NM first), lang, price.

    An offer is {inventory_item_id, printing_id, game, condition, finish,
    lang, price_cents, available}; `available` is the web-sellable quantity,
    never the shelf quantity. Callers must keep printing_ids bounded
    (OFFER_PRINTINGS_MAX)."""
    ids = list(dict.fromkeys(printing_ids))
    if not ids:
        return {}
    if len(ids) > OFFER_PRINTINGS_MAX:
        raise ValueError(f"at most {OFFER_PRINTINGS_MAX} printings per call")
    rows = conn.execute(
        "SELECT id AS inventory_item_id, printing_id, game, condition, finish, lang, "
        "price_cents, web_available(qty, %(copies)s, %(pct)s) AS available "
        "FROM inventory_item "
        "WHERE printing_id = ANY(%(ids)s) AND location_id = %(loc)s "
        "AND price_cents IS NOT NULL AND web_available(qty, %(copies)s, %(pct)s) > 0 "
        f"ORDER BY printing_id, finish, array_position({CONDITION_ORDER}, condition), lang, "
        "price_cents, id",
        {
            "ids": ids,
            "loc": store.location_id,
            "copies": store.holdback_copies,
            "pct": store.holdback_pct,
        },
    ).fetchall()
    out: dict[uuid.UUID, list[dict[str, Any]]] = {}
    for r in rows:
        out.setdefault(r["printing_id"], []).append(r)
    return out


# --- cart lines ----------------------------------------------------------------


def check_lines(
    conn: psycopg.Connection,
    store: Storefront,
    lines: Sequence[dict[str, Any]],
    *,
    lock: bool,
) -> tuple[list[dict[str, Any]], dict[uuid.UUID, dict]]:
    """Price `lines` ({inventory_item_id, qty, unit_price_cents?}) against
    live stock. Returns (results, items_by_id). Each result carries status:
      ok            sellable at the current price
      not_found     no such item at this storefront's location (or other tenant's)
      not_priced    the item has no shelf price, so it isn't for sale online
      insufficient  web_available (after holdback) is below qty
      price_changed the caller's expected unit_price_cents differs from live
    lock=True takes FOR UPDATE row locks in id order (the order path), so
    concurrent reservations serialize per item without deadlocking."""
    ids = sorted({line["inventory_item_id"] for line in lines})
    rows = conn.execute(
        f"SELECT {queries.ITEM_COLUMNS}, web_available(qty, %s, %s) AS available "
        "FROM inventory_item WHERE id = ANY(%s) ORDER BY id" + (" FOR UPDATE" if lock else ""),
        (store.holdback_copies, store.holdback_pct, ids),
    ).fetchall()
    items = {r["id"]: r for r in rows if r["location_id"] == store.location_id}

    results = []
    for line in lines:
        item = items.get(line["inventory_item_id"])
        result: dict[str, Any] = {
            "inventory_item_id": line["inventory_item_id"],
            "qty": line["qty"],
            "status": "ok",
            "available": 0,
            "unit_price_cents": None,
            "line_total_cents": None,
            "printing_id": None,
            "condition": None,
            "finish": None,
            "lang": None,
        }
        if item is None:
            result["status"] = "not_found"
            results.append(result)
            continue
        result.update(
            available=item["available"] if item["price_cents"] is not None else 0,
            unit_price_cents=item["price_cents"],
            printing_id=item["printing_id"],
            condition=item["condition"],
            finish=item["finish"],
            lang=item["lang"],
        )
        expected = line.get("unit_price_cents")
        if item["price_cents"] is None:
            result["status"] = "not_priced"
        elif item["available"] < line["qty"]:
            result["status"] = "insufficient"
        elif expected is not None and expected != item["price_cents"]:
            result["status"] = "price_changed"
        if result["status"] == "ok" or result["status"] == "price_changed":
            result["line_total_cents"] = item["price_cents"] * line["qty"]
        results.append(result)
    return results, items


# --- web orders ------------------------------------------------------------------

ORDER_COLUMNS = (
    "id, location_id, status, pickup_code, customer_name, customer_email, customer_phone, "
    "total_cents, expires_at, created_at, updated_at"
)
LINE_COLUMNS = (
    "id, web_order_id, inventory_item_id, printing_id, game, condition, finish, lang, name, "
    "unit_price_cents, qty"
)
# No 0/O or 1/I: read aloud at a counter. 32 symbols, 6 chars: ~1e9 codes, and
# a code is only ever checked together with the order's UUID.
PICKUP_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
PICKUP_CODE_LEN = 6


def new_pickup_code() -> str:
    return "".join(secrets.choice(PICKUP_ALPHABET) for _ in range(PICKUP_CODE_LEN))


class OrderRejected(Exception):
    """Some lines can't be reserved; `issues` are check_lines results."""

    def __init__(self, issues: list[dict[str, Any]]):
        super().__init__("some lines can't be reserved")
        self.issues = issues


class IdempotencyConflict(Exception):
    """The idempotency key was already used for a different order."""


class OrderStateError(Exception):
    """The order isn't in a state that allows this transition."""

    def __init__(self, status: str):
        super().__init__(f"order is {status}")
        self.status = status


def get_order(
    conn: psycopg.Connection, order_id: uuid.UUID, *, lock: bool = False
) -> dict | None:
    sql = f"SELECT {ORDER_COLUMNS} FROM web_order WHERE id = %s"
    return conn.execute(sql + (" FOR UPDATE" if lock else ""), (order_id,)).fetchone()


def order_lines(
    conn: psycopg.Connection, order_ids: Sequence[uuid.UUID]
) -> dict[uuid.UUID, list[dict]]:
    rows = conn.execute(
        f"SELECT {LINE_COLUMNS} FROM web_order_line WHERE web_order_id = ANY(%s) "
        "ORDER BY web_order_id, inventory_item_id",
        (list(order_ids),),
    ).fetchall()
    out: dict[uuid.UUID, list[dict]] = {oid: [] for oid in order_ids}
    for r in rows:
        out[r["web_order_id"]].append(r)
    return out


def _same_request(existing_lines: list[dict], existing: dict, customer: dict, lines) -> bool:
    want = sorted((line["inventory_item_id"], line["qty"]) for line in lines)
    have = sorted((line["inventory_item_id"], line["qty"]) for line in existing_lines)
    return want == have and existing["customer_email"] == customer["email"]


def reserve_order(
    conn: psycopg.Connection,
    store: Storefront,
    *,
    idempotency_key: str,
    customer: dict[str, Any],
    lines: Sequence[dict[str, Any]],
) -> tuple[dict, list[dict], bool]:
    """Reserve `lines` for pickup in the caller's transaction. Returns
    (order, lines, created). A replay of an idempotency key returns the
    original order with created=False; the same key with a different
    request raises IdempotencyConflict. Raises OrderRejected (nothing
    written) if any line isn't sellable as asked.

    Per line: qty is decremented, an inventory_ledger row (channel 'web',
    negative delta, reason 'web_reserve:<order id>', actor 'web:<email>')
    and an audit row are written, and the line snapshots the unit price. The
    search outbox triggers fire from the qty update."""
    # Serialize requests sharing a key, so a concurrent retry waits and then
    # finds the first one's order instead of racing it into the unique index.
    conn.execute(
        "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
        (f"web_order:{store.tenant_id}:{idempotency_key}",),
    )
    existing = conn.execute(
        f"SELECT {ORDER_COLUMNS} FROM web_order WHERE idempotency_key = %s", (idempotency_key,)
    ).fetchone()
    if existing is not None:
        existing_lines = order_lines(conn, [existing["id"]])[existing["id"]]
        if not _same_request(existing_lines, existing, customer, lines):
            raise IdempotencyConflict()
        return existing, existing_lines, False

    results, items = check_lines(conn, store, lines, lock=True)
    issues = [r for r in results if r["status"] != "ok"]
    if issues:
        raise OrderRejected(issues)

    actor = f"web:{customer['email']}"
    total = sum(r["line_total_cents"] for r in results)
    order = conn.execute(
        "INSERT INTO web_order (location_id, pickup_code, customer_name, customer_email, "
        "customer_phone, idempotency_key, total_cents, expires_at) "
        "VALUES (%s, %s, %s, %s, %s, %s, %s, now() + make_interval(hours => %s)) "
        f"RETURNING {ORDER_COLUMNS}",
        (
            store.location_id,
            new_pickup_code(),
            customer["name"],
            customer["email"],
            customer.get("phone"),
            idempotency_key,
            total,
            store.reservation_hours,
        ),
    ).fetchone()

    reason = f"web_reserve:{order['id']}"
    for line in lines:
        before = items[line["inventory_item_id"]]
        before = {k: v for k, v in before.items() if k != "available"}
        after = queries.set_item_qty(conn, before["id"], before["qty"] - line["qty"])
        queries.insert_inventory_ledger(
            conn, item_id=before["id"], delta=-line["qty"], reason=reason, channel="web",
            actor=actor,
        )
        queries.write_audit(
            conn, actor=actor, action="web_order.reserve", entity="inventory_item",
            entity_id=before["id"], before=before, after=after,
        )
        conn.execute(
            "INSERT INTO web_order_line (web_order_id, inventory_item_id, printing_id, game, "
            "condition, finish, lang, name, unit_price_cents, qty) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
            (
                order["id"], before["id"], before["printing_id"], before["game"],
                before["condition"], before["finish"], before["lang"], line.get("name"),
                before["price_cents"], line["qty"],
            ),
        )
    queries.write_audit(
        conn, actor=actor, action="web_order.create", entity="web_order",
        entity_id=order["id"], before=None,
        after={"status": order["status"], "total_cents": total, "lines": len(lines),
               "customer_email": customer["email"]},
    )
    return order, order_lines(conn, [order["id"]])[order["id"]], True


def mark_picked_up(conn: psycopg.Connection, order_id: uuid.UUID, *, actor: str) -> dict | None:
    """reserved -> picked_up. The stock was already taken at reserve time, so
    no ledger row. None if no such order; OrderStateError if not reserved."""
    order = get_order(conn, order_id, lock=True)
    if order is None:
        return None
    if order["status"] != "reserved":
        raise OrderStateError(order["status"])
    after = _set_status(conn, order_id, "picked_up")
    queries.write_audit(
        conn, actor=actor, action="web_order.picked_up", entity="web_order",
        entity_id=order_id, before={"status": "reserved"}, after={"status": "picked_up"},
    )
    return after


RELEASE_REASONS = {"cancelled": "web_cancel", "expired": "web_expire"}


def release_order(
    conn: psycopg.Connection,
    order_id: uuid.UUID,
    *,
    status: str,
    actor: str,
    only_if_due: bool = False,
) -> dict | None:
    """reserved -> cancelled | expired, putting every line's qty back with a
    positive ledger row (channel 'web', reason 'web_cancel:<id>' or
    'web_expire:<id>') and an audit row. The order row is locked first, so
    two releases of the same order serialize and the second sees it is no
    longer reserved (OrderStateError) — stock comes back exactly once.
    None if no such order (or, with only_if_due, if it isn't due yet)."""
    reason = f"{RELEASE_REASONS[status]}:{order_id}"
    order = get_order(conn, order_id, lock=True)
    if order is None:
        return None
    if order["status"] != "reserved":
        raise OrderStateError(order["status"])
    if only_if_due:
        due = conn.execute(
            "SELECT expires_at <= now() AS due FROM web_order WHERE id = %s", (order_id,)
        ).fetchone()["due"]
        if not due:
            return None
    lines = order_lines(conn, [order_id])[order_id]
    by_item = {line["inventory_item_id"]: line for line in lines}
    items = conn.execute(
        f"SELECT {queries.ITEM_COLUMNS} FROM inventory_item WHERE id = ANY(%s) "
        "ORDER BY id FOR UPDATE",
        (sorted(by_item),),
    ).fetchall()
    for before in items:
        n = by_item[before["id"]]["qty"]
        after = queries.set_item_qty(conn, before["id"], before["qty"] + n)
        queries.insert_inventory_ledger(
            conn, item_id=before["id"], delta=n, reason=reason, channel="web", actor=actor
        )
        queries.write_audit(
            conn, actor=actor, action=f"web_order.{status}", entity="inventory_item",
            entity_id=before["id"], before=before, after=after,
        )
    after = _set_status(conn, order_id, status)
    queries.write_audit(
        conn, actor=actor, action=f"web_order.{status}", entity="web_order",
        entity_id=order_id, before={"status": "reserved"}, after={"status": status},
    )
    return after


def _set_status(conn: psycopg.Connection, order_id: uuid.UUID, status: str) -> dict:
    return conn.execute(
        f"UPDATE web_order SET status = %s, updated_at = now() WHERE id = %s "
        f"RETURNING {ORDER_COLUMNS}",
        (status, order_id),
    ).fetchone()


def list_orders(
    conn: psycopg.Connection, *, status: str | None, page: int, page_size: int
) -> tuple[int, list[dict]]:
    where, params = ("WHERE status = %s", [status]) if status else ("", [])
    total = conn.execute(f"SELECT count(*) AS n FROM web_order {where}", params).fetchone()
    rows = conn.execute(
        f"SELECT {ORDER_COLUMNS} FROM web_order {where} ORDER BY created_at DESC, id "
        "LIMIT %s OFFSET %s",
        [*params, page_size, (page - 1) * page_size],
    ).fetchall()
    return total["n"], rows
