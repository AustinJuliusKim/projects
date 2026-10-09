"""Freeze staged observations into one immutable snapshot.

Flow, all inside the caller's transaction:
  open_staging()  temp table for this run
  stage()         COPY each source's Obs rows in (sources may fail independently)
  take()          SKUs, revisioned snapshot row, price_daily rows that changed,
                  price_current, change windows, movers, manifest

price_daily only gains a row where a value differs from the latest row an
earlier revision wrote for the same (sku, day, source), so re-running a day
yields YYYY-MM-DD.2 while everything .1 returned stays exactly as it was."""

from collections.abc import Iterable
from datetime import date
from decimal import Decimal
from typing import Any

import psycopg
from psycopg.types.json import Json

from mtg_api.prices.sources import VALUE_COLS, Obs

# Movers rank this USD source's headline price until the own index (phase E)
# provides market_smooth.
MOVERS_SOURCE = "mtgjson_tcgplayer"
MOVERS_MIN_CENTS = 100
MOVERS_MIN_CHANGE = Decimal("0.02")
MOVERS_TOP_N = 50
WINDOWS = (1, 7, 30)
# A window looks back up to this many extra days for the comparison point,
# so a source that skipped a day still gets a change figure.
WINDOW_SLACK_DAYS = 3

STAGING_COLS = (
    "printing_id",
    "finish",
    "source",
    "as_of",
    *VALUE_COLS,
    "method",
    "observed_at",
    "mtgjson_uuid",
)

# The single number a row is ranked and compared on.
HEADLINE = "coalesce(market_smooth_cents, market_cents, retail_cents, trend_cents, low_cents)"

_COLS = ", ".join(VALUE_COLS)


def open_staging(conn: psycopg.Connection) -> None:
    value_defs = ", ".join(f"{c} integer" for c in VALUE_COLS)
    conn.execute(
        "CREATE TEMP TABLE IF NOT EXISTS price_staging ("
        f"printing_id uuid, finish text, source text, as_of date, {value_defs}, "
        "method text, observed_at timestamptz, mtgjson_uuid uuid)"
    )
    conn.execute("TRUNCATE price_staging")


def stage(conn: psycopg.Connection, observations: Iterable[Obs]) -> int:
    n = 0
    with conn.cursor().copy(f"COPY price_staging ({', '.join(STAGING_COLS)}) FROM STDIN") as cp:
        for obs in observations:
            cp.write_row([getattr(obs, c) for c in STAGING_COLS])
            n += 1
    return n


def next_revision(conn: psycopg.Connection, game: str, as_of: date) -> int:
    (rev,) = conn.execute(
        "SELECT coalesce(max(revision), 0) + 1 FROM price_snapshots WHERE game = %s AND as_of = %s",
        (game, as_of),
    ).fetchone()
    return rev


def take(
    conn: psycopg.Connection,
    *,
    as_of: date,
    sources_ok: list[str],
    sources_failed: list[str],
    fx: tuple[Decimal, date] | None = None,
    changelog: str | None = None,
    game: str = "mtg",
) -> dict[str, Any]:
    """Write the snapshot. Commits nothing; the caller owns the transaction."""
    # One snapshot writer per game at a time; revisions must not race.
    conn.execute("SELECT pg_advisory_xact_lock(hashtext('price_snapshot:' || %s))", (game,))
    revision = next_revision(conn, game, as_of)
    snapshot_id = f"{as_of.isoformat()}.{revision}"
    (seq,) = conn.execute(
        "INSERT INTO price_snapshots (game, snapshot_id, as_of, revision, sources_ok, "
        "sources_failed, fx_eur_usd, fx_as_of, changelog) "
        "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING seq",
        (
            game,
            snapshot_id,
            as_of,
            revision,
            sources_ok,
            sources_failed,
            fx[0] if fx else None,
            fx[1] if fx else None,
            changelog,
        ),
    ).fetchone()

    (unmatched,) = conn.execute(
        "SELECT count(*) FROM price_staging s "
        "WHERE NOT EXISTS (SELECT 1 FROM printings p WHERE p.id = s.printing_id)"
    ).fetchone()

    skus_created = conn.execute(
        "INSERT INTO skus (game, printing_id, finish, condition, lang, mtgjson_uuid) "
        "SELECT DISTINCT ON (s.printing_id, s.finish) %s, s.printing_id, s.finish, 'NM', "
        "coalesce(p.lang, 'en'), s.mtgjson_uuid "
        "FROM price_staging s JOIN printings p ON p.id = s.printing_id "
        "ORDER BY s.printing_id, s.finish, s.mtgjson_uuid NULLS LAST "
        "ON CONFLICT (game, printing_id, finish, condition, lang) DO UPDATE "
        "SET mtgjson_uuid = excluded.mtgjson_uuid "
        "WHERE skus.mtgjson_uuid IS NULL AND excluded.mtgjson_uuid IS NOT NULL "
        "RETURNING (xmax = 0) AS inserted",
        (game,),
    ).fetchall()

    # Merge partial rows (e.g. retail and buylist lines) into one per key.
    conn.execute("DROP TABLE IF EXISTS price_resolved")
    merged = ", ".join(f"max(s.{c}) AS {c}" for c in VALUE_COLS)
    conn.execute(
        "CREATE TEMP TABLE price_resolved ON COMMIT DROP AS "
        f"SELECT k.id AS sku_id, s.as_of, ps.id AS source_id, {merged}, "
        "max(s.method) AS method, max(s.observed_at) AS observed_at "
        "FROM price_staging s "
        "JOIN price_sources ps ON ps.code = s.source "
        "JOIN printings p ON p.id = s.printing_id "
        "JOIN skus k ON k.game = %s AND k.printing_id = s.printing_id "
        "AND k.finish = s.finish AND k.condition = 'NM' AND k.lang = coalesce(p.lang, 'en') "
        "GROUP BY k.id, s.as_of, ps.id",
        (game,),
    )
    conn.execute(
        "SELECT ensure_price_partitions(min(as_of), max(as_of)) FROM price_resolved "
        "HAVING count(*) > 0"
    )

    r_cols = ", ".join(f"r.{c}" for c in VALUE_COLS)
    prev_cols = ", ".join(f"d.{c}" for c in VALUE_COLS)
    cmp_prev = ", ".join(f"prev.{c}" for c in VALUE_COLS)
    w_cols = ", ".join(f"w.{c}" for c in VALUE_COLS)
    upd = ", ".join(f"{c} = excluded.{c}" for c in (*VALUE_COLS, "method", "observed_at"))
    written = conn.execute(
        "WITH written AS ("
        f"  INSERT INTO price_daily (sku_id, as_of, source_id, snapshot_seq, {_COLS}, "
        "    method, observed_at) "
        f"  SELECT r.sku_id, r.as_of, r.source_id, %(seq)s, {r_cols}, r.method, r.observed_at "
        "  FROM price_resolved r "
        "  LEFT JOIN LATERAL ("
        f"    SELECT d.snapshot_seq AS prev_seq, {prev_cols} FROM price_daily d "
        "    WHERE d.sku_id = r.sku_id AND d.as_of = r.as_of AND d.source_id = r.source_id "
        "    ORDER BY d.snapshot_seq DESC LIMIT 1"
        "  ) prev ON true "
        f"  WHERE prev.prev_seq IS NULL OR ({cmp_prev}) IS DISTINCT FROM ({r_cols}) "
        "  RETURNING *"
        "), current_rows AS ("
        f"  INSERT INTO price_current (sku_id, source_id, snapshot_seq, as_of, {_COLS}, "
        "    method, observed_at) "
        "  SELECT DISTINCT ON (w.sku_id, w.source_id) w.sku_id, w.source_id, w.snapshot_seq, "
        f"    w.as_of, {w_cols}, w.method, w.observed_at "
        "  FROM written w ORDER BY w.sku_id, w.source_id, w.as_of DESC "
        "  ON CONFLICT (sku_id, source_id) DO UPDATE SET "
        f"    snapshot_seq = excluded.snapshot_seq, as_of = excluded.as_of, {upd} "
        "  WHERE excluded.as_of >= price_current.as_of"
        ") "
        "SELECT ps.code, count(*) FROM written w JOIN price_sources ps ON ps.id = w.source_id "
        "GROUP BY ps.code",
        {"seq": seq},
    ).fetchall()
    row_counts = {code: n for code, n in written}

    _update_changes(conn, seq)
    movers = _compute_movers(conn, seq)

    counts = {
        **row_counts,
        "_skus_created": sum(1 for (ins,) in skus_created if ins),
        "_unmatched_staged": unmatched,
        "_movers": movers,
    }
    conn.execute("UPDATE price_snapshots SET row_counts = %s WHERE seq = %s", (Json(counts), seq))
    return {"snapshot_id": snapshot_id, "seq": seq, "revision": revision, "row_counts": counts}


def _update_changes(conn: psycopg.Connection, seq: int) -> None:
    """Change windows for the current rows this snapshot wrote, against the
    newest revision of the closest earlier day within the window slack."""
    lookbacks = []
    sets = []
    for n in WINDOWS:
        lookbacks.append(
            f"LEFT JOIN LATERAL (SELECT {HEADLINE} AS v FROM price_daily d "
            "WHERE d.sku_id = c.sku_id AND d.source_id = c.source_id "
            f"AND d.as_of <= c.as_of - {n} AND d.as_of >= c.as_of - {n + WINDOW_SLACK_DAYS} "
            f"ORDER BY d.as_of DESC, d.snapshot_seq DESC LIMIT 1) p{n} ON true"
        )
        sets.append(
            f"change_{n}d = CASE WHEN ch.p{n} > 0 AND ch.cur IS NOT NULL "
            f"THEN round((ch.cur - ch.p{n})::numeric / ch.p{n}, 4) END"
        )
    picks = ", ".join(f"p{n}.v AS p{n}" for n in WINDOWS)
    conn.execute(
        f"UPDATE price_current pc SET {', '.join(sets)} FROM ("
        f"  SELECT c.sku_id, c.source_id, {HEADLINE} AS cur, {picks} "
        f"  FROM price_current c {' '.join(lookbacks)} "
        "  WHERE c.snapshot_seq = %s"
        ") ch WHERE pc.sku_id = ch.sku_id AND pc.source_id = ch.source_id",
        (seq,),
    )


def _compute_movers(conn: psycopg.Connection, seq: int) -> int:
    total = 0
    for n in WINDOWS:
        for direction, order in (("up", "DESC"), ("down", "ASC")):
            cmp = ">=" if direction == "up" else "<="
            threshold = MOVERS_MIN_CHANGE if direction == "up" else -MOVERS_MIN_CHANGE
            cur = conn.execute(
                "INSERT INTO price_movers (snapshot_seq, window_days, direction, rank, sku_id, "
                "source_id, price_cents, change) "
                f"SELECT %s, %s, %s, row_number() OVER (ORDER BY c.change_{n}d {order}, "
                f"c.sku_id), c.sku_id, c.source_id, {HEADLINE}, c.change_{n}d "
                "FROM price_current c JOIN price_sources ps ON ps.id = c.source_id "
                f"WHERE ps.code = %s AND c.change_{n}d {cmp} %s AND {HEADLINE} >= %s "
                f"ORDER BY c.change_{n}d {order}, c.sku_id LIMIT %s",
                (seq, n, direction, MOVERS_SOURCE, threshold, MOVERS_MIN_CENTS, MOVERS_TOP_N),
            )
            total += cur.rowcount
    return total
