"""Pure helpers that turn mtg catalog rows into searchable card text. No I/O.

- parse_type_line: "Legendary Creature — Elf Druid // Land" -> super/types/subtypes
- face_names: full name + each face ("Fire // Ice" -> Fire, Ice)
- substitute_cardname: the card's own name in its rules text -> "cardname",
  so "Lightning Bolt deals 3 damage" doesn't make every Bolt-named card
  match "lightning" through its text
- popularity: edhrec_rank -> rank_feature value (positive, None if unranked)
- compact: the Python twin of the `compact` normalizer
"""

import math
import re
import unicodedata
from typing import Any

SUPERTYPES = {"basic", "legendary", "snow", "world", "ongoing", "elite", "host"}
DASHES = ("—", "–", " - ")
CARDNAME = "cardname"
COLOR_ORDER = "WUBRG"


def _split_faces(type_line: str | None) -> list[str]:
    return [t.strip() for t in (type_line or "").split("//") if t.strip()]


def parse_type_line(type_line: str | None) -> dict[str, list[str]]:
    """Lower-cased, de-duplicated supertypes / types / subtypes across all
    faces, in first-seen order."""
    out: dict[str, list[str]] = {"supertypes": [], "types": [], "subtypes": []}
    for face in _split_faces(type_line):
        left, right = face, ""
        for dash in DASHES:
            if dash in face:
                left, right = face.split(dash, 1)
                break
        for word in left.split():
            w = word.lower()
            key = "supertypes" if w in SUPERTYPES else "types"
            if w not in out[key]:
                out[key].append(w)
        for word in right.split():
            w = word.lower().strip(",")
            if w and w not in out["subtypes"]:
                out["subtypes"].append(w)
    return out


def face_names(name: str, card_faces: list[dict[str, Any]] | None) -> list[str]:
    """The full name first, then each distinct face name."""
    names = [name]
    for face in card_faces or []:
        n = (face or {}).get("name")
        if n and n not in names:
            names.append(n)
    if " // " in name:
        for part in name.split(" // "):
            if part and part not in names:
                names.append(part)
    return names


def _name_variants(names: list[str], type_line: str | None) -> list[str]:
    """Names to replace in rules text, longest first. Legendary cards are
    often referred to by the part before the comma ("Uro", "Kiki-Jiki")."""
    variants = set()
    legendary = "legendary" in (type_line or "").lower()
    for n in names:
        if " // " in n:
            continue
        variants.add(n)
        if legendary and "," in n:
            short = n.split(",", 1)[0].strip()
            if len(short) >= 3:
                variants.add(short)
    return sorted(variants, key=len, reverse=True)


def substitute_cardname(text: str | None, names: list[str], type_line: str | None = None) -> str:
    if not text:
        return ""
    for v in _name_variants(names, type_line):
        text = re.sub(rf"(?<![\w']){re.escape(v)}(?![\w])", CARDNAME, text)
    return text


def rules_text(
    oracle_text: str | None,
    card_faces: list[dict[str, Any]] | None,
    names: list[str],
    type_line: str | None,
) -> str:
    """Rules text with own name substituted. Multi-face cards without
    top-level oracle text (split, DFC, adventure) join their faces."""
    parts = [oracle_text] if oracle_text else [
        (f or {}).get("oracle_text") or "" for f in (card_faces or [])
    ]
    joined = "\n".join(p for p in parts if p)
    return substitute_cardname(joined, names, type_line)


def popularity(edhrec_rank: int | None) -> float | None:
    """rank_feature value from EDHREC rank: rank 1 -> ~19600, rank 1000 ->
    ~950, rank 30000 -> ~33. Floored at 1.0 because rank_feature requires a
    positive value. Unranked cards get None (field omitted), never 0."""
    if edhrec_rank is None or edhrec_rank <= 0:
        return None
    return max(1.0, round(1_000_000 / (edhrec_rank + 50), 3))


def compact(text: str) -> str:
    """Lower-case, strip accents and apostrophes, drop every non-alphanumeric
    — matches the index's `compact` normalizer."""
    folded = unicodedata.normalize("NFKD", text.replace("Æ", "AE").replace("æ", "ae"))
    folded = "".join(ch for ch in folded if not unicodedata.combining(ch))
    return re.sub(r"[^0-9a-z]+", "", folded.lower())


def sort_colors(colors: list[str] | None) -> list[str]:
    return sorted(set(colors or []), key=lambda c: COLOR_ORDER.find(c) % 99)


def numeric_stat(value: str | None) -> float | None:
    """Power/toughness/loyalty as a number where it is one ("3", "1.5");
    None for "*", "1+*", "X" — those stay searchable as raw keywords."""
    if value is None:
        return None
    try:
        n = float(value)
    except ValueError:
        return None
    return n if math.isfinite(n) else None


def short_names(names: list[str], type_line: str | None) -> list[str]:
    """What players call a legend: the part before the comma ("Kenrith" for
    "Kenrith, the Returned King"). Legendary cards only, >= 3 letters."""
    if "legendary" not in (type_line or "").lower():
        return []
    out = []
    for n in names:
        if " // " in n or "," not in n:
            continue
        short = n.split(",", 1)[0].strip()
        if len(short) >= 3 and short not in out:
            out.append(short)
    return out
