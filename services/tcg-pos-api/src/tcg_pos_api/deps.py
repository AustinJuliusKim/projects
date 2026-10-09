import uuid
from collections.abc import Iterator
from typing import Annotated

import psycopg
from fastapi import Depends, Header, HTTPException
from psycopg.rows import dict_row

from tcg_pos_api.config import database_url

# The NOLOGIN role every request runs as (created in migrations/0001_core.sql).
# Dropping to it per transaction means RLS applies even when DATABASE_URL's
# login role owns the tables or is a superuser.
APP_ROLE = "tcg_pos_app"


def get_plain_conn() -> Iterator[psycopg.Connection]:
    """Unscoped autocommit connection — only for /health, which touches no
    tenant data."""
    with psycopg.connect(database_url(), autocommit=True, row_factory=dict_row) as conn:
        yield conn


def tenant_id(
    x_tenant_id: Annotated[str | None, Header()] = None,
) -> uuid.UUID:
    # TODO(auth): the tenant comes from a client-supplied header for now, which
    # any caller can forge. Replace with a claim from a verified auth token
    # (Supabase Auth JWT) before any real store uses this — see the Ops tasks.
    if not x_tenant_id:
        raise HTTPException(401, "X-Tenant-Id header is required")
    try:
        return uuid.UUID(x_tenant_id)
    except ValueError:
        raise HTTPException(400, "X-Tenant-Id must be a UUID") from None


ACTOR_MAX = 200


def actor(x_actor: Annotated[str | None, Header()] = None) -> str:
    # TODO(auth): same as tenant_id — becomes the authenticated user's id.
    if not x_actor or not x_actor.strip():
        raise HTTPException(401, "X-Actor header is required for writes")
    value = x_actor.strip()
    if len(value) > ACTOR_MAX or "\x00" in value:
        raise HTTPException(400, f"X-Actor must be at most {ACTOR_MAX} characters, no NUL bytes")
    return value


def _tenant_conn(
    tenant: Annotated[uuid.UUID, Depends(tenant_id)],
) -> Iterator[psycopg.Connection]:
    """One connection and one transaction per request, scoped to the tenant:
    SET LOCAL ROLE drops to the RLS-bound app role and set_config(..., true)
    sets app.tenant_id for this transaction only, so nothing leaks to the next
    request on a pooled (Supabase transaction pooler, :6543) connection. The
    transaction commits when the route returns and rolls back if it raises
    (including HTTPException), so ledger + audit writes land together or not
    at all."""
    with psycopg.connect(database_url(), row_factory=dict_row) as conn:
        with conn.transaction():
            conn.execute(f"SET LOCAL ROLE {APP_ROLE}")
            conn.execute("SELECT set_config('app.tenant_id', %s, true)", (str(tenant),))
            yield conn


# scope="function": commit before the response is sent, so a failed commit
# surfaces as a 500 instead of a 2xx for a write that never landed.
TenantConn = Annotated[psycopg.Connection, Depends(_tenant_conn, scope="function")]
Actor = Annotated[str, Depends(actor)]
