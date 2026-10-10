"""Scryfall-style query syntax, v1. Hand-written; never raises on user input.

Grammar (whitespace-separated terms, implicitly ANDed):

  word                free text            "draw a card"     phrase
  -word / -"phrase"   negated text         -key:value        negated filter
  key OP value        filter, OP in  :  =  !=  <  <=  >  >=
  value may be "quoted" to include spaces:  o:"draw a card"  a:"john avon"

Keys (aliases in parentheses):
  t (type)                    type line words           t:dragon  t:"legendary creature"
  o (oracle, text)            rules text; ~ = this card o:"~ deals 3"
  c (color, colors)           colors; ':' means >=      c:rg  c=r  c<=wub  c:m  c:c
  id (identity, ci)           color identity; ':' means <=   id<=u  id:esper
  s (set, e, edition)         set code, alias or name   s:lea  s:alpha  s:"ice age"
  r (rarity)                  c/u/r/m/s, ordered        r:mythic  r>=rare
  mv (cmc, manavalue)         mana value                mv<=4
  pow (power), tou (toughness), loy (loyalty)            pow>=5
  f (format, legal), banned, restricted                 f:modern  banned:legacy
  kw (keyword)                keyword ability           kw:flying
  a (artist)                  artist                    a:"rebecca guay"
  name                        name words                name:bolt
  is / not                    reserved dfc foil nonfoil etched promo digital
  cond (condition)            NM LP MP HP DMG (listings) cond>=lp
  usd (price)                 dollars                   usd<5

Unknown keys (and malformed values) fall back to free text with a warning.
"""

import re
from dataclasses import dataclass, field
from typing import Any

from tcg_search import cardtext, data

OPS = ("<=", ">=", "!=", ":", "=", "<", ">")

KEY_ALIASES = {
    "t": "t", "type": "t",
    "o": "o", "oracle": "o", "text": "o",
    "c": "c", "color": "c", "colors": "c",
    "id": "id", "identity": "id", "ci": "id",
    "s": "s", "set": "s", "e": "s", "edition": "s",
    "r": "r", "rarity": "r",
    "mv": "mv", "cmc": "mv", "manavalue": "mv",
    "pow": "pow", "power": "pow",
    "tou": "tou", "toughness": "tou",
    "loy": "loy", "loyalty": "loy",
    "f": "f", "format": "f", "legal": "f",
    "banned": "banned",
    "restricted": "restricted",
    "kw": "kw", "keyword": "kw",
    "a": "a", "artist": "a",
    "name": "name",
    "is": "is", "not": "not",
    "cond": "cond", "condition": "cond",
    "usd": "usd", "price": "usd",
}

NUMERIC_KEYS = {"mv", "pow", "tou", "loy", "usd"}
COLOR_KEYS = {"c", "id"}
IS_VALUES = {"reserved", "dfc", "foil", "nonfoil", "etched", "promo", "digital"}

COLOR_NAMES = {
    "white": "W", "blue": "U", "black": "B", "red": "R", "green": "G",
    "azorius": "WU", "dimir": "UB", "rakdos": "BR", "gruul": "RG", "selesnya": "GW",
    "orzhov": "WB", "izzet": "UR", "golgari": "BG", "boros": "RW", "simic": "GU",
    "bant": "GWU", "esper": "WUB", "grixis": "UBR", "jund": "BRG", "naya": "RGW",
    "abzan": "WBG", "jeskai": "URW", "sultai": "BGU", "mardu": "RWB", "temur": "GUR",
    "wubrg": "WUBRG", "fivecolor": "WUBRG",
}

RARITIES = ["common", "uncommon", "rare", "mythic"]
RARITY_ALIASES = {
    "c": "common", "common": "common",
    "u": "uncommon", "uncommon": "uncommon",
    "r": "rare", "rare": "rare",
    "m": "mythic", "mythic": "mythic",
    "s": "special", "special": "special",
    "b": "bonus", "bonus": "bonus",
}

CONDITIONS = {"nm": 5, "lp": 4, "mp": 3, "hp": 2, "dmg": 1, "dm": 1, "d": 1, "sp": 4, "ex": 4}
CONDITION_NAMES = {5: "NM", 4: "LP", 3: "MP", 2: "HP", 1: "DMG"}

FORMATS = {
    "standard", "pioneer", "modern", "legacy", "vintage", "commander", "pauper",
    "historic", "timeless", "alchemy", "brawl", "standardbrawl", "oathbreaker", "penny",
    "premodern", "oldschool", "predh", "paupercommander", "duel", "gladiator", "future",
    "competitivebrawl", "explorer",
}
FORMAT_ALIASES = {"edh": "commander", "cmdr": "commander", "pdh": "paupercommander"}


@dataclass
class Clause:
    """One term of a query: free text (key None) or a filter."""

    key: str | None
    op: str = ":"
    value: Any = None
    negated: bool = False
    phrase: bool = False
    raw: str = ""
    source: str = "q"  # "q" (typed) or "facet" (from a facet selection)

    def as_dict(self) -> dict[str, Any]:
        out = {
            "key": self.key,
            "op": self.op,
            "value": self.value,
            "negated": self.negated,
            "raw": self.raw,
            "source": self.source,
        }
        if self.phrase:
            out["phrase"] = True
        return out


@dataclass
class ParsedQuery:
    clauses: list[Clause] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def text(self) -> str:
        """Positive, unquoted free text, joined — the relevance query."""
        return " ".join(
            c.value for c in self.clauses if c.key is None and not c.negated and not c.phrase
        )

    @property
    def filters(self) -> list[Clause]:
        return [c for c in self.clauses if c.key is not None]

    def is_name_like(self) -> bool:
        """Only plain free text, short: a candidate for did-you-mean."""
        return (
            bool(self.text)
            and all(c.key is None and not c.negated and not c.phrase for c in self.clauses)
            and len(self.text.split()) <= 5
        )


# A term: optional -, then key+op+(quoted|bare) value, or a quoted phrase, or a bare word.
_TERM = re.compile(
    r"""
    (?P<neg>-)?
    (?:
        (?P<key>[A-Za-z]+)(?P<op><=|>=|!=|:|=|<|>)(?:"(?P<qval>[^"]*)"?|(?P<val>\S*))
      | "(?P<phrase>[^"]*)"?
      | (?P<word>\S+)
    )
    """,
    re.VERBOSE,
)


def parse(q: str | None) -> ParsedQuery:
    out = ParsedQuery()
    q = (q or "").strip()
    pos = 0
    while pos < len(q):
        if q[pos].isspace():
            pos += 1
            continue
        m = _TERM.match(q, pos)
        if not m or m.end() == pos:  # pragma: no cover - the word branch always matches
            break
        pos = m.end()
        raw = m.group(0)
        neg = bool(m.group("neg"))
        if m.group("key") is not None:
            value = m.group("qval") if m.group("qval") is not None else m.group("val")
            _filter(out, m.group("key"), m.group("op"), value or "", neg, raw)
        elif m.group("phrase") is not None:
            text = m.group("phrase").strip()
            if text:
                out.clauses.append(Clause(None, value=text, negated=neg, phrase=True, raw=raw))
        else:
            word = m.group("word")
            if not word.strip("-"):
                continue
            out.clauses.append(Clause(None, value=word, negated=neg, raw=raw))
    return out


def _as_text(out: ParsedQuery, raw: str, neg: bool, why: str) -> None:
    out.warnings.append(f"{why}; searched {raw!r} as text")
    text = raw[1:] if neg else raw
    out.clauses.append(Clause(None, value=text.replace('"', ""), negated=neg, raw=raw))


def _filter(out: ParsedQuery, key: str, op: str, value: str, neg: bool, raw: str) -> None:
    canon = KEY_ALIASES.get(key.lower())
    if canon is None:
        _as_text(out, raw, neg, f"unknown key {key!r}")
        return
    value = value.strip()
    if not value:
        _as_text(out, raw, neg, f"{key}: needs a value")
        return
    if canon == "not":
        canon, neg = "is", not neg
    try:
        parsed_value, op = _value(canon, op, value)
    except ValueError as err:
        _as_text(out, raw, neg, str(err))
        return
    out.clauses.append(Clause(canon, op=op, value=parsed_value, negated=neg, raw=raw))


def _value(key: str, op: str, value: str) -> tuple[Any, str]:
    """Validate/normalize one filter value. Returns (value, op)."""
    low = value.lower()
    if key in NUMERIC_KEYS:
        try:
            n = float(value.lstrip("$"))
        except ValueError:
            raise ValueError(f"{key}: expects a number, got {value!r}") from None
        return n, "=" if op == ":" else op
    if key in COLOR_KEYS:
        return parse_colors(low), op
    if key == "r":
        if low not in RARITY_ALIASES:
            raise ValueError(f"r: unknown rarity {value!r}")
        return RARITY_ALIASES[low], "=" if op == ":" else op
    if key == "cond":
        if low not in CONDITIONS:
            raise ValueError(f"cond: unknown condition {value!r}")
        return CONDITIONS[low], "=" if op == ":" else op
    if key in ("f", "banned", "restricted"):
        fmt = FORMAT_ALIASES.get(low, low)
        if fmt not in FORMATS:
            raise ValueError(f"{key}: unknown format {value!r}")
        return fmt, ":"
    if key == "is":
        if low not in IS_VALUES:
            raise ValueError(f"is: unknown value {value!r}")
        return low, ":"
    if op not in (":", "="):
        raise ValueError(f"{key}: doesn't support {op!r}")
    if key == "s":
        return resolve_set(value), ":"
    return value, ":"


def parse_colors(value: str) -> str:
    """'rg' / 'red' / 'gruul' / 'c' (colorless) / 'm' (multicolor) -> a
    canonical WUBRG-ordered letter string, '' for colorless, 'M' for
    multicolor."""
    v = value.lower().replace(" ", "")
    if v in ("c", "colorless"):
        return ""
    if v in ("m", "multi", "multicolor", "gold"):
        return "M"
    if v in COLOR_NAMES:
        return "".join(cardtext.sort_colors(list(COLOR_NAMES[v])))
    if v and all(ch in "wubrg" for ch in v):
        return "".join(cardtext.sort_colors(list(v.upper())))
    raise ValueError(f"unknown colors {value!r}")


def resolve_set(value: str) -> dict[str, str]:
    """{'code': ..., 'name': ...}: an alias from set_aliases.yaml resolves to
    its code; otherwise the value is tried both as a code and a set name."""
    alias = data.set_aliases().get(cardtext.compact(value))
    if alias:
        return {"code": alias, "name": value}
    return {"code": value.lower(), "name": value}
