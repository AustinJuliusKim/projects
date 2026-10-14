"""Index bodies for the two indices. Both share analysis settings and the
card-level field mappings (CARD_FIELDS), so one query builder serves both;
they differ only in the nested per-copy object — `printings` on the catalog,
`offers` on listings — whose shared sub-fields (set, rarity, finish,
price_cents, ...) have the same names, so a filter like `s:lea` is the same
clause with a different nested path.

  catalog   one doc per oracle card, _id = oracle_id, nested printings
  listings  one doc per store x card, _id = "<tenant_id>:<oracle_id>",
            routed by tenant_id (routing required), nested offers
"""

import copy
from typing import Any

from tcg_search.analysis import analysis_settings

NAME_TEXT = {
    "type": "text",
    "analyzer": "name_index",
    "search_analyzer": "name_search",
    "fields": {
        "plain": {"type": "text", "analyzer": "name_plain"},
        "sayt": {"type": "search_as_you_type", "analyzer": "name_plain", "max_shingle_size": 3},
    },
}

KW = {"type": "keyword"}
KW_LOWER = {"type": "keyword", "normalizer": "lower"}
UNINDEXED = {"type": "keyword", "index": False, "doc_values": False}

# Card-level fields, identical in both indices (docs.card_fields fills them).
CARD_FIELDS: dict[str, Any] = {
    "oracle_id": KW,
    "name": {
        **NAME_TEXT,
        "fields": {**NAME_TEXT["fields"], "sort": {"type": "keyword", "normalizer": "lower"}},
    },
    # Full name + every face name, compacted: "fireice", "fire", "ice".
    "names_exact": {"type": "keyword", "normalizer": "compact"},
    "face_names": NAME_TEXT,
    "nicknames": {"type": "keyword", "normalizer": "compact"},
    # Legendary short names ("Kenrith" for "Kenrith, the Returned King"), compacted.
    "short_names": {"type": "keyword", "normalizer": "compact"},
    "mana_cost": {"type": "keyword", "index": False},
    "mana_value": {"type": "float"},
    "colors": KW,
    "color_count": {"type": "byte"},
    "color_identity": KW,
    "identity_count": {"type": "byte"},
    "type_line": {"type": "text", "analyzer": "plain"},
    "supertypes": KW_LOWER,
    "types": KW_LOWER,
    "subtypes": KW_LOWER,
    "oracle_text": {
        "type": "text",
        "analyzer": "rules",
        "search_analyzer": "rules_search",
        "fields": {"plain": {"type": "text", "analyzer": "rules_plain"}},
    },
    # Display copies: rules text as printed (oracle_text above has the card's own
    # name replaced by "cardname") and per-face data for multi-face cards.
    "oracle_text_display": {"type": "text", "index": False},
    "faces": {"type": "object", "enabled": False},
    "keywords": KW_LOWER,
    "power": KW,
    "toughness": KW,
    "loyalty": KW,
    "defense": KW,
    "power_num": {"type": "float"},
    "toughness_num": {"type": "float"},
    "loyalty_num": {"type": "float"},
    "produced_mana": KW,
    "layout": KW,
    "is_dfc": {"type": "boolean"},
    "reserved": {"type": "boolean"},
    "digital_only": {"type": "boolean"},
    "legal": KW,
    "banned": KW,
    "restricted": KW,
    "edhrec_rank": {"type": "integer"},
    "popularity": {"type": "rank_feature"},
    "released_at": {"type": "date"},
    "latest_released_at": {"type": "date"},
    "image_small": UNINDEXED,
    "image_normal": UNINDEXED,
}

# Per-copy fields shared by catalog.printings and listings.offers.
COPY_FIELDS: dict[str, Any] = {
    "printing_id": KW,
    "set": KW_LOWER,
    "set_name": {"type": "text", "analyzer": "plain", "fields": {"raw": KW}},
    "set_type": KW,
    "collector_number": KW,
    "rarity": KW,
    "released_at": {"type": "date"},
    "artist": {"type": "text", "analyzer": "plain", "fields": {"raw": KW}},
    "lang": KW,
    "price_cents": {"type": "integer"},
    "image_small": UNINDEXED,
    "image_normal": UNINDEXED,
}

PRINTING_FIELDS: dict[str, Any] = {
    **COPY_FIELDS,
    "finishes": KW,
    "promo": {"type": "boolean"},
    "price_foil_cents": {"type": "integer"},
    "price_etched_cents": {"type": "integer"},
    "price_source": KW,
}

OFFER_FIELDS: dict[str, Any] = {
    **COPY_FIELDS,
    "finish": KW,
    "condition": KW,
    # NM=5 LP=4 MP=3 HP=2 DMG=1, so cond>=lp is a range query.
    "condition_rank": {"type": "byte"},
    "available": {"type": "integer"},
}

CATALOG_EXTRA: dict[str, Any] = {
    # Headline price: min NM nonfoil across printings (docs.headline_price).
    "price_cents": {"type": "integer"},
    "price_source": KW,
    "printing_count": {"type": "short"},
    "printings": {"type": "nested", "properties": PRINTING_FIELDS},
}

LISTINGS_EXTRA: dict[str, Any] = {
    "tenant_id": KW,
    # Cheapest available offer and total available copies.
    "price_cents": {"type": "integer"},
    "in_stock": {"type": "integer"},
    "stock_depth": {"type": "rank_feature"},
    "updated_at": {"type": "date"},
    "offers": {"type": "nested", "properties": OFFER_FIELDS},
}

NESTED_PATH = {"catalog": "printings", "listings": "offers"}


def _settings(refresh_interval: str) -> dict[str, Any]:
    return {
        "index": {
            "number_of_shards": 1,
            "number_of_replicas": 0,
            "refresh_interval": refresh_interval,
            "max_result_window": 10000,
        },
        "analysis": analysis_settings(),
    }


def catalog_index_body(
    meta: dict[str, Any] | None = None, *, refresh_interval: str = "1s"
) -> dict[str, Any]:
    return {
        "settings": _settings(refresh_interval),
        "mappings": {
            "dynamic": "strict",
            "_meta": meta or {},
            "properties": copy.deepcopy({**CARD_FIELDS, **CATALOG_EXTRA}),
        },
    }


def listings_index_body(meta: dict[str, Any] | None = None) -> dict[str, Any]:
    """The listings index (created and filled by tcg-pos-api's indexer).
    Every doc must be written with routing=tenant_id; the mapping rejects
    writes without it."""
    return {
        "settings": _settings("1s"),
        "mappings": {
            "dynamic": "strict",
            "_meta": meta or {},
            "_routing": {"required": True},
            "properties": copy.deepcopy({**CARD_FIELDS, **LISTINGS_EXTRA}),
        },
    }
