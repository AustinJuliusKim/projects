"""Pure row-shaping: Scryfall card/ruling JSON -> table row dicts, plus the
canonical content hashes that make upserts and (phase 3) re-embedding
incremental. No I/O here — everything is unit-testable against fixtures."""

import hashlib
import json
from typing import Any

# Layouts with no stable oracle identity — never stored as cards or printings.
SKIP_LAYOUTS = {"token", "emblem", "art_series", "double_faced_token"}

# The slice of each card face worth keeping; full faces carry per-face image
# and artist metadata we don't serve.
FACE_FIELDS = (
    "name",
    "mana_cost",
    "type_line",
    "oracle_text",
    "power",
    "toughness",
    "loyalty",
    "defense",
    "colors",
)


def content_hash(obj: dict[str, Any]) -> str:
    """sha256 over canonical (sorted-key, compact) JSON. Dates and other
    non-JSON types stringify via default=str so hashing is total."""
    canonical = json.dumps(obj, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def oracle_id_of(card: dict[str, Any]) -> str | None:
    """Top-level oracle_id, or the first face's for reversible_card (the only
    layout where Scryfall moves it into the faces)."""
    oid = card.get("oracle_id")
    if oid:
        return oid
    faces = card.get("card_faces") or []
    if card.get("layout") == "reversible_card" and faces:
        return faces[0].get("oracle_id")
    return None


def _slim_faces(card: dict[str, Any]) -> list[dict[str, Any]] | None:
    faces = card.get("card_faces")
    if not faces:
        return None
    return [{k: f[k] for k in FACE_FIELDS if k in f} for f in faces]


def _joined_face_text(card: dict[str, Any], field: str) -> str | None:
    """Top-level value if present, else faces joined with ' // ' — keeps
    oracle_text/mana_cost searchable for multiface cards, matching how
    Scryfall renders type_line for them."""
    value = card.get(field)
    if value is not None:
        return value
    faces = card.get("card_faces") or []
    parts = [f.get(field) for f in faces if f.get(field)]
    return " // ".join(parts) if parts else None


def card_row(card: dict[str, Any]) -> dict[str, Any] | None:
    """cards row, or None for layouts/objects without an oracle identity."""
    if card.get("layout") in SKIP_LAYOUTS:
        return None
    oid = oracle_id_of(card)
    if not oid:
        return None
    row = {
        "oracle_id": oid,
        "name": card["name"],
        "mana_cost": _joined_face_text(card, "mana_cost"),
        "mana_value": card.get("cmc"),
        "type_line": card.get("type_line"),
        "oracle_text": _joined_face_text(card, "oracle_text"),
        "colors": card.get("colors"),
        "color_identity": card.get("color_identity"),
        "keywords": card.get("keywords"),
        "power": card.get("power"),
        "toughness": card.get("toughness"),
        "loyalty": card.get("loyalty"),
        "defense": card.get("defense"),
        "produced_mana": card.get("produced_mana"),
        "layout": card.get("layout"),
        "legalities": card.get("legalities"),
        "card_faces": _slim_faces(card),
        "reserved": bool(card.get("reserved")),
        "edhrec_rank": card.get("edhrec_rank"),
    }
    row["content_hash"] = content_hash(row)
    return row


def _face_image_uris(card: dict[str, Any]) -> dict[str, Any]:
    uris = card.get("image_uris")
    if uris:
        return uris
    faces = card.get("card_faces") or []
    if faces and faces[0].get("image_uris"):
        return faces[0]["image_uris"]
    return {}


def printing_row(card: dict[str, Any]) -> dict[str, Any] | None:
    """printings row (prices separate — they churn every refresh and are
    excluded from the hash), or None for skipped layouts."""
    if card.get("layout") in SKIP_LAYOUTS:
        return None
    oid = oracle_id_of(card)
    if not oid:
        return None
    images = _face_image_uris(card)
    row = {
        "id": card["id"],
        "oracle_id": oid,
        "set_code": card["set"],
        "collector_number": card.get("collector_number"),
        "rarity": card.get("rarity"),
        "lang": card.get("lang"),
        "released_at": card.get("released_at"),
        "artist": card.get("artist"),
        "finishes": card.get("finishes"),
        "promo": bool(card.get("promo")),
        "digital": bool(card.get("digital")),
        "image_small": images.get("small"),
        "image_normal": images.get("normal"),
        "image_status": card.get("image_status"),
    }
    # Hash before merging prices: they churn every bulk refresh and update
    # via a separate guarded statement, so they must not perturb the hash.
    row["content_hash"] = content_hash(row)
    prices = prices_row(card)
    del prices["id"]
    row.update(prices)
    return row


def prices_row(card: dict[str, Any]) -> dict[str, Any]:
    prices = card.get("prices") or {}
    return {
        "id": card["id"],
        "price_usd": prices.get("usd"),
        "price_usd_foil": prices.get("usd_foil"),
        "price_eur": prices.get("eur"),
        "price_tix": prices.get("tix"),
    }


def set_row(card: dict[str, Any]) -> dict[str, Any]:
    """sets row from the fields embedded in a card object. released_at is the
    printing's date — approximately the set's; load keeps the earliest seen.
    card_count/icon_svg_uri stay null until a dedicated /sets sync exists."""
    return {
        "code": card["set"],
        "name": card.get("set_name"),
        "set_type": card.get("set_type"),
        "released_at": card.get("released_at"),
    }


def ruling_row(ruling: dict[str, Any]) -> dict[str, Any]:
    comment = ruling["comment"]
    return {
        "oracle_id": ruling["oracle_id"],
        "published_at": ruling.get("published_at"),
        "comment": comment,
        "comment_hash": hashlib.sha256(comment.encode("utf-8")).hexdigest(),
    }
