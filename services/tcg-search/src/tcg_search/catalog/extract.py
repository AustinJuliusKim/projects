"""The catalog extract: one streaming SQL statement over the mtg catalog DB.

This is the documented exception to the POS's "mtg-api over HTTP only"
rule (OPS.md §2): it runs as the read-only `mtg_search_reader` role and its
contract with mtg-api's schema is pinned by tests/test_extract_contract.py,
which runs EXTRACT_SQL against a database built from mtg-api's migrations.

CONTRACT — tables and columns read (mtg-api migrations 0002, 0010, 0011):

  cards        oracle_id, name, mana_cost, mana_value, type_line, oracle_text,
               colors, color_identity, keywords, power, toughness, loyalty,
               defense, produced_mana, layout, legalities, card_faces,
               reserved, edhrec_rank, is_removed
  printings    id, oracle_id, set_code, collector_number, rarity, lang,
               released_at, artist, finishes, promo, digital, image_small,
               image_normal
  sets         code, name, set_type
  skus         id, game, printing_id, finish, condition
  price_current sku_id, source_id, retail_cents, trend_cents
  price_sources id, code, lane, currency

Each output row is one non-removed card (the `cards` columns above minus
is_removed) plus `printings`: a JSON array of every printing (paper and
digital, newest first) with set name/type and NM prices per finish:

  price_{nonfoil,foil,etched}_cents   integer cents or null (never 0)
  price_{nonfoil,foil,etched}_source  price_sources.code of that value

PRICES: only `own`/`open` lane USD sources are read, so a `licensed` or
`qa-only` value can never reach the public index. Per (printing, finish) the
value comes from mtgjson_tcgplayer (retail, i.e. TCGplayer market) when
present, else scryfall_usd (Scryfall's trend). Condition is NM; the price
SKUs are keyed by printing, and a printing's language is the printing's own.
"""

from collections.abc import Iterator
from typing import Any

import psycopg
from psycopg.rows import dict_row

# Source -> the price_current column that carries its headline value, in
# preference order.
PRICE_SOURCES = (("mtgjson_tcgplayer", "retail_cents"), ("scryfall_usd", "trend_cents"))
PUBLIC_LANES = ("own", "open")

_VALUE = " ".join(f"WHEN '{code}' THEN pc.{col}" for code, col in PRICE_SOURCES)
_PREF = " ".join(f"WHEN '{code}' THEN {i}" for i, (code, _) in enumerate(PRICE_SOURCES))
_CODES = ", ".join(f"'{code}'" for code, _ in PRICE_SOURCES)
_LANES = ", ".join(f"'{lane}'" for lane in PUBLIC_LANES)

EXTRACT_SQL = f"""
WITH price AS MATERIALIZED (
  SELECT DISTINCT ON (k.printing_id, k.finish)
    k.printing_id, k.finish,
    CASE ps.code {_VALUE} END AS cents,
    ps.code AS source
  FROM skus k
  JOIN price_current pc ON pc.sku_id = k.id
  JOIN price_sources ps ON ps.id = pc.source_id
  WHERE k.game = 'mtg'
    AND k.condition = 'NM'
    AND ps.lane IN ({_LANES})
    AND ps.currency = 'USD'
    AND ps.code IN ({_CODES})
    AND (CASE ps.code {_VALUE} END) > 0
  ORDER BY k.printing_id, k.finish, CASE ps.code {_PREF} END
),
prints AS (
  SELECT p.oracle_id,
    json_agg(json_build_object(
      'id', p.id,
      'set_code', p.set_code,
      'set_name', s.name,
      'set_type', s.set_type,
      'collector_number', p.collector_number,
      'rarity', p.rarity,
      'lang', p.lang,
      'released_at', p.released_at,
      'artist', p.artist,
      'finishes', p.finishes,
      'promo', p.promo,
      'digital', p.digital,
      'image_small', p.image_small,
      'image_normal', p.image_normal,
      'price_nonfoil_cents', pn.cents, 'price_nonfoil_source', pn.source,
      'price_foil_cents', pf.cents, 'price_foil_source', pf.source,
      'price_etched_cents', pe.cents, 'price_etched_source', pe.source
    ) ORDER BY p.released_at DESC NULLS LAST, p.set_code, p.collector_number) AS printings
  FROM printings p
  JOIN sets s ON s.code = p.set_code
  LEFT JOIN price pn ON pn.printing_id = p.id AND pn.finish = 'nonfoil'
  LEFT JOIN price pf ON pf.printing_id = p.id AND pf.finish = 'foil'
  LEFT JOIN price pe ON pe.printing_id = p.id AND pe.finish = 'etched'
  GROUP BY p.oracle_id
)
SELECT c.oracle_id, c.name, c.mana_cost, c.mana_value, c.type_line, c.oracle_text,
  c.colors, c.color_identity, c.keywords, c.power, c.toughness, c.loyalty, c.defense,
  c.produced_mana, c.layout, c.legalities, c.card_faces, c.reserved, c.edhrec_rank,
  coalesce(pr.printings, '[]'::json) AS printings
FROM cards c
LEFT JOIN prints pr ON pr.oracle_id = c.oracle_id
WHERE NOT c.is_removed
ORDER BY c.oracle_id
"""

SNAPSHOT_SQL = (
    "SELECT snapshot_id, as_of FROM price_snapshots WHERE game = 'mtg' "
    "ORDER BY as_of DESC, revision DESC LIMIT 1"
)


def connect(url: str) -> psycopg.Connection:
    # prepare_threshold=None: safe behind a transaction pooler (Supabase).
    return psycopg.connect(url, row_factory=dict_row, prepare_threshold=None)


def iter_cards(conn: psycopg.Connection, *, itersize: int = 2000) -> Iterator[dict[str, Any]]:
    """Stream extract rows through a server-side cursor (one transaction,
    so the whole extract sees one consistent snapshot of the DB)."""
    with conn.transaction():
        with conn.cursor(name="tcg_search_catalog_extract", row_factory=dict_row) as cur:
            cur.itersize = itersize
            cur.execute(EXTRACT_SQL)
            yield from cur


def latest_snapshot(conn: psycopg.Connection) -> dict[str, Any] | None:
    """Newest price snapshot id, for the index's _meta. None if the DB has
    none, or the role can't read price_snapshots (it isn't in the contract)."""
    try:
        with conn.transaction():
            row = conn.execute(SNAPSHOT_SQL).fetchone()
    except psycopg.errors.InsufficientPrivilege:
        return None
    return dict(row) if row else None
