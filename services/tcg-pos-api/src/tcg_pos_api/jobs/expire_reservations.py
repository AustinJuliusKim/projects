"""Release web reservations past their expires_at.

    DATABASE_URL=... python -m tcg_pos_api.jobs.expire_reservations [--limit N]

Finds due orders across tenants with web_orders_due_for_expiry() as
tcg_pos_worker, then releases each one in its own transaction as
tcg_pos_app with that order's tenant set — the same RLS-bound path and the
same reversal as a staff cancel (storefront.release_order), with status
'expired', ledger reason 'web_expire:<id>' and actor
'system:expire_reservations'. An order a clerk picked up or cancelled in the
meantime is skipped (the order row lock makes that race safe). Also prunes
old storefront rate-limit windows.

The DATABASE_URL login role must be granted both tcg_pos_worker and
tcg_pos_app (see OPS.md). Run it every few minutes (cron / systemd timer /
EventBridge); it is idempotent. Exit code 1 if any order failed."""

import argparse
import logging
import sys

import psycopg
from psycopg.rows import dict_row

from tcg_pos_api import storefront
from tcg_pos_api.config import connect_kwargs, database_url

logger = logging.getLogger("tcg_pos_api.jobs.expire_reservations")

ACTOR = "system:expire_reservations"


def run(conn: psycopg.Connection, *, limit: int = 500) -> dict[str, int]:
    """Expire up to `limit` due reservations on `conn` (not in a
    transaction). Returns counts: expired, skipped, failed, pruned."""
    with conn.transaction():
        conn.execute("SET LOCAL ROLE tcg_pos_worker")
        due = conn.execute(
            "SELECT tenant_id, id FROM web_orders_due_for_expiry(%s)", (limit,)
        ).fetchall()
    counts = {"expired": 0, "skipped": 0, "failed": 0, "pruned": 0}
    for row in due:
        try:
            with conn.transaction():
                conn.execute("SET LOCAL ROLE tcg_pos_app")
                conn.execute(
                    "SELECT set_config('app.tenant_id', %s, true)", (str(row["tenant_id"]),)
                )
                done = storefront.release_order(
                    conn, row["id"], status="expired", actor=ACTOR, only_if_due=True
                )
            counts["expired" if done else "skipped"] += 1
        except storefront.OrderStateError:
            counts["skipped"] += 1
        except Exception:
            logger.exception("failed to expire web order %s", row["id"])
            counts["failed"] += 1
    with conn.transaction():
        conn.execute("SET LOCAL ROLE tcg_pos_worker")
        counts["pruned"] = conn.execute(
            "SELECT prune_storefront_rate_counters() AS n"
        ).fetchone()["n"]
    return counts


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--limit", type=int, default=500, help="max orders per run (≤ 5000)")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    with psycopg.connect(
        database_url(), autocommit=True, row_factory=dict_row, **connect_kwargs()
    ) as conn:
        counts = run(conn, limit=args.limit)
    logger.info(
        "expired %(expired)d, skipped %(skipped)d, failed %(failed)d, "
        "pruned %(pruned)d rate windows", counts,
    )
    return 1 if counts["failed"] else 0


if __name__ == "__main__":
    sys.exit(main())
