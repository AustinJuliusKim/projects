"""The sealed-product catalog: which commander decks exist, and their identity.

MTGJSON publishes sealed *product* data but not sealed *prices* — the pricing
request has been open since 2022 (mtgjson/mtgjson#928), and every other source
with sealed prices is either closed to new developers (TCGplayer), restricted to
approved partners (eBay's sold-comp API), or paid. So this module does one thing:
it answers "what deck is this, exactly," and leaves prices to the human.

`SetList.json` already embeds `sealedProduct`, so one fetch gets every set. The
220 commander decks that fall out of it are small enough (~107 KB) to **vendor
into the repo**, which is what lets the rest of the package stay offline:
`load_catalog()` reads a committed file, and `refresh()` — the only function here
that touches the network — is opt-in.
"""

from __future__ import annotations

import json
import os
import re
import unicodedata
from dataclasses import dataclass, field
from typing import Callable, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

__all__ = [
    "CATALOG_PATH",
    "SETLIST_URL",
    "Deck",
    "Catalog",
    "load_catalog",
    "extract_decks",
    "refresh",
    "nickname",
    "split_display",
]

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
CATALOG_PATH = os.path.join(DATA_DIR, "commander_decks.json")

SETLIST_URL = "https://mtgjson.com/api/v5/SetList.json"

#: The vendor identifiers worth carrying. MTGJSON ships more; these are the ones
#: that lead somewhere useful for pricing a sealed deck by hand.
KEEP_IDS = (
    "tcgplayerProductId",
    "cardKingdomId",
    "mcmId",
    "cardtraderId",
    "scgId",
    "csiId",
    "abuId",
)

#: Words that carry no distinguishing information in a product name.
_FILLER = ("commander deck", "commander", "deck")


def _norm(text: str) -> str:
    """Casefold, strip accents and punctuation, collapse whitespace."""
    decomposed = unicodedata.normalize("NFKD", text or "")
    stripped = "".join(c for c in decomposed if not unicodedata.combining(c))
    return " ".join(re.sub(r"[^a-z0-9 ]", " ", stripped.lower()).split())


def nickname(product_name: str, set_name: str = "") -> str:
    """The distinctive tail of a product name — how a person refers to the deck.

    "Duskmourn House of Horror Commander Deck Death Toll" -> "death toll"

    212 of the 220 known decks have a unique nickname, which is why a bare
    "Sneak Attack" in a hand-written list usually resolves. The 8 that collide
    are reprints of an earlier deck and need a set code; `sealed.resolve`
    reports those rather than picking one.
    """
    text = _norm(product_name)
    for chunk in (_norm(set_name), *_FILLER):
        if chunk:
            text = text.replace(chunk, " ")
    return " ".join(text.split())


@dataclass(frozen=True)
class Deck:
    """One sealed commander deck product."""

    uuid: str
    name: str
    set_code: str
    set_name: str
    release_date: str
    card_count: Optional[int] = None
    ids: Mapping[str, str] = field(default_factory=dict)
    tcgplayer_url: str = ""

    @property
    def normalized_name(self) -> str:
        return _norm(self.name)

    @property
    def nickname(self) -> str:
        return nickname(self.name, self.set_name)

    @property
    def is_collectors_edition(self) -> bool:
        """A Collector's Edition is a different, pricier product than its base
        deck. Never let the two collapse into one match."""
        return "collector" in self.name.lower()

    @property
    def year(self) -> str:
        return self.release_date[:4]

    @property
    def display(self) -> str:
        return f"{self.name} [{self.set_code}]"


#: Inverse of `Deck.display`. Kept beside it so the format and its parse cannot
#: drift apart.
_DISPLAY_SUFFIX = re.compile(r"\s*\[\s*([A-Za-z0-9]{2,6})\s*\]\s*$")


def split_display(text: str) -> Tuple[str, str]:
    """Split a trailing ``[SET]`` off a product name: `("Deck", "M3C")`.

    `sealed doctor` offers its suggestions as `Deck.display`, so the obvious
    repair for an unmatched row is to paste that suggestion into the Name
    column. That paste used to fail: `_norm` turns the brackets into spaces, so
    the set code survives as a trailing word that matches no product name and no
    nickname — and doctor would then re-suggest the very string it had just
    rejected. Callers strip the suffix before lookup and use it as a set hint.

    Purely syntactic; the caller decides whether the code is real.
    """
    match = _DISPLAY_SUFFIX.search(text or "")
    if not match:
        return (text or "").strip(), ""
    return text[: match.start()].strip(), match.group(1).upper()


class Catalog:
    """The known sealed commander decks, indexed for lookup."""

    __slots__ = ("decks", "_by_uuid", "_by_name", "_by_nickname", "_set_codes")

    def __init__(self, decks: Iterable[Deck]):
        self.decks: Tuple[Deck, ...] = tuple(decks)
        self._by_uuid: Dict[str, Deck] = {d.uuid: d for d in self.decks}
        self._set_codes = frozenset(d.set_code.lower() for d in self.decks)

        # Name and nickname indexes map to *lists*, because collisions are real
        # and the caller has to be told about them.
        self._by_name: Dict[str, List[Deck]] = {}
        self._by_nickname: Dict[str, List[Deck]] = {}
        for deck in self.decks:
            self._by_name.setdefault(deck.normalized_name, []).append(deck)
            self._by_nickname.setdefault(deck.nickname, []).append(deck)

    def __len__(self) -> int:
        return len(self.decks)

    def __iter__(self):
        return iter(self.decks)

    def __repr__(self) -> str:
        return f"<Catalog {len(self.decks)} commander decks>"

    def by_uuid(self, uuid: str) -> Optional[Deck]:
        return self._by_uuid.get(uuid)

    def has_set(self, code: str) -> bool:
        """Whether any known deck carries this set code."""
        return code.strip().lower() in self._set_codes

    def by_name(self, text: str) -> List[Deck]:
        return list(self._by_name.get(_norm(text), ()))

    def by_nickname(self, text: str) -> List[Deck]:
        return list(self._by_nickname.get(nickname(text), ()))

    def by_nickname_suffix(self, text: str) -> List[Deck]:
        """Decks whose nickname *ends with* the query, word-aligned.

        Needed because 25 of the 220 products keep a set prefix in their
        nickname — the set is "Warhammer 40,000 Commander" but the product says
        "Warhammer 40000", so the comma defeats the prefix strip and the
        nickname stays "warhammer 40000 forces of the imperium". A person writes
        "Forces of the Imperium".

        Suffix rather than plain containment on purpose: a candidate that only
        adds words *before* the query is the same product under a longer
        official name, while one that adds words *after* it is a different
        variant. That is what keeps "Forces of the Imperium" off the Collector's
        Edition, whose nickname ends in "collectors edition".
        """
        needle = nickname(text)
        if not needle:
            return []
        return [
            d
            for d in self.decks
            if d.nickname == needle or d.nickname.endswith(" " + needle)
        ]

    def by_nickname_contains(self, text: str) -> List[Deck]:
        """Decks whose nickname contains the query as whole words. Last resort."""
        needle = nickname(text)
        if not needle:
            return []
        return [
            d
            for d in self.decks
            if needle == d.nickname or f" {needle} " in f" {d.nickname} "
        ]

    def search(self, text: str) -> List[Deck]:
        """Substring search over names, for browsing."""
        needle = _norm(text)
        if not needle:
            return list(self.decks)
        return [d for d in self.decks if needle in d.normalized_name]

    def ambiguous_nicknames(self) -> Dict[str, List[Deck]]:
        """Nicknames shared by more than one product — the reprints."""
        return {k: v for k, v in self._by_nickname.items() if len(v) > 1}


# --- reading ----------------------------------------------------------------


def _deck_from_json(raw: dict) -> Deck:
    return Deck(
        uuid=raw["uuid"],
        name=raw["name"],
        set_code=raw.get("setCode", ""),
        set_name=raw.get("setName", ""),
        release_date=raw.get("releaseDate", ""),
        card_count=raw.get("cardCount"),
        ids=dict(raw.get("ids") or {}),
        tcgplayer_url=raw.get("tcgplayerUrl", ""),
    )


def load_catalog(path: Optional[str] = None) -> Catalog:
    """Read the vendored catalog. No network."""
    with open(path or CATALOG_PATH, encoding="utf-8") as handle:
        blob = json.load(handle)
    return Catalog(_deck_from_json(d) for d in blob["decks"])


# --- refreshing (the only networked path) ------------------------------------


def extract_decks(setlist: dict) -> List[Deck]:
    """Pull commander decks out of a parsed MTGJSON `SetList.json`.

    Pure: takes already-parsed data, so it is tested against a fixture rather
    than a live request.
    """
    sets = setlist.get("data") or []
    decks: List[Deck] = []
    for entry in sets:
        for product in entry.get("sealedProduct") or []:
            if product.get("category") != "deck":
                continue
            if product.get("subtype") != "commander":
                continue
            ids = product.get("identifiers") or {}
            decks.append(
                Deck(
                    uuid=product["uuid"],
                    name=product["name"],
                    set_code=entry.get("code", ""),
                    set_name=entry.get("name", ""),
                    release_date=product.get("releaseDate")
                    or entry.get("releaseDate")
                    or "",
                    card_count=product.get("cardCount"),
                    ids={k: ids[k] for k in KEEP_IDS if ids.get(k)},
                    tcgplayer_url=(product.get("purchaseUrls") or {}).get("tcgplayer")
                    or "",
                )
            )
    decks.sort(key=lambda d: (d.release_date, d.name))
    return decks


def _default_fetch(url: str) -> bytes:
    # Imported lazily and used only here, so nothing else in the package can
    # accidentally reach the network.
    from urllib.request import Request, urlopen

    request = Request(url, headers={"User-Agent": "mtg-tools/0.1 (+personal)"})
    with urlopen(request, timeout=120) as response:  # noqa: S310 - fixed https URL
        return response.read()


def serialize(decks: Sequence[Deck]) -> str:
    blob = {
        "schema": 1,
        "source": "MTGJSON SetList.json",
        "filter": "category=deck subtype=commander",
        "count": len(decks),
        "decks": [
            {
                "uuid": d.uuid,
                "name": d.name,
                "setCode": d.set_code,
                "setName": d.set_name,
                "releaseDate": d.release_date,
                "cardCount": d.card_count,
                "ids": dict(d.ids),
                "tcgplayerUrl": d.tcgplayer_url,
            }
            for d in decks
        ],
    }
    return json.dumps(blob, indent=1, ensure_ascii=False) + "\n"


def refresh(
    path: Optional[str] = None,
    *,
    fetch: Optional[Callable[[str], bytes]] = None,
    url: str = SETLIST_URL,
    write: bool = True,
) -> Tuple[List[Deck], List[Deck], List[Deck]]:
    """Rebuild the vendored catalog from MTGJSON.

    Returns `(decks, added, removed)` so the caller can report what changed
    instead of silently rewriting the file.

    `fetch` is injectable: tests pass a function that returns fixture bytes, so
    the suite never opens a socket. That matters because `run_tests.py` fails on
    any skip other than "ManaBox exports absent", so a network-gated test would
    break the guard rather than quietly skipping.
    """
    target = path or CATALOG_PATH
    fetcher = fetch or _default_fetch

    setlist = json.loads(fetcher(url).decode("utf-8"))
    decks = extract_decks(setlist)
    if not decks:
        raise ValueError(
            "no commander decks found in the fetched SetList — refusing to "
            "overwrite the catalog with an empty result"
        )

    try:
        before = {d.uuid: d for d in load_catalog(target)}
    except (FileNotFoundError, KeyError, json.JSONDecodeError):
        before = {}

    now = {d.uuid: d for d in decks}
    added = [d for uuid, d in now.items() if uuid not in before]
    removed = [d for uuid, d in before.items() if uuid not in now]

    if write:
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, "w", encoding="utf-8") as handle:
            handle.write(serialize(decks))

    return decks, added, removed
