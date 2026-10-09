#!/usr/bin/env python3
"""Plain SQL migration runner: applies migrations/*.sql in filename order,
recording applied names in schema_migrations. Each migration runs in its
own transaction.

Usage:
  DATABASE_URL=postgres://... python scripts/migrate.py
  python scripts/migrate.py --dry-run     # validate + plan, no connection

Semantics are a port of services/guided-repl-api/scripts/migrate.js.
"""

import os
import re
import sys
from pathlib import Path

MIGRATIONS_DIR = Path(__file__).resolve().parent.parent / "migrations"
NAME_RE = re.compile(r"^\d{4}_[a-z0-9_]+\.sql$")


def load_migrations() -> list[tuple[str, str]]:
    """Ordered, validated (name, sql) migrations."""
    names = sorted(p.name for p in MIGRATIONS_DIR.glob("*.sql"))
    if not names:
        raise RuntimeError(f"no .sql migrations found in {MIGRATIONS_DIR}")
    migrations = []
    for i, name in enumerate(names):
        if not NAME_RE.match(name):
            raise RuntimeError(f'migration "{name}" does not match NNNN_name.sql')
        seq = int(name[:4])
        if seq != i + 1:
            raise RuntimeError(f'migration "{name}" breaks the sequence (expected {i + 1:04d}_…)')
        sql = (MIGRATIONS_DIR / name).read_text(encoding="utf-8")
        if not sql.strip():
            raise RuntimeError(f'migration "{name}" is empty')
        migrations.append((name, sql))
    return migrations


def main() -> None:
    dry_run = "--dry-run" in sys.argv[1:]
    migrations = load_migrations()

    if dry_run:
        print(f"migrate --dry-run: {len(migrations)} migration(s) parse clean:")
        for name, sql in migrations:
            print(f"  - {name} ({len(sql.encode('utf-8'))} bytes)")
        return

    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise RuntimeError("DATABASE_URL is required (or pass --dry-run)")

    import psycopg

    with psycopg.connect(database_url) as conn:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS schema_migrations "
            "(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
        )
        conn.commit()
        applied = {row[0] for row in conn.execute("SELECT name FROM schema_migrations")}
        conn.commit()

        for name, sql in migrations:
            if name in applied:
                print(f"skip  {name} (already applied)")
                continue
            try:
                with conn.transaction():
                    conn.execute(sql)
                    conn.execute("INSERT INTO schema_migrations (name) VALUES (%s)", (name,))
                print(f"apply {name}")
            except Exception as err:
                raise RuntimeError(f"migration {name} failed: {err}") from err
        print("migrate: up to date.")


if __name__ == "__main__":
    try:
        main()
    except Exception as err:
        print(f"migrate: {err}", file=sys.stderr)
        sys.exit(1)
