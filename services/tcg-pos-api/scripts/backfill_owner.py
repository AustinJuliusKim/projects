#!/usr/bin/env python3
"""Make a user the owner of an existing store (stores created before
0011_rbac, e.g. the demo store from seed_demo_store.py):

  DATABASE_URL=postgres://postgres:postgres@localhost:54329/tcg_pos_dev \
    python scripts/backfill_owner.py --tenant <uuid> --email owner@demo.test [--sub <sub>]

--sub defaults to the dev issuer's sub for --email (auth/dev.py), so the
user can then sign in with scripts/dev_token.py or POST /v1/dev/login. For
a Cognito user pass their real `sub`. Idempotent: an existing membership is
set to owner/active. Connects as DATABASE_URL's role directly (an admin
operation, like migrate.py) and writes an audit row with actor
'job:backfill_owner'."""

import argparse
import sys
import uuid

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from tcg_pos_api.auth.dev import dev_sub
from tcg_pos_api.config import connect_kwargs, database_url

ACTOR = "job:backfill_owner"


def backfill(conn: psycopg.Connection, tenant: uuid.UUID, sub: str, email: str) -> uuid.UUID:
    """In the caller's transaction. Returns the user id."""
    conn.execute("SELECT set_config('app.tenant_id', %s, true)", (str(tenant),))
    if conn.execute("SELECT 1 FROM tenant WHERE id = %s", (tenant,)).fetchone() is None:
        raise SystemExit(f"no tenant {tenant}")
    user = conn.execute("SELECT id FROM ensure_app_user(%s, %s)", (sub, email)).fetchone()["id"]
    before = conn.execute(
        "SELECT r.key AS role, m.status FROM membership m JOIN role r ON r.id = m.role_id "
        "WHERE m.tenant_id = %s AND m.user_id = %s",
        (tenant, user),
    ).fetchone()
    conn.execute(
        "INSERT INTO membership (tenant_id, user_id, role_id) "
        "SELECT %s, %s, id FROM role WHERE tenant_id IS NULL AND key = 'owner' "
        "ON CONFLICT (tenant_id, user_id) DO UPDATE SET role_id = EXCLUDED.role_id, "
        "status = 'active', updated_at = now()",
        (tenant, user),
    )
    conn.execute(
        "INSERT INTO audit_log (tenant_id, actor, action, entity, entity_id, before, after) "
        "VALUES (%s, %s, 'staff.backfill_owner', 'membership', %s, %s, %s)",
        (
            tenant,
            ACTOR,
            user,
            Jsonb(before) if before else None,
            Jsonb({"role": "owner", "status": "active", "email": email}),
        ),
    )
    return user


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--tenant", required=True, type=uuid.UUID)
    parser.add_argument("--email", required=True)
    parser.add_argument("--sub", help="identity-provider sub (default: the dev issuer's)")
    args = parser.parse_args(argv)
    email = args.email.strip().lower()
    sub = args.sub or dev_sub(email)
    with psycopg.connect(database_url(), row_factory=dict_row, **connect_kwargs()) as conn:
        with conn.transaction():
            user = backfill(conn, args.tenant, sub, email)
    print(f"user {user} (sub {sub}, {email}) is now an owner of tenant {args.tenant}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
