"""Pure document builders for both indices. No I/O.

card_fields(card)         card-level fields shared by catalog and listings
catalog_doc(row)          one catalog doc from an extract row (catalog/extract.py)
listing_doc(card, ...)    one listings doc for a store x card, or None when
                          nothing is sellable (caller deletes the doc)
listing_doc_from_catalog(catalog_src, ...)
                          the same, with the card taken from a catalog doc
listing_id(tenant, oracle_id)

`card` is a mapping with the mtg `cards` columns named in
catalog/extract.py's contract (oracle_id, name, mana_cost, mana_value,
type_line, oracle_text, colors, color_identity, keywords, power, toughness,
loyalty, defense, produced_mana, layout, legalities, card_faces, reserved,
edhrec_rank). Missing keys are treated as null.
"""

from collections.abc import Iterable, Mapping
from datetime import date, datetime
from typing import Any

from tcg_search import cardtext, data
from tcg_search.mappings import CARD_FIELDS

DFC_LAYOUTS = {"transform", "modal_dfc", "meld", "reversible_card", "double_faced_token"}
CONDITION_RANK = {"NM": 5, "LP": 4, "MP": 3, "HP": 2, "DMG": 1}
# Preference when two sources price the same printing equally (extract.py
# already picks one source per printing/finish; this only breaks min() ties).
SOURCE_PREFERENCE = {"mtgjson_tcgplayer": 0, "scryfall_usd": 1}


def _iso(v: Any) -> str | None:
    if v is None:
        return None
    if isinstance(v, datetime | date):
        return v.isoformat()
    return str(v)


def _float(v: Any) -> float | None:
    return float(v) if v is not None else None


def _prune(doc: dict[str, Any]) -> dict[str, Any]:
    """Drop nulls and empty lists: absent means unknown, never 0."""
    return {k: v for k, v in doc.items() if v is not None and v != []}


def card_fields(card: Mapping[str, Any]) -> dict[str, Any]:
    name = card["name"]
    faces = card.get("card_faces") or []
    type_line = card.get("type_line")
    names = cardtext.face_names(name, faces)
    types = cardtext.parse_type_line(type_line)

    colors = card.get("colors")
    if colors is None and faces:
        colors = [c for f in faces for c in (f or {}).get("colors") or []]
    colors = cardtext.sort_colors(colors)
    identity = cardtext.sort_colors(card.get("color_identity"))
    legalities = card.get("legalities") or {}

    nicknames = sorted(
        {nick for n in names for nick in data.nicknames_by_card().get(cardtext.compact(n), [])}
    )

    return _prune(
        {
            "oracle_id": str(card["oracle_id"]),
            "name": name,
            "names_exact": names,
            "face_names": names[1:] if len(names) > 1 else [],
            "nicknames": nicknames,
            "short_names": cardtext.short_names(names, type_line),
            "mana_cost": card.get("mana_cost"),
            "mana_value": _float(card.get("mana_value")),
            "colors": colors,
            "color_count": len(colors),
            "color_identity": identity,
            "identity_count": len(identity),
            "type_line": type_line,
            "supertypes": types["supertypes"],
            "types": types["types"],
            "subtypes": types["subtypes"],
            "oracle_text": cardtext.rules_text(card.get("oracle_text"), faces, names, type_line),
            "oracle_text_display": card.get("oracle_text")
            or "\n//\n".join((f or {}).get("oracle_text") or "" for f in faces)
            or None,
            "faces": [_face(f) for f in faces],
            "keywords": list(card.get("keywords") or []),
            "power": card.get("power"),
            "toughness": card.get("toughness"),
            "loyalty": card.get("loyalty"),
            "defense": card.get("defense"),
            "power_num": cardtext.numeric_stat(card.get("power")),
            "toughness_num": cardtext.numeric_stat(card.get("toughness")),
            "loyalty_num": cardtext.numeric_stat(card.get("loyalty")),
            "produced_mana": list(card.get("produced_mana") or []),
            "layout": card.get("layout"),
            "is_dfc": card.get("layout") in DFC_LAYOUTS,
            "reserved": bool(card.get("reserved")),
            "legal": sorted(f for f, v in legalities.items() if v == "legal"),
            "banned": sorted(f for f, v in legalities.items() if v == "banned"),
            "restricted": sorted(f for f, v in legalities.items() if v == "restricted"),
            "edhrec_rank": card.get("edhrec_rank"),
            "popularity": cardtext.popularity(card.get("edhrec_rank")),
            "image_small": card.get("image_small"),
            "image_normal": card.get("image_normal"),
        }
    )


def _cents(v: Any) -> int | None:
    """Positive integer cents or None: a 0 or negative price is a missing
    price, never a free card."""
    if v is None:
        return None
    v = int(v)
    return v if v > 0 else None


def printing_doc(p: Mapping[str, Any]) -> dict[str, Any]:
    return _prune(
        {
            "printing_id": str(p["id"]),
            "set": p.get("set_code"),
            "set_name": p.get("set_name"),
            "set_type": p.get("set_type"),
            "collector_number": p.get("collector_number"),
            "rarity": p.get("rarity"),
            "released_at": _iso(p.get("released_at")),
            "artist": p.get("artist"),
            "lang": p.get("lang"),
            "finishes": list(p.get("finishes") or []),
            "promo": bool(p.get("promo")),
            "image_small": p.get("image_small"),
            "image_normal": p.get("image_normal"),
            "price_cents": _cents(p.get("price_nonfoil_cents")),
            "price_foil_cents": _cents(p.get("price_foil_cents")),
            "price_etched_cents": _cents(p.get("price_etched_cents")),
            "price_source": p.get("price_nonfoil_source"),
        }
    )


def headline_price(printings: Iterable[Mapping[str, Any]]) -> tuple[int | None, str | None]:
    """Cheapest NM nonfoil price across printings and its source, from
    printing docs (price_cents/price_source). (None, None) if unpriced."""
    best: tuple[int, int, str] | None = None
    for p in printings:
        cents, source = p.get("price_cents"), p.get("price_source")
        if cents is None or source is None:
            continue
        key = (cents, SOURCE_PREFERENCE.get(source, 9), source)
        if best is None or key < best:
            best = key
    return (best[0], best[2]) if best else (None, None)


def _representative(printings: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Newest non-promo English printing with an image (then any with one)."""
    with_image = [p for p in printings if p.get("image_normal")]
    if not with_image:
        return None
    preferred = [p for p in with_image if p.get("lang") == "en" and not p.get("promo")]
    pool = preferred or with_image
    return max(pool, key=lambda p: p.get("released_at") or "")


def catalog_doc(row: Mapping[str, Any]) -> dict[str, Any]:
    """Catalog doc from an extract row: card columns + `printings` (paper
    printings only; digital ones are dropped and flag digital_only)."""
    raw = list(row.get("printings") or [])
    paper = [p for p in raw if not p.get("digital")]
    printings = [printing_doc(p) for p in paper]
    rep = _representative(printings)
    card = dict(row)
    if rep and not card.get("image_normal"):
        card["image_small"] = rep.get("image_small")
        card["image_normal"] = rep.get("image_normal")
    doc = card_fields(card)
    cents, source = headline_price(printings)
    dates = sorted(p["released_at"] for p in printings if p.get("released_at"))
    doc.update(
        _prune(
            {
                "digital_only": bool(raw) and not paper,
                "price_cents": cents,
                "price_source": source,
                "printing_count": len(printings),
                "released_at": dates[0] if dates else None,
                "latest_released_at": dates[-1] if dates else None,
                "printings": printings,
            }
        )
    )
    doc.setdefault("printing_count", 0)
    return doc


# --- listings (written by tcg-pos-api's indexer, M5) ----------------------


def listing_id(tenant_id: Any, oracle_id: Any) -> str:
    return f"{tenant_id}:{oracle_id}"


def offer_doc(offer: Mapping[str, Any]) -> dict[str, Any] | None:
    """One sellable offer, or None if it must not list: unpriced stock never
    lists, nor does qty <= 0. `available` must already have the store's
    holdback applied (POS web_available())."""
    price = _cents(offer.get("price_cents"))
    available = int(offer.get("available") or 0)
    if price is None or available <= 0:
        return None
    condition = str(offer.get("condition") or "NM").upper()
    return _prune(
        {
            "printing_id": str(offer["printing_id"]),
            "set": offer.get("set_code") or offer.get("set"),
            "set_name": offer.get("set_name"),
            "set_type": offer.get("set_type"),
            "collector_number": offer.get("collector_number"),
            "rarity": offer.get("rarity"),
            "released_at": _iso(offer.get("released_at")),
            "artist": offer.get("artist"),
            "lang": offer.get("lang") or "en",
            "finish": offer.get("finish") or "nonfoil",
            "condition": condition,
            "condition_rank": CONDITION_RANK.get(condition),
            "price_cents": price,
            "available": available,
            "image_small": offer.get("image_small"),
            "image_normal": offer.get("image_normal"),
        }
    )


def listing_doc(
    card: Mapping[str, Any],
    tenant_id: Any,
    offers: Iterable[Mapping[str, Any]],
    *,
    updated_at: datetime | None = None,
) -> dict[str, Any] | None:
    """A store's listing doc for one card, or None when no offer is
    sellable — the indexer must then DELETE `listing_id(tenant, oracle_id)`
    (with routing=tenant_id)."""
    kept = [o for o in (offer_doc(x) for x in offers) if o is not None]
    if not kept:
        return None
    card = dict(card)
    if not card.get("image_normal"):
        rep = _representative(kept)
        if rep:
            card["image_small"], card["image_normal"] = rep.get("image_small"), rep.get(
                "image_normal"
            )
    return _with_offers(card_fields(card), tenant_id, kept, updated_at)


# Printing metadata copied from a catalog doc onto a store's offer of it.
PRINTING_TO_OFFER = {"set": "set", "set_name": "set_name", "set_type": "set_type",
                     "collector_number": "collector_number", "rarity": "rarity",
                     "released_at": "released_at", "artist": "artist",
                     "image_small": "image_small", "image_normal": "image_normal"}
# Card-level fields a listing doc takes verbatim from a catalog doc. Images
# are left out: a listing shows one of the printings the store has.
CATALOG_CARD_SKIP = {"image_small", "image_normal"}


def catalog_card_fields(catalog_src: Mapping[str, Any]) -> dict[str, Any]:
    """The card-level fields of a catalog doc's `_source` (already shaped by
    card_fields when the catalog was built), without its nested printings
    or catalog-only extras (headline price, printing count)."""
    return {k: v for k, v in catalog_src.items()
            if k in CARD_FIELDS and k not in CATALOG_CARD_SKIP}


def listing_doc_from_catalog(
    catalog_src: Mapping[str, Any],
    tenant_id: Any,
    offers: Iterable[Mapping[str, Any]],
    *,
    updated_at: datetime | None = None,
) -> dict[str, Any] | None:
    """Like listing_doc, but the card comes from a catalog doc's `_source`
    (the catalog index is the indexer's card source, so the POS never reads
    the mtg DB) instead of an mtg `cards` row. Card fields are copied as the
    catalog shaped them, so both indices agree field for field; each offer
    gets its printing's set/rarity/image from the catalog's `printings`.
    Offers for printings the card doesn't have are dropped. None => delete."""
    printings = {str(p.get("printing_id")): p for p in catalog_src.get("printings") or []}
    enriched = []
    for o in offers:
        p = printings.get(str(o.get("printing_id")))
        if p is None:
            continue
        enriched.append({**{dst: p.get(src) for src, dst in PRINTING_TO_OFFER.items()}, **{
            k: v for k, v in o.items() if v is not None}})
    kept = [o for o in (offer_doc(x) for x in enriched) if o is not None]
    if not kept:
        return None
    doc = catalog_card_fields(catalog_src)
    rep = _representative(kept)
    image_from = rep or catalog_src
    doc.update(_prune({"image_small": image_from.get("image_small"),
                       "image_normal": image_from.get("image_normal")}))
    return _with_offers(doc, tenant_id, kept, updated_at)


def _with_offers(
    doc: dict[str, Any], tenant_id: Any, kept: list[dict[str, Any]], updated_at: datetime | None
) -> dict[str, Any]:
    in_stock = sum(o["available"] for o in kept)
    doc.update(
        _prune(
            {
                "tenant_id": str(tenant_id),
                "price_cents": min(o["price_cents"] for o in kept),
                "in_stock": in_stock,
                # Small boost for depth; rank_feature needs > 0 (in_stock >= 1 here).
                "stock_depth": float(in_stock),
                "updated_at": _iso(updated_at),
                "offers": kept,
            }
        )
    )
    return doc


FACE_KEYS = ("name", "mana_cost", "type_line", "oracle_text", "power", "toughness", "loyalty",
             "defense", "colors", "image_small", "image_normal")


def _face(face: Mapping[str, Any] | None) -> dict[str, Any]:
    return _prune({k: (face or {}).get(k) for k in FACE_KEYS})
