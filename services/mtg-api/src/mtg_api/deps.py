from collections.abc import Iterator

import psycopg
from psycopg.rows import dict_row

from mtg_api.config import database_url


def get_conn() -> Iterator[psycopg.Connection]:
    """One connection per request, autocommit (read-only API) — plays nicely
    with the Supabase transaction pooler (:6543) the Lambda connects through."""
    with psycopg.connect(database_url(), autocommit=True, row_factory=dict_row) as conn:
        yield conn
