"""0003_supabase_lockdown: Supabase's anon/authenticated roles get nothing,
schema_migrations is RLS-protected, and migrate.py still works as the owner.
Skipped without TEST_DATABASE_URL."""

import os
import subprocess
import sys

import psycopg

from conftest import SERVICE_DIR, app_conn, requires_db

pytestmark = requires_db

LOCKDOWN_SQL = (SERVICE_DIR / "migrations" / "0003_supabase_lockdown.sql").read_text()


def test_schema_migrations_has_rls_and_app_role_cannot_read_it(migrated_db, admin_conn):
    row = admin_conn.execute(
        "SELECT relrowsecurity FROM pg_class WHERE relname = 'schema_migrations'"
    ).fetchone()
    assert row["relrowsecurity"] is True
    with app_conn(None) as conn:
        try:
            conn.execute("SELECT * FROM schema_migrations")
        except psycopg.errors.InsufficientPrivilege:
            pass
        else:
            raise AssertionError("tcg_pos_app could read schema_migrations")


def test_migrate_is_rerunnable_as_owner(migrated_db):
    result = subprocess.run(
        [sys.executable, "scripts/migrate.py"],
        cwd=SERVICE_DIR,
        env={**os.environ, "DATABASE_URL": migrated_db},
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    assert "skip  0003_supabase_lockdown.sql" in result.stdout


def test_public_cannot_execute_functions(admin_conn):
    rows = admin_conn.execute(
        "SELECT p.proname, has_function_privilege('public', p.oid, 'EXECUTE') AS pub, "
        "has_function_privilege('tcg_pos_app', p.oid, 'EXECUTE') AS app "
        "FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace "
        "WHERE n.nspname = 'public'"
    ).fetchall()
    by_name = {r["proname"]: r for r in rows}
    assert not any(r["pub"] for r in rows), rows
    assert by_name["current_tenant_id"]["app"] is True


def test_lockdown_revokes_supabase_roles(migrated_db):
    """Simulate Supabase: create anon/authenticated with the grants its
    default privileges hand out, re-run the lockdown, and check they're gone.
    CREATE ROLE is transactional, so nothing outlives the rollback."""
    with psycopg.connect(migrated_db) as conn:
        try:
            for role in ("anon", "authenticated"):
                exists = conn.execute(
                    "SELECT 1 FROM pg_roles WHERE rolname = %s", (role,)
                ).fetchone()
                if not exists:
                    conn.execute(f"CREATE ROLE {role} NOLOGIN")
                conn.execute(f"GRANT USAGE ON SCHEMA public TO {role}")
                conn.execute(f"GRANT ALL ON ALL TABLES IN SCHEMA public TO {role}")
                conn.execute(f"GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO {role}")
                conn.execute(f"GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO {role}")
            conn.execute(LOCKDOWN_SQL)
            for role in ("anon", "authenticated"):
                n_tables = conn.execute(
                    "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
                    "WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v', 'S') "
                    "AND (has_table_privilege(%s, c.oid, 'SELECT') "
                    "  OR has_table_privilege(%s, c.oid, 'INSERT'))",
                    (role, role),
                ).fetchone()[0]
                assert n_tables == 0, role
                n_funcs = conn.execute(
                    "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace "
                    "WHERE n.nspname = 'public' AND has_function_privilege(%s, p.oid, 'EXECUTE')",
                    (role,),
                ).fetchone()[0]
                assert n_funcs == 0, role
        finally:
            conn.rollback()
