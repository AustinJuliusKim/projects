import dataclasses
import re
from collections.abc import Iterator
from typing import Annotated

import psycopg
from fastapi import Depends, HTTPException
from psycopg.rows import dict_row

from tcg_pos_api.auth.perms import Perm
from tcg_pos_api.auth.principal import (
    APP_ROLE,
    Session,
    TenantSession,
    UserConn,
    UserSession,
    require,
    set_actor,
)
from tcg_pos_api.config import connect_kwargs, database_url
from tcg_pos_api.storefront import Storefront

__all__ = [
    "APP_ROLE",
    "Perm",
    "Session",
    "StorefrontConn",
    "StorefrontSession",
    "TenantConn",
    "TenantSession",
    "UserConn",
    "UserSession",
    "get_plain_conn",
    "require",
]


def get_plain_conn() -> Iterator[psycopg.Connection]:
    """Unscoped autocommit connection — only for /health, which touches no
    tenant data."""
    with psycopg.connect(
        database_url(), autocommit=True, row_factory=dict_row, **connect_kwargs()
    ) as conn:
        yield conn


def _session_conn(session: Session) -> psycopg.Connection:
    return session.conn


# The authenticated, tenant-scoped connection (auth/principal.py). Routes
# also declare a permission with require(Perm.X); the session is shared.
TenantConn = Annotated[psycopg.Connection, Depends(_session_conn)]


# --- public storefront -------------------------------------------------------

SLUG_RE = re.compile(r"^[a-z0-9-]{3,40}$")


@dataclasses.dataclass(frozen=True)
class StorefrontSession:
    """A public request's connection (in its one transaction, as tcg_pos_app,
    app.tenant_id set to the store's tenant) and the published store."""

    conn: psycopg.Connection
    store: Storefront


def _storefront_conn(slug: str) -> Iterator[StorefrontSession]:
    """Like the tenant session, but the tenant comes from the URL's slug,
    resolved on the server by storefront_by_slug() (published stores only).
    Requests from the public never choose their tenant: X-Tenant-Id is not
    read here at all. Unknown, unpublished and malformed slugs are all the
    same 404. The actor for anything written is storefront:<slug>."""
    slug = slug.strip().lower()
    if not SLUG_RE.match(slug):
        raise HTTPException(404, "no such store")
    with psycopg.connect(database_url(), row_factory=dict_row, **connect_kwargs()) as conn:
        with conn.transaction():
            conn.execute(f"SET LOCAL ROLE {APP_ROLE}")
            row = conn.execute("SELECT * FROM storefront_by_slug(%s)", (slug,)).fetchone()
            if row is None:
                raise HTTPException(404, "no such store")
            conn.execute("SELECT set_config('app.tenant_id', %s, true)", (str(row["tenant_id"]),))
            set_actor(conn, f"storefront:{row['slug']}")
            yield StorefrontSession(conn=conn, store=Storefront(**row))


StorefrontConn = Annotated[StorefrontSession, Depends(_storefront_conn, scope="function")]
