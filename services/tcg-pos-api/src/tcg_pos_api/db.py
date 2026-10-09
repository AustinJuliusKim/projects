import psycopg

from tcg_pos_api.config import database_url


def connect() -> psycopg.Connection:
    """One plain connection, explicit transactions — for scripts and admin
    work (migrations run through scripts/migrate.py). Request handling goes
    through deps.get_conn, which also scopes the connection to a tenant."""
    return psycopg.connect(database_url())
