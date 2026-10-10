import pytest

from tcg_search import cardtext


@pytest.mark.parametrize(
    "type_line, expected",
    [
        ("Instant", {"supertypes": [], "types": ["instant"], "subtypes": []}),
        (
            "Legendary Creature — Elf Druid",
            {"supertypes": ["legendary"], "types": ["creature"], "subtypes": ["elf", "druid"]},
        ),
        (
            "Creature — Human Wizard // Creature — Human Insect",
            {"supertypes": [], "types": ["creature"], "subtypes": ["human", "wizard", "insect"]},
        ),
        ("Basic Snow Land — Island",
         {"supertypes": ["basic", "snow"], "types": ["land"], "subtypes": ["island"]}),
        ("Kindred Artifact — Lhurgoyf",
         {"supertypes": [], "types": ["kindred", "artifact"], "subtypes": ["lhurgoyf"]}),
        (None, {"supertypes": [], "types": [], "subtypes": []}),
    ],
)
def test_parse_type_line(type_line, expected):
    assert cardtext.parse_type_line(type_line) == expected


def test_face_names_split_and_dfc():
    assert cardtext.face_names("Fire // Ice", [{"name": "Fire"}, {"name": "Ice"}]) == [
        "Fire // Ice", "Fire", "Ice"
    ]
    # Faces missing from card_faces still come from the " // " name.
    assert cardtext.face_names("Fire // Ice", None) == ["Fire // Ice", "Fire", "Ice"]
    assert cardtext.face_names("Sol Ring", None) == ["Sol Ring"]


def test_substitute_cardname_whole_words_only():
    text = "Lightning Bolt deals 3 damage to any target. Lightning Bolts are fun."
    assert cardtext.substitute_cardname(text, ["Lightning Bolt"]) == (
        "cardname deals 3 damage to any target. Lightning Bolts are fun."
    )


def test_substitute_cardname_legendary_short_name_and_faces():
    names = ["Uro, Titan of Nature's Wrath"]
    text = "When Uro enters, sacrifice it unless it escaped."
    assert cardtext.substitute_cardname(text, names, "Legendary Creature — Elder Giant") == (
        "When cardname enters, sacrifice it unless it escaped."
    )
    # Not legendary: the short name is left alone.
    assert "Uro" in cardtext.substitute_cardname(text, names, "Creature — Giant")


def test_rules_text_joins_faces_when_no_top_level_text():
    faces = [{"name": "Fire", "oracle_text": "Fire deals 2 damage divided as you choose."},
             {"name": "Ice", "oracle_text": "Tap target permanent.\nDraw a card."}]
    out = cardtext.rules_text(None, faces, ["Fire // Ice", "Fire", "Ice"], "Instant // Instant")
    assert out.startswith("cardname deals 2 damage")
    assert out.endswith("Draw a card.")


@pytest.mark.parametrize(
    "rank, expected",
    [(None, None), (0, None), (1, 19607.843), (950, 1000.0), (10**9, 1.0)],
)
def test_popularity_positive_floor_and_null(rank, expected):
    assert cardtext.popularity(rank) == expected


@pytest.mark.parametrize(
    "text, expected",
    [
        ("Fire // Ice", "fireice"),
        ("fire ice", "fireice"),
        ("Lim-Dûl's Vault", "limdulsvault"),
        ("Æther Vial", "aethervial"),
        ("Jötun Grunt", "jotungrunt"),
        ("T3Feri", "t3feri"),
    ],
)
def test_compact(text, expected):
    assert cardtext.compact(text) == expected


def test_short_names_legendary_only():
    assert cardtext.short_names(["Kenrith, the Returned King"], "Legendary Creature — Human") == [
        "Kenrith"
    ]
    assert cardtext.short_names(["Kenrith's Transformation"], "Enchantment — Aura") == []
    assert cardtext.short_names(["Boil, Toil"], "Instant") == []


@pytest.mark.parametrize("v, expected", [("3", 3.0), ("1.5", 1.5), ("*", None), ("1+*", None),
                                         (None, None), ("X", None)])
def test_numeric_stat(v, expected):
    assert cardtext.numeric_stat(v) == expected


def test_sort_colors_wubrg_order():
    assert cardtext.sort_colors(["G", "W", "R", "W"]) == ["W", "R", "G"]
