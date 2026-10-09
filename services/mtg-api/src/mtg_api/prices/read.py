"""Read side of the price API. Every query here filters to PUBLIC_LANES: the
`licensed` lane is for the POS through an internal function, `qa-only` is
never served (vault: "Price Data Licensing Lanes")."""

from datetime import UTC, date, datetime, timedelta
from typing import Any

import psycopg

from mtg_api.prices.snapshot import FRESH_DAYS
from mtg_api.prices.sources import VALUE_COLS

PUBLIC_LANES = ("own", "open")
GAMES = ("mtg",)
SNAPSHOT_HOUR_UTC = 21
CHANGE_SOURCE = "mtgjson_tcgplayer"

# Public field name -> column.
SERIES = {c.removesuffix("_cents"): c for c in VALUE_COLS if c.endswith("_cents")}
COUNT_COLS = tuple(c for c in VALUE_COLS if not c.endswith("_cents"))


def next_snapshot_at(now: datetime | None = None) -> datetime:
    now = now or datetime.now(UTC)
    at = now.replace(hour=SNAPSHOT_HOUR_UTC, minute=0, second=0, microsecond=0)
    return at if at > now else at + timedelta(days=1)


def latest_snapshot(conn: psycopg.Connection, game: str) -> dict[str, Any] | None:
    return conn.execute(
        # By day, not by seq: a back-dated correction run is newer by seq but
        # is not the latest day.
        "SELECT seq, snapshot_id, as_of FROM price_snapshots WHERE game = %s "
        "ORDER BY as_of DESC, revision DESC LIMIT 1",
        (game,),
    ).fetchone()


def snapshot_by_id(conn: psycopg.Connection, game: str, snapshot_id: str) -> dict | None:
    return conn.execute(
        "SELECT * FROM price_snapshots WHERE game = %s AND snapshot_id = %s",
        (game, snapshot_id),
    ).fetchone()


def list_snapshots(conn: psycopg.Connection, game: str, limit: int) -> list[dict[str, Any]]:
    return conn.execute(
        "SELECT * FROM price_snapshots WHERE game = %s ORDER BY seq DESC LIMIT %s",
        (game, limit),
    ).fetchall()


def source_status(conn: psycopg.Connection, now: datetime | None = None) -> list[dict]:
    """Public sources with their feed's last successful run and staleness.
    Lag and staleness are measured from when the feed *published* the data
    we last loaded (ingest_runs.bulk_updated_at), not from when our job ran:
    a job that keeps succeeding on an upstream that stopped publishing is
    still stale."""
    now = now or datetime.now(UTC)
    rows = conn.execute(
        "SELECT ps.code AS source, ps.name, ps.lane, ps.series, ps.currency, ps.feed, "
        "ps.stale_after_hours, r.last_success_at, r.published_at "
        "FROM price_sources ps LEFT JOIN LATERAL ("
        "  SELECT max(finished_at) AS last_success_at, max(bulk_updated_at) AS published_at "
        "  FROM ingest_runs WHERE source = 'prices:' || ps.feed AND status = 'ok'"
        ") r ON true WHERE ps.lane = ANY(%s) ORDER BY ps.id",
        (list(PUBLIC_LANES),),
    ).fetchall()
    for row in rows:
        published = row["published_at"]
        row["lag_hours"] = round((now - published).total_seconds() / 3600, 2) if published else None
        row["stale"] = published is None or now - published > timedelta(
            hours=row["stale_after_hours"]
        )
    return rows


def public_source_codes(conn: psycopg.Connection) -> set[str]:
    rows = conn.execute(
        "SELECT code FROM price_sources WHERE lane = ANY(%s)", (list(PUBLIC_LANES),)
    ).fetchall()
    return {r["code"] for r in rows}


def public_manifest(conn: psycopg.Connection, snap: dict[str, Any]) -> dict[str, Any]:
    """A manifest with licensed / qa-only source codes and volumes removed."""
    public = public_source_codes(conn)
    counts = {
        k: v for k, v in (snap["row_counts"] or {}).items() if k.startswith("_") or k in public
    }
    return {**snap, "row_counts": counts}


def skus_for_lookup(conn: psycopg.Connection, game: str, item: dict[str, Any]) -> list[int]:
    """SKU ids for one batch item: a sku_id, or a printing found by an
    external id (tcgplayer_id, scryfall_id, set + number), optionally
    narrowed to one finish."""
    finish = item.get("finish")
    if item.get("sku_id") is not None:
        where, params = "k.id = %s", [item["sku_id"]]
    elif item.get("tcgplayer_id") is not None:
        # The etched product id names the etched SKU only.
        where = (
            "(p.tcgplayer_id = %s AND k.finish <> 'etched') "
            "OR (p.tcgplayer_etched_id = %s AND k.finish = 'etched')"
        )
        params = [item["tcgplayer_id"], item["tcgplayer_id"]]
    elif item.get("scryfall_id") is not None:
        where, params = "k.printing_id = %s", [item["scryfall_id"]]
    elif item.get("set") and item.get("number"):
        where = "p.set_code = lower(%s) AND p.collector_number = %s"
        params = [item["set"], item["number"]]
    else:
        return []
    sql = (
        "SELECT k.id FROM skus k LEFT JOIN printings p ON p.id = k.printing_id "
        f"WHERE k.game = %s AND ({where})"
    )
    if finish:
        sql += " AND k.finish = %s"
        params.append(finish)
    return [r["id"] for r in conn.execute(sql + " ORDER BY k.id", [game, *params]).fetchall()]


def skus_in_set(conn: psycopg.Connection, game: str, set_code: str) -> list[int]:
    rows = conn.execute(
        "SELECT k.id FROM skus k JOIN printings p ON p.id = k.printing_id "
        "WHERE k.game = %s AND p.set_code = lower(%s) ORDER BY k.id",
        (game, set_code),
    ).fetchall()
    return [r["id"] for r in rows]


def price_objects(
    conn: psycopg.Connection,
    game: str,
    sku_ids: list[int],
    snapshot: dict[str, Any],
    status: list[dict] | None = None,
) -> list[dict[str, Any]]:
    """Public price objects for these SKUs, in sku_ids order. A SKU with no
    public price still gets an object, with an empty `open` and no change.
    Pass `status` (source_status()) when building many in one request."""
    if not sku_ids:
        return []
    skus = conn.execute(
        "SELECT id, printing_id, finish, condition, lang FROM skus "
        "WHERE game = %s AND id = ANY(%s)",
        (game, sku_ids),
    ).fetchall()
    cols = ", ".join(f"c.{c}" for c in VALUE_COLS)
    prices = conn.execute(
        f"SELECT c.sku_id, ps.code, ps.lane, ps.series, ps.currency, ps.attribution, ps.feed, "
        f"c.as_of, c.method, c.observed_at, c.flags, {cols}, "
        "c.change_1d, c.change_7d, c.change_30d "
        "FROM price_current c JOIN price_sources ps ON ps.id = c.source_id "
        "WHERE c.sku_id = ANY(%s) AND ps.lane = ANY(%s) ORDER BY c.sku_id, ps.id",
        (sku_ids, list(PUBLIC_LANES)),
    ).fetchall()
    status = status if status is not None else source_status(conn)
    stale_by_feed = {s["feed"]: s["stale"] for s in status}
    # A row its feed has stopped refreshing is stale even if the feed isn't.
    fresh_since = snapshot["as_of"] - timedelta(days=FRESH_DAYS)
    by_sku: dict[int, list[dict]] = {}
    for row in prices:
        by_sku.setdefault(row["sku_id"], []).append(row)

    objects = {}
    for sku in skus:
        rows = by_sku.get(sku["id"], [])
        open_values: dict[str, int] = {}
        provenance = []
        attribution: list[str] = []
        change = {"1d": None, "7d": None, "30d": None}
        for row in rows:
            suffix = row["currency"].lower()
            for name, col in SERIES.items():
                if row[col] is not None:
                    open_values[f"{row['code']}_{name}_{suffix}"] = row[col]
            for col in COUNT_COLS:
                if row[col] is not None:
                    open_values[f"{row['code']}_{col}"] = row[col]
            stale = stale_by_feed.get(row["feed"], True) or row["as_of"] < fresh_since
            provenance.append(
                {
                    "source": row["code"],
                    "lane": row["lane"],
                    "series": row["series"],
                    "currency": row["currency"],
                    "method": row["method"],
                    "as_of": row["as_of"],
                    "observed_at": row["observed_at"],
                    "stale": stale,
                    "flags": row["flags"],
                }
            )
            if row["attribution"] not in attribution:
                attribution.append(row["attribution"])
            if row["code"] == CHANGE_SOURCE:
                change = {
                    k: (float(row[f"change_{k}"]) if row[f"change_{k}"] is not None else None)
                    for k in ("1d", "7d", "30d")
                }
        objects[sku["id"]] = {
            "game": game,
            "sku_id": sku["id"],
            "printing_id": sku["printing_id"],
            "finish": sku["finish"],
            "condition": sku["condition"],
            "lang": sku["lang"],
            "snapshot_id": snapshot["snapshot_id"],
            "as_of": snapshot["as_of"],
            "own": None,
            "open": open_values,
            "change": change,
            "change_source": CHANGE_SOURCE,
            "stale": any(p["stale"] for p in provenance),
            "attribution": attribution,
            "provenance": provenance,
        }
    return [objects[i] for i in sku_ids if i in objects]


def history(
    conn: psycopg.Connection,
    sku_id: int,
    snapshot_seq: int,
    from_date: date,
    to_date: date,
    series: list[str],
) -> list[dict[str, Any]]:
    """Daily points per public source, exactly as snapshot `snapshot_seq`
    saw them: for each (day, source) the newest row written at or before it."""
    cols = ", ".join(f"d.{SERIES[s]}" for s in series)
    rows = conn.execute(
        "SELECT DISTINCT ON (d.source_id, d.as_of) ps.code, ps.currency, d.as_of, "
        f"{cols} FROM price_daily d JOIN price_sources ps ON ps.id = d.source_id "
        "WHERE d.sku_id = %s AND d.snapshot_seq <= %s AND d.as_of BETWEEN %s AND %s "
        "AND ps.lane = ANY(%s) "
        "ORDER BY d.source_id, d.as_of, d.snapshot_seq DESC",
        (sku_id, snapshot_seq, from_date, to_date, list(PUBLIC_LANES)),
    ).fetchall()
    out: dict[str, dict[str, Any]] = {}
    for row in rows:
        entry = out.setdefault(
            row["code"], {"source": row["code"], "currency": row["currency"], "points": []}
        )
        entry["points"].append(
            {"as_of": row["as_of"], "values": {s: row[SERIES[s]] for s in series}}
        )
    return list(out.values())


def movers(
    conn: psycopg.Connection,
    snapshot_seq: int,
    window_days: int,
    direction: str,
    min_price: int,
    min_change: float,
    limit: int,
) -> list[dict[str, Any]]:
    return conn.execute(
        "SELECT m.rank, m.sku_id, k.printing_id, k.finish, c.name, p.set_code, "
        "p.collector_number, m.price_cents, m.change::float AS change "
        "FROM price_movers m JOIN skus k ON k.id = m.sku_id "
        "JOIN price_sources ps ON ps.id = m.source_id "
        "LEFT JOIN printings p ON p.id = k.printing_id "
        "LEFT JOIN cards c ON c.oracle_id = p.oracle_id "
        "WHERE m.snapshot_seq = %s AND m.window_days = %s AND m.direction = %s "
        "AND m.price_cents >= %s AND abs(m.change) >= %s AND ps.lane = ANY(%s) "
        "ORDER BY m.rank LIMIT %s",
        (
            snapshot_seq,
            window_days,
            direction,
            min_price,
            min_change,
            list(PUBLIC_LANES),
            limit,
        ),
    ).fetchall()
