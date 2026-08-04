import psycopg

from mtg_api.config import database_url


def connect() -> psycopg.Connection:
    """One plain connection, explicit transactions. Ingest runs against the
    Supabase session pooler (port 5432); the phase-2 Lambda will use the
    transaction pooler (6543) with its own short-lived connections."""
    return psycopg.connect(database_url())
