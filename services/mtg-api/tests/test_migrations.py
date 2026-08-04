"""Migration lint, no database needed — mirrors what CI's --dry-run enforces."""

import importlib.util
import re
import subprocess
import sys
from pathlib import Path

SERVICE_DIR = Path(__file__).resolve().parent.parent
MIGRATIONS_DIR = SERVICE_DIR / "migrations"

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


def test_dry_run_cli_exits_clean():
    result = subprocess.run(
        [sys.executable, "scripts/migrate.py", "--dry-run"],
        cwd=SERVICE_DIR,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    assert "parse clean" in result.stdout


def test_dry_run_needs_no_database_url():
    result = subprocess.run(
        [sys.executable, "scripts/migrate.py", "--dry-run"],
        cwd=SERVICE_DIR,
        capture_output=True,
        text=True,
        env={"PATH": "/usr/bin:/bin"},  # explicitly no DATABASE_URL
    )
    assert result.returncode == 0, result.stderr
