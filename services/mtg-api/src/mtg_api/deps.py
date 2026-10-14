from collections.abc import Iterator

import psycopg
from psycopg.rows import dict_row

from mtg_api.config import database_url


def get_conn() -> Iterator[psycopg.Connection]:
    """One connection per request, autocommit (read-only API) — plays nicely
    with the Supabase transaction pooler (:6543) the Lambda connects through."""
    with psycopg.connect(database_url(), autocommit=True, row_factory=dict_row) as conn:
        yield conn


def get_snapshot_conn() -> Iterator[psycopg.Connection]:
    """Read-only REPEATABLE READ transaction for snapshot-keyed responses, so
    the snapshot id, ETag and every price row come from one consistent view
    even while the daily snapshot commits."""
    with psycopg.connect(database_url(), row_factory=dict_row) as conn:
        conn.isolation_level = psycopg.IsolationLevel.REPEATABLE_READ
        conn.read_only = True
        try:
            yield conn
        finally:
            conn.rollback()
