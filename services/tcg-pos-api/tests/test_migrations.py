"""Migration lint, no database needed — mirrors what CI's --dry-run enforces."""

import importlib.util
import re
import subprocess
import sys
from pathlib import Path

SERVICE_DIR = Path(__file__).resolve().parent.parent

spec = importlib.util.spec_from_file_location("migrate", SERVICE_DIR / "scripts" / "migrate.py")
migrate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migrate)


def test_migrations_are_named_sequenced_and_non_empty():
    migrations = migrate.load_migrations()
    assert migrations, "expected at least one migration"
    for i, (name, sql) in enumerate(migrations):
        assert re.match(r"^\d{4}_[a-z0-9_]+\.sql$", name)
        assert int(name[:4]) == i + 1
        assert sql.strip()


def test_every_migration_opens_with_a_why_comment():
    for name, sql in migrate.load_migrations():
        assert sql.lstrip().startswith("--"), f"{name} must open with a comment block"


# Owner-only bookkeeping tables, reached solely through SECURITY DEFINER
# functions that run as the owner: RLS is ENABLEd (so every other role is
# bound by policy) but not FORCEd, so the owner needs no BYPASSRLS. Each
# migration's header explains why. Everything else must ENABLE and FORCE.
ENABLE_ONLY = {"search_outbox"}


def test_every_table_enables_and_forces_rls():
    sql = "\n".join(s for _, s in migrate.load_migrations())
    tables = re.findall(r"CREATE TABLE (\w+)", sql)
    assert tables
    assert ENABLE_ONLY <= set(tables)
    for table in tables:
        assert f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY" in sql, table
        forced = f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY" in sql
        assert forced is (table not in ENABLE_ONLY), table


def test_dry_run_cli_exits_clean():
    result = subprocess.run(
        [sys.executable, "scripts/migrate.py", "--dry-run"],
        cwd=SERVICE_DIR,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    assert "parse clean" in result.stdout
