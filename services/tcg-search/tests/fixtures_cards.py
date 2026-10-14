"""Synthetic extract rows shaped like catalog/extract.py's output, for unit
and OpenSearch integration tests. Real names so analyzers are exercised on
real punctuation; prices are made up."""

import copy
import uuid


def _id(name: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"tcg-search-test/{name}"))


def printing(name, set_code, number, *, rarity="common", released="2010-07-16", nonfoil=None,
             foil=None, digital=False, lang="en", finishes=("nonfoil", "foil"), set_name=None,
             source="mtgjson_tcgplayer", artist="Christopher Rush"):
    return {
        "id": _id(f"{name}/{set_code}/{number}"),
        "set_code": set_code,
        "set_name": set_name or set_code.upper(),
        "set_type": "core",
        "collector_number": number,
        "rarity": rarity,
        "lang": lang,
        "released_at": released,
        "artist": artist,
        "finishes": list(finishes),
        "promo": False,
        "digital": digital,
        "image_small": f"https://img.example/{set_code}/{number}/s.jpg",
        "image_normal": f"https://img.example/{set_code}/{number}/n.jpg",
        "price_nonfoil_cents": nonfoil,
        "price_nonfoil_source": source if nonfoil else None,
        "price_foil_cents": foil,
        "price_foil_source": source if foil else None,
        "price_etched_cents": None,
        "price_etched_source": None,
    }


def card(name, *, type_line="Instant", oracle_text="", mana_cost="{R}", mana_value=1,
         colors=("R",), identity=None, keywords=(), layout="normal", card_faces=None,
         edhrec_rank=None, legal=("modern", "legacy", "vintage", "commander"), banned=(),
         reserved=False, power=None, toughness=None, printings=()):
    legalities = {f: "legal" for f in legal}
    legalities.update({f: "banned" for f in banned})
    return {
        "oracle_id": _id(name),
        "name": name,
        "mana_cost": mana_cost,
        "mana_value": mana_value,
        "type_line": type_line,
        "oracle_text": oracle_text,
        "colors": list(colors) if colors is not None else None,
        "color_identity": list(identity if identity is not None else colors or ()),
        "keywords": list(keywords),
        "power": power,
        "toughness": toughness,
        "loyalty": None,
        "defense": None,
        "produced_mana": None,
        "layout": layout,
        "legalities": legalities,
        "card_faces": card_faces,
        "reserved": reserved,
        "edhrec_rank": edhrec_rank,
        "printings": list(printings),
    }


def sample_rows():
    return copy.deepcopy([
        card("Lightning Bolt", oracle_text="Lightning Bolt deals 3 damage to any target.",
             edhrec_rank=150,
             printings=[printing("Lightning Bolt", "lea", "161", nonfoil=45000,
                                 released="1993-08-05", set_name="Limited Edition Alpha"),
                        printing("Lightning Bolt", "m11", "149", nonfoil=150, foil=600,
                                 released="2010-07-16", set_name="Magic 2011"),
                        printing("Lightning Bolt", "prm", "1", nonfoil=99, digital=True)]),
        card("Bolt Bend", mana_cost="{3}{R}", mana_value=4,
             oracle_text="This spell costs {3} less to cast if you control a creature with "
                         "power 4 or greater.\nChange the target of target spell or ability "
                         "with a single target.", edhrec_rank=9000,
             printings=[printing("Bolt Bend", "war", "115", rarity="uncommon", nonfoil=35)]),
        card("Tarmogoyf", type_line="Creature — Lhurgoyf", mana_cost="{1}{G}", mana_value=2,
             colors=("G",), oracle_text="Tarmogoyf's power is equal to the number of card "
             "types among cards in all graveyards and its toughness is equal to that number "
             "plus 1.", power="*", toughness="1+*", edhrec_rank=4000,
             printings=[printing("Tarmogoyf", "fut", "153", rarity="rare", nonfoil=1500)]),
        card("Fire // Ice", type_line="Instant // Instant", mana_cost="{1}{R} // {1}{U}",
             mana_value=4, colors=("U", "R"), oracle_text=None, layout="split",
             card_faces=[
                 {"name": "Fire", "mana_cost": "{1}{R}", "type_line": "Instant",
                  "oracle_text": "Fire deals 2 damage divided as you choose among one or two "
                                 "targets."},
                 {"name": "Ice", "mana_cost": "{1}{U}", "type_line": "Instant",
                  "oracle_text": "Tap target permanent.\nDraw a card."}],
             edhrec_rank=1500,
             printings=[printing("Fire // Ice", "apc", "128", rarity="uncommon", nonfoil=None)]),
        card("Lim-Dûl's Vault", mana_cost="{U}{B}", mana_value=2, colors=("U", "B"),
             oracle_text="Look at the top five cards of your library.", edhrec_rank=2200,
             printings=[printing("Lim-Dûl's Vault", "all", "190", rarity="uncommon",
                                 nonfoil=120)]),
        card("Shivan Dragon", type_line="Creature — Dragon", mana_cost="{4}{R}{R}", mana_value=6,
             keywords=("Flying",), power="5", toughness="5", oracle_text="Flying\n{R}: Shivan "
             "Dragon gets +1/+0 until end of turn.", edhrec_rank=8000,
             printings=[printing("Shivan Dragon", "lea", "174", rarity="rare", nonfoil=90000,
                                 set_name="Limited Edition Alpha")]),
        card("Digital Only Thing", edhrec_rank=10,
             printings=[printing("Digital Only Thing", "ymid", "1", digital=True)]),
    ])
