"""SQL for the routes. Every function takes a connection already scoped to a
tenant (deps.TenantConn): RLS filters reads, and tenant_id columns default
to current_tenant_id(), so no query here passes a tenant id explicitly.
Likewise no query passes an actor: ledger and audit `actor` columns default
to the transaction's app.actor (set from the verified caller) and the
database rejects any other value (migrations/0011_rbac.sql)."""

import uuid
from typing import Any

import psycopg
from psycopg.types.json import Jsonb

ITEM_COLUMNS = (
    "id, location_id, printing_id, game, condition, finish, lang, qty, price_cents, updated_at"
)


def _snapshot(row: dict[str, Any] | None) -> Jsonb | None:
    if row is None:
        return None
    return Jsonb({k: str(v) if isinstance(v, uuid.UUID) else v for k, v in row.items()
                  if k != "updated_at"})


def write_audit(
    conn: psycopg.Connection,
    *,
    action: str,
    entity: str,
    entity_id: uuid.UUID,
    before: dict[str, Any] | None,
    after: dict[str, Any] | None,
) -> None:
    conn.execute(
        "INSERT INTO audit_log (action, entity, entity_id, before, after) "
        "VALUES (%s, %s, %s, %s, %s)",
        (action, entity, entity_id, _snapshot(before), _snapshot(after)),
    )


# --- inventory --------------------------------------------------------------


def list_inventory(
    conn: psycopg.Connection,
    *,
    location_id: uuid.UUID | None,
    printing_id: uuid.UUID | None,
    page: int,
    page_size: int,
) -> tuple[int, list[dict]]:
    where, params = [], []
    if location_id is not None:
        where.append("location_id = %s")
        params.append(location_id)
    if printing_id is not None:
        where.append("printing_id = %s")
        params.append(printing_id)
    clause = f"WHERE {' AND '.join(where)}" if where else ""
    total = conn.execute(f"SELECT count(*) AS n FROM inventory_item {clause}", params).fetchone()
    rows = conn.execute(
        f"SELECT {ITEM_COLUMNS} FROM inventory_item {clause} "
        "ORDER BY printing_id, condition, finish, lang, location_id, id "
        "LIMIT %s OFFSET %s",
        [*params, page_size, (page - 1) * page_size],
    ).fetchall()
    return total["n"], rows


def lock_or_create_item(conn: psycopg.Connection, grain: dict[str, Any]) -> tuple[dict, bool]:
    """Row-lock the inventory item at this grain, creating it (qty 0, price
    unknown) first if needed. Returns (row, created). The lock serializes
    concurrent adjustments to the same item."""
    created = conn.execute(
        "INSERT INTO inventory_item (location_id, printing_id, game, condition, finish, lang) "
        "VALUES (%(location_id)s, %(printing_id)s, %(game)s, %(condition)s, %(finish)s, %(lang)s) "
        "ON CONFLICT ON CONSTRAINT inventory_item_grain DO NOTHING RETURNING id",
        grain,
    ).fetchone()
    row = conn.execute(
        f"SELECT {ITEM_COLUMNS} FROM inventory_item "
        "WHERE location_id = %(location_id)s AND game = %(game)s "
        "AND printing_id = %(printing_id)s "
        "AND condition = %(condition)s AND finish = %(finish)s AND lang = %(lang)s "
        "FOR UPDATE",
        grain,
    ).fetchone()
    return row, created is not None


def set_item_qty(conn: psycopg.Connection, item_id: uuid.UUID, qty: int) -> dict:
    return conn.execute(
        f"UPDATE inventory_item SET qty = %s, updated_at = now() WHERE id = %s "
        f"RETURNING {ITEM_COLUMNS}",
        (qty, item_id),
    ).fetchone()


def insert_inventory_ledger(
    conn: psycopg.Connection,
    *,
    item_id: uuid.UUID,
    delta: int,
    reason: str,
    channel: str,
) -> uuid.UUID:
    row = conn.execute(
        "INSERT INTO inventory_ledger (inventory_item_id, delta, reason, channel) "
        "VALUES (%s, %s, %s, %s) RETURNING id",
        (item_id, delta, reason, channel),
    ).fetchone()
    return row["id"]


# --- store credit -----------------------------------------------------------


def lock_customer(conn: psycopg.Connection, customer_id: uuid.UUID) -> bool:
    """Row-lock the customer so concurrent issue/redeem calls serialize on the
    balance read. False if the customer doesn't exist for this tenant."""
    row = conn.execute(
        "SELECT id FROM customer WHERE id = %s FOR UPDATE", (customer_id,)
    ).fetchone()
    return row is not None


def credit_balance(conn: psycopg.Connection, customer_id: uuid.UUID) -> int | None:
    row = conn.execute(
        "SELECT balance_cents FROM customer_credit_balance WHERE customer_id = %s",
        (customer_id,),
    ).fetchone()
    return None if row is None else row["balance_cents"]


def insert_credit_ledger(
    conn: psycopg.Connection,
    *,
    customer_id: uuid.UUID,
    delta_cents: int,
    reason: str,
) -> None:
    conn.execute(
        "INSERT INTO credit_ledger (customer_id, delta_cents, reason) "
        "VALUES (%s, %s, %s)",
        (customer_id, delta_cents, reason),
    )


def lock_item(conn: psycopg.Connection, item_id: uuid.UUID) -> dict | None:
    return conn.execute(
        f"SELECT {ITEM_COLUMNS} FROM inventory_item WHERE id = %s FOR UPDATE", (item_id,)
    ).fetchone()


def find_item(conn: psycopg.Connection, grain: dict[str, Any]) -> dict | None:
    """The item at this grain, if any — a plain read (no lock, no insert),
    for previews."""
    return conn.execute(
        f"SELECT {ITEM_COLUMNS} FROM inventory_item "
        "WHERE location_id = %(location_id)s AND game = %(game)s "
        "AND printing_id = %(printing_id)s "
        "AND condition = %(condition)s AND finish = %(finish)s AND lang = %(lang)s",
        grain,
    ).fetchone()


def set_item_price(conn: psycopg.Connection, item_id: uuid.UUID, price_cents: int | None) -> dict:
    return conn.execute(
        f"UPDATE inventory_item SET price_cents = %s, updated_at = now() WHERE id = %s "
        f"RETURNING {ITEM_COLUMNS}",
        (price_cents, item_id),
    ).fetchone()


def location_exists(conn: psycopg.Connection, location_id: uuid.UUID) -> bool:
    row = conn.execute("SELECT 1 FROM location WHERE id = %s", (location_id,)).fetchone()
    return row is not None


# --- price rule ------------------------------------------------------------

PRICE_RULE_COLUMNS = (
    "nm_bp, lp_bp, mp_bp, hp_bp, dmg_bp, min_price_cents, round_up_to_cents, updated_at"
)


def get_price_rule(conn: psycopg.Connection, *, lock: bool = False) -> dict | None:
    """This tenant's rule row, or None when it still uses the defaults."""
    sql = f"SELECT {PRICE_RULE_COLUMNS} FROM price_rule"
    return conn.execute(sql + (" FOR UPDATE" if lock else "")).fetchone()


def upsert_price_rule(conn: psycopg.Connection, rule: dict[str, int]) -> dict:
    return conn.execute(
        "INSERT INTO price_rule (nm_bp, lp_bp, mp_bp, hp_bp, dmg_bp, min_price_cents, "
        "round_up_to_cents) VALUES (%(nm_bp)s, %(lp_bp)s, %(mp_bp)s, %(hp_bp)s, %(dmg_bp)s, "
        "%(min_price_cents)s, %(round_up_to_cents)s) "
        "ON CONFLICT (tenant_id) DO UPDATE SET nm_bp = EXCLUDED.nm_bp, lp_bp = EXCLUDED.lp_bp, "
        "mp_bp = EXCLUDED.mp_bp, hp_bp = EXCLUDED.hp_bp, dmg_bp = EXCLUDED.dmg_bp, "
        "min_price_cents = EXCLUDED.min_price_cents, "
        "round_up_to_cents = EXCLUDED.round_up_to_cents, updated_at = now() "
        f"RETURNING {PRICE_RULE_COLUMNS}",
        rule,
    ).fetchone()


# --- storefront ------------------------------------------------------------

STOREFRONT_COLUMNS = (
    "slug, display_name, published, location_id, holdback_copies, holdback_pct, "
    "reservation_hours, custom_domain, policy_text, pickup_text, updated_at"
)
STOREFRONT_FIELDS = (
    "slug", "display_name", "published", "location_id", "holdback_copies", "holdback_pct",
    "reservation_hours", "custom_domain", "policy_text", "pickup_text",
)


def get_storefront(conn: psycopg.Connection, *, lock: bool = False) -> dict | None:
    """This tenant's storefront settings row (published or not), or None."""
    sql = f"SELECT {STOREFRONT_COLUMNS} FROM storefront"
    return conn.execute(sql + (" FOR UPDATE" if lock else "")).fetchone()


def upsert_storefront(conn: psycopg.Connection, settings: dict[str, Any]) -> dict:
    cols = ", ".join(STOREFRONT_FIELDS)
    values = ", ".join(f"%({f})s" for f in STOREFRONT_FIELDS)
    updates = ", ".join(f"{f} = EXCLUDED.{f}" for f in STOREFRONT_FIELDS)
    return conn.execute(
        f"INSERT INTO storefront ({cols}) VALUES ({values}) "
        f"ON CONFLICT (tenant_id) DO UPDATE SET {updates}, updated_at = now() "
        f"RETURNING {STOREFRONT_COLUMNS}",
        settings,
    ).fetchone()
