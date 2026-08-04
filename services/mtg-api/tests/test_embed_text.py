"""Golden-string tests: embed_text output is hash-load-bearing (any change
re-embeds all ~35k cards on the next run), so the exact format is pinned."""

from mtg_api.similar.embed_text import embed_hash, embed_text

BOLT = {
    "name": "Lightning Bolt",
    "type_line": "Instant",
    "oracle_text": "Lightning Bolt deals 3 damage to any target.",
    "keywords": [],
    "power": None,
    "toughness": None,
    "loyalty": None,
    "defense": None,
    "mana_value": 1.0,
    "color_identity": ["R"],
}


def test_golden_string_normal_card():
    assert embed_text(BOLT) == (
        "CARDNAME | Instant | CARDNAME deals 3 damage to any target. | "
        "keywords: - | stats: - | mv 1 | colors R"
    )


def test_self_name_becomes_cardname_including_short_form():
    card = dict(
        BOLT,
        name="Vito, Thorn of the Dusk Rose",
        oracle_text=(
            "Whenever you gain life, Vito, Thorn of the Dusk Rose deals that much damage. "
            "Vito attacks each combat."
        ),
    )
    text = embed_text(card)
    assert "Vito" not in text
    assert text.count("CARDNAME") >= 3  # name slot + two self-references


def test_reminder_text_is_stripped():
    card = dict(
        BOLT,
        name="Serra Angel",
        type_line="Creature — Angel",
        oracle_text=(
            "Flying (This creature can't be blocked except by creatures with flying.)\nVigilance"
        ),
        keywords=["Flying", "Vigilance"],
        power="4",
        toughness="4",
    )
    text = embed_text(card)
    assert "can't be blocked" not in text
    assert "keywords: Flying, Vigilance" in text
    assert "stats: 4/4" in text


def test_multiface_names_replaced():
    card = dict(
        BOLT,
        name="Fire // Ice",
        type_line="Instant // Instant",
        oracle_text="Fire deals 2 damage. // Tap target permanent. Ice draws a card.",
    )
    text = embed_text(card)
    assert "Fire deals" not in text
    assert "CARDNAME deals 2 damage" in text


def test_colorless_identity_is_c():
    card = dict(BOLT, name="Sol Ring", color_identity=[], oracle_text="{T}: Add {C}{C}.")
    assert embed_text(card).endswith("colors C")


def test_identity_in_wubrg_order():
    card = dict(BOLT, color_identity=["G", "U", "W"])
    assert embed_text(card).endswith("colors WUG")


def test_hash_stable_and_sensitive():
    text = embed_text(BOLT)
    assert embed_hash(text) == embed_hash(text)
    assert embed_hash(text) != embed_hash(text + " ")
