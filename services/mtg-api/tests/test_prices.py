"""Price sources (pure) and snapshot immutability (DB-backed, skipped without
TEST_DATABASE_URL). Mirrors the design's §9 checks: re-running a day makes
revision .2 and leaves what .1 returned untouched; history rows can't be
edited; a failing feed doesn't stop the others publishing."""

import os
import subprocess
import sys
from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path

import pytest

from mtg_api.prices.money import to_cents
from mtg_api.prices.sources import cardmarket_guide, mtgjson
from prices_fixtures import (
    BALLISTA,
    BLOOD,
    BLOOD_UUID,
    BOLT,
    FIXTURE_DAY,
    feeds,
    fx_rate,
    mtgjson_lines,
    read,
    snapshot_day,
)

TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL")
SERVICE_DIR = Path(__file__).resolve().parent.parent
needs_db = pytest.mark.skipif(not TEST_DATABASE_URL, reason="TEST_DATABASE_URL not set")


@pytest.mark.parametrize(
    "raw, cents",
    [
        ("0.29", 29),
        (0.29, 29),
        ("36.68", 3668),
        ("20", 2000),
        ("0.005", 1),
        (None, None),
        ("", None),
        ("abc", None),
        ("-1", None),
        ("NaN", None),
    ],
)
def test_to_cents(raw, cents):
    assert to_cents(raw) == cents


def test_ecb_rate_parses():
    rate, day = fx_rate()
    assert rate == Decimal("1.0921") and day == date(2026, 10, 8)


def test_mtgjson_observations_keep_paper_and_count_skips():
    uuid_map = mtgjson.parse_identifiers(read("mtgjson_cardIdentifiers.csv").splitlines())
    assert "00000000-0000-5000-8000-000000000004" not in uuid_map  # no scryfallId
    skipped: dict[str, int] = {}
    obs = list(mtgjson.observations(mtgjson_lines(FIXTURE_DAY), uuid_map, skipped))
    assert skipped == {
        "not_paper": 1,
        "no_scryfall_id": 1,
        "unknown_provider_or_finish": 1,
        "bad_price": 1,
    }
    bolt_ck = [o for o in obs if o.printing_id == BOLT and o.source == "mtgjson_cardkingdom"]
    assert {(o.retail_cents, o.buylist_cents) for o in bolt_ck} == {(None, 40), (149, None)}
    eur = next(o for o in obs if o.source == "mtgjson_cardmarket")
    assert eur.retail_cents == 65 and eur.finish == "nonfoil"


def test_cardmarket_guide_maps_products_and_finishes():
    import json

    doc = json.loads(read("cardmarket_price_guide.json"))
    obs = list(cardmarket_guide.observations(doc, {892161: [BOLT], 743547: [BLOOD]}))
    by_key = {(o.printing_id, o.finish): o for o in obs}
    assert set(by_key) == {(BOLT, "nonfoil"), (BOLT, "foil"), (BLOOD, "nonfoil")}
    bolt = by_key[(BOLT, "nonfoil")]
    assert (bolt.low_cents, bolt.trend_cents, bolt.market_cents) == (20, 66, 71)
    # createdAt is +02:00; the observation day is the UTC date.
    assert bolt.as_of == date(2026, 10, 9) and bolt.observed_at.utcoffset().total_seconds() == 0


@pytest.fixture(scope="module")
def conn():
    import psycopg

    from mtg_api.ingest.run import ingest_default, ingest_oracle

    with psycopg.connect(TEST_DATABASE_URL) as c:
        c.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public")
        c.commit()
    result = subprocess.run(
        [sys.executable, "scripts/migrate.py"],
        cwd=SERVICE_DIR,
        env={**os.environ, "DATABASE_URL": TEST_DATABASE_URL},
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    import json

    def load(name):
        text = (SERVICE_DIR / "tests" / "fixtures" / name).read_text(encoding="utf-8")
        return [json.loads(line) for line in text.splitlines() if line.strip()]

    with psycopg.connect(TEST_DATABASE_URL) as c:
        ingest_oracle(c, load("oracle_sample.jsonl"))
        ingest_default(c, load("default_sample.jsonl"))
        yield c


def history_as_of(conn, seq):
    """What a reader pinned to snapshot `seq` sees for every key."""
    return conn.execute(
        "SELECT DISTINCT ON (sku_id, as_of, source_id) sku_id, as_of, source_id, "
        "retail_cents, buylist_cents, low_cents, trend_cents, market_cents "
        "FROM price_daily WHERE snapshot_seq <= %s "
        "ORDER BY sku_id, as_of, source_id, snapshot_seq DESC",
        (seq,),
    ).fetchall()


def current(conn, printing_id, finish, source):
    from psycopg.rows import namedtuple_row

    return (
        conn.cursor(row_factory=namedtuple_row)
        .execute(
            "SELECT c.* FROM price_current c JOIN skus k ON k.id = c.sku_id "
            "JOIN price_sources ps ON ps.id = c.source_id "
            "WHERE k.printing_id = %s AND k.finish = %s AND ps.code = %s",
            (printing_id, finish, source),
        )
        .fetchone()
    )


@needs_db
def test_first_snapshot_writes_rows_skus_and_manifest(conn):
    result = snapshot_day(conn, FIXTURE_DAY)
    assert result["snapshot_id"] == "2026-10-08.1"
    counts = result["row_counts"]
    assert counts["mtgjson_tcgplayer"] == 5  # bolt nf+foil, blood, ballista nf+foil
    assert counts["mtgjson_cardkingdom"] == 2
    assert counts["cardmarket_guide"] == 3
    assert counts["_unmatched_staged"] == 1  # scryfall id not in printings
    # Retail and buylist lines merged into one row.
    ck = conn.execute(
        "SELECT retail_cents, buylist_cents FROM price_current c "
        "JOIN skus k ON k.id = c.sku_id JOIN price_sources ps ON ps.id = c.source_id "
        "WHERE k.printing_id = %s AND k.finish = 'nonfoil' AND ps.code = 'mtgjson_cardkingdom'",
        (BOLT,),
    ).fetchone()
    assert ck == (149, 40)
    manifest = conn.execute(
        "SELECT sources_ok, sources_failed, fx_eur_usd FROM price_snapshots WHERE seq = %s",
        (result["seq"],),
    ).fetchone()
    assert manifest == (["mtgjson", "cardmarket_guide", "scryfall"], [], Decimal("1.0921"))
    runs = conn.execute(
        "SELECT source, status, snapshot_id FROM ingest_runs WHERE source LIKE 'prices:%%'"
    ).fetchall()
    assert {r[1] for r in runs} == {"ok"} and {r[2] for r in runs} == {"2026-10-08.1"}
    # Foil and nonfoil are separate SKUs.
    assert current(conn, BALLISTA, "foil", "mtgjson_tcgplayer").retail_cents == 2500


@needs_db
def test_rerun_is_revision_two_and_leaves_revision_one_untouched(conn):
    first = conn.execute(
        "SELECT seq FROM price_snapshots WHERE snapshot_id = '2026-10-08.1'"
    ).fetchone()[0]
    before = history_as_of(conn, first)

    same = snapshot_day(conn, FIXTURE_DAY)
    assert same["snapshot_id"] == "2026-10-08.2"
    assert not [k for k in same["row_counts"] if not k.startswith("_")]  # nothing changed

    corrected = snapshot_day(
        conn, FIXTURE_DAY, scale={BLOOD_UUID: Decimal("1.5")}, changelog="fix Blood"
    )
    assert corrected["snapshot_id"] == "2026-10-08.3"
    # Blood: tcgplayer retail + cardkingdom buylist changed; nothing else.
    assert {k: v for k, v in corrected["row_counts"].items() if not k.startswith("_")} == {
        "mtgjson_tcgplayer": 1,
        "mtgjson_cardkingdom": 1,
    }
    assert history_as_of(conn, first) == before
    assert current(conn, BLOOD, "nonfoil", "mtgjson_tcgplayer").retail_cents == 5502


@needs_db
def test_price_daily_rows_cannot_be_edited(conn):
    import psycopg

    with pytest.raises(psycopg.errors.RaiseException):
        conn.execute("UPDATE price_daily SET retail_cents = 1")
    conn.rollback()
    with pytest.raises(psycopg.errors.RaiseException):
        conn.execute("DELETE FROM price_daily")
    conn.rollback()


@needs_db
def test_next_day_computes_change_and_movers(conn):
    day2 = FIXTURE_DAY + timedelta(days=1)
    result = snapshot_day(conn, day2, scale={BLOOD_UUID: Decimal("1.65")})
    assert result["snapshot_id"] == "2026-10-09.1"
    blood = current(conn, BLOOD, "nonfoil", "mtgjson_tcgplayer")
    # 36.68 * 1.65 = 60.52 vs the corrected day-1 value 55.02.
    assert blood.retail_cents == 6052
    assert blood.change_1d == Decimal("0.1000")
    bolt = current(conn, BOLT, "nonfoil", "mtgjson_tcgplayer")
    assert bolt.change_1d == Decimal("0")
    movers = conn.execute(
        "SELECT window_days, direction, rank, price_cents, change FROM price_movers m "
        "JOIN skus k ON k.id = m.sku_id WHERE m.snapshot_seq = %s",
        (result["seq"],),
    ).fetchall()
    # Only Blood moved >= 2% at >= $1.
    assert [(m[0], m[1], m[2], m[3]) for m in movers] == [(1, "up", 1, 6052)]


@needs_db
def test_failed_feed_is_recorded_and_others_still_publish(conn):
    from mtg_api.prices.run import run_snapshot

    day3 = FIXTURE_DAY + timedelta(days=2)
    result, lines = run_snapshot(conn, feeds(day3, fail="mtgjson"), day3, None)
    manifest = conn.execute(
        "SELECT sources_ok, sources_failed, fx_eur_usd FROM price_snapshots WHERE seq = %s",
        (result["seq"],),
    ).fetchone()
    assert manifest == (["cardmarket_guide", "scryfall"], ["mtgjson"], None)
    assert result["row_counts"]["cardmarket_guide"] == 3
    assert any("**failed**" in line for line in lines)
    status = conn.execute(
        "SELECT status FROM ingest_runs WHERE source = 'prices:mtgjson' AND snapshot_id = %s",
        (result["snapshot_id"],),
    ).fetchone()
    assert status == ("failed",)
