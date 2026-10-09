"""SQL for the routes. Every function takes a connection already scoped to a
tenant (deps.TenantConn): RLS filters reads, and tenant_id columns default
to current_tenant_id(), so no query here passes a tenant id explicitly."""

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
    actor: str,
    action: str,
    entity: str,
    entity_id: uuid.UUID,
    before: dict[str, Any] | None,
    after: dict[str, Any] | None,
) -> None:
    conn.execute(
        "INSERT INTO audit_log (actor, action, entity, entity_id, before, after) "
        "VALUES (%s, %s, %s, %s, %s, %s)",
        (actor, action, entity, entity_id, _snapshot(before), _snapshot(after)),
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
    actor: str,
) -> uuid.UUID:
    row = conn.execute(
        "INSERT INTO inventory_ledger (inventory_item_id, delta, reason, channel, actor) "
        "VALUES (%s, %s, %s, %s, %s) RETURNING id",
        (item_id, delta, reason, channel, actor),
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
    actor: str,
) -> None:
    conn.execute(
        "INSERT INTO credit_ledger (customer_id, delta_cents, reason, actor) "
        "VALUES (%s, %s, %s, %s)",
        (customer_id, delta_cents, reason, actor),
    )
