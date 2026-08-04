"""Canonical embed text for a card. The exact output strings are
hash-load-bearing: any change here changes every embed_hash and triggers a
full ~35k-card re-embed (~$0.50) on the next embed run — deliberate, but not
to be done casually. Golden-string tests pin the format.

Two normalizations kill the failure modes of naive text embedding:
- self-references become CARDNAME, so "Sanguine Bond" and "Vito, Thorn of the
  Dusk Rose" read as the same pattern instead of different names;
- reminder text (parenthesized) is stripped, so keyword definitions don't
  drown the card's actual behavior.
"""

import hashlib
import re
from typing import Any

MODEL_ID = "amazon.titan-embed-text-v2:0"
DIMENSIONS = 512

REMINDER_RE = re.compile(r"\s*\([^()]*\)")
WUBRG = "WUBRG"


def _face_names(name: str) -> list[str]:
    return [part.strip() for part in name.split("//") if part.strip()]


def _clean_oracle_text(oracle_text: str, name: str) -> str:
    text = REMINDER_RE.sub("", oracle_text)
    for face in [name, *_face_names(name)]:
        text = text.replace(face, "CARDNAME")
        # Scryfall also abbreviates a legendary self-reference to the short
        # name ("Vito" for "Vito, Thorn of the Dusk Rose").
        short = face.split(",")[0].strip()
        if len(short) > 2:
            text = text.replace(short, "CARDNAME")
    return re.sub(r"[ \t]+", " ", text).strip()


def _stats(card: dict[str, Any]) -> str:
    if card.get("power") is not None or card.get("toughness") is not None:
        return f"{card.get('power') or '?'}/{card.get('toughness') or '?'}"
    if card.get("loyalty") is not None:
        return f"loyalty {card['loyalty']}"
    if card.get("defense") is not None:
        return f"defense {card['defense']}"
    return "-"


def _identity(card: dict[str, Any]) -> str:
    identity = card.get("color_identity") or []
    ordered = "".join(ch for ch in WUBRG if ch in identity)
    return ordered or "C"


def embed_text(card: dict[str, Any]) -> str:
    """`card` is a cards-table row dict (name, type_line, oracle_text,
    keywords, power/toughness/loyalty/defense, mana_value, color_identity)."""
    oracle = _clean_oracle_text(card.get("oracle_text") or "", card["name"])
    keywords = ", ".join(sorted(card.get("keywords") or [])) or "-"
    mv = card.get("mana_value")
    mv_text = f"{mv:g}" if mv is not None else "-"
    return (
        f"CARDNAME | {card.get('type_line') or '-'} | {oracle or '-'} | "
        f"keywords: {keywords} | stats: {_stats(card)} | mv {mv_text} | "
        f"colors {_identity(card)}"
    )


def embed_hash(text: str) -> str:
    return hashlib.sha256(f"{text}|{MODEL_ID}".encode()).hexdigest()
