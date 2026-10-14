"""Pure doc builders: card fields, catalog docs (headline price, digital
handling), listing docs (null price, qty 0, holdback-applied availability)."""

from fixtures_cards import card, printing, sample_rows
from tcg_search import docs


def _by_name(name):
    return next(r for r in sample_rows() if r["name"] == name)


def test_card_fields_basics():
    doc = docs.card_fields(_by_name("Lightning Bolt"))
    assert doc["name"] == "Lightning Bolt"
    assert doc["oracle_text"] == "cardname deals 3 damage to any target."
    assert doc["oracle_text_display"] == "Lightning Bolt deals 3 damage to any target."
    assert doc["nicknames"] == ["bolt"]
    assert doc["types"] == ["instant"]
    assert doc["legal"] == ["commander", "legacy", "modern", "vintage"]
    assert "banned" not in doc  # empty lists are dropped
    assert doc["popularity"] > 0
    assert doc["names_exact"] == ["Lightning Bolt"]
    assert doc["reserved"] is False


def test_card_fields_unranked_has_no_popularity_and_nulls_are_absent():
    doc = docs.card_fields(card("Obscure Card", edhrec_rank=None))
    assert "popularity" not in doc
    assert "edhrec_rank" not in doc
    assert "power" not in doc


def test_split_card_faces_and_colors():
    doc = docs.card_fields(_by_name("Fire // Ice"))
    assert doc["names_exact"] == ["Fire // Ice", "Fire", "Ice"]
    assert doc["face_names"] == ["Fire", "Ice"]
    assert doc["colors"] == ["U", "R"]
    assert doc["oracle_text"].startswith("cardname deals 2 damage")
    assert doc["oracle_text_display"].startswith("Fire deals 2 damage")
    assert [f["name"] for f in doc["faces"]] == ["Fire", "Ice"]
    assert doc["is_dfc"] is False  # split, not double-faced


def test_colors_from_faces_when_card_colors_null():
    row = card("Delver of Secrets // Insectile Aberration", colors=None, identity=("U",),
               layout="transform", type_line="Creature — Human Wizard // Creature — Human Insect",
               card_faces=[{"name": "Delver of Secrets", "colors": ["U"]},
                           {"name": "Insectile Aberration", "colors": ["U"]}])
    doc = docs.card_fields(row)
    assert doc["colors"] == ["U"] and doc["color_count"] == 1
    assert doc["is_dfc"] is True
    assert "Insectile Aberration" in doc["face_names"]


def test_catalog_doc_headline_is_min_nm_nonfoil_and_drops_digital():
    doc = docs.catalog_doc(_by_name("Lightning Bolt"))
    assert doc["price_cents"] == 150  # m11 nonfoil; lea is 45000, the digital one is dropped
    assert doc["price_source"] == "mtgjson_tcgplayer"
    assert doc["printing_count"] == 2
    assert {p["set"] for p in doc["printings"]} == {"lea", "m11"}
    assert doc["released_at"] == "1993-08-05" and doc["latest_released_at"] == "2010-07-16"
    assert doc["image_normal"].endswith("/m11/149/n.jpg")  # newest paper printing
    assert doc["digital_only"] is False


def test_catalog_doc_unpriced_is_null_not_zero():
    doc = docs.catalog_doc(_by_name("Fire // Ice"))
    assert "price_cents" not in doc and "price_source" not in doc
    assert "price_cents" not in doc["printings"][0]


def test_zero_price_is_missing():
    row = card("Free?", printings=[printing("Free?", "abc", "1", nonfoil=0)])
    assert "price_cents" not in docs.catalog_doc(row)


def test_digital_only_card():
    doc = docs.catalog_doc(_by_name("Digital Only Thing"))
    assert doc["digital_only"] is True
    assert doc["printing_count"] == 0
    assert "printings" not in doc


def test_headline_tie_prefers_tcgplayer():
    cents, source = docs.headline_price([
        {"price_cents": 100, "price_source": "scryfall_usd"},
        {"price_cents": 100, "price_source": "mtgjson_tcgplayer"},
        {"price_cents": None, "price_source": None},
    ])
    assert (cents, source) == (100, "mtgjson_tcgplayer")
    assert docs.headline_price([]) == (None, None)


# --- listings ---------------------------------------------------------------


def _offer(**kw):
    base = {"printing_id": "p1", "set_code": "m11", "set_name": "Magic 2011",
            "collector_number": "149", "rarity": "common", "finish": "nonfoil",
            "condition": "NM", "lang": "en", "price_cents": 199, "available": 2}
    base.update(kw)
    return base


def test_listing_doc_cheapest_offer_and_stock():
    row = _by_name("Lightning Bolt")
    doc = docs.listing_doc(row, "t1", [
        _offer(),
        _offer(printing_id="p2", condition="lp", price_cents=150, available=1),
    ])
    assert doc["tenant_id"] == "t1"
    assert doc["price_cents"] == 150
    assert doc["in_stock"] == 3 and doc["stock_depth"] == 3.0
    assert [o["condition"] for o in doc["offers"]] == ["NM", "LP"]
    assert [o["condition_rank"] for o in doc["offers"]] == [5, 4]
    assert doc["name"] == "Lightning Bolt" and doc["nicknames"] == ["bolt"]


def test_listing_unpriced_and_zero_qty_never_list():
    row = _by_name("Lightning Bolt")
    assert docs.offer_doc(_offer(price_cents=None)) is None
    assert docs.offer_doc(_offer(price_cents=0)) is None
    assert docs.offer_doc(_offer(available=0)) is None
    # Holdback already applied by the POS: available can arrive as 0.
    assert docs.listing_doc(row, "t1", [_offer(available=0), _offer(price_cents=None)]) is None
    doc = docs.listing_doc(row, "t1", [_offer(available=0), _offer(printing_id="p9")])
    assert [o["printing_id"] for o in doc["offers"]] == ["p9"]


def test_listing_id():
    assert docs.listing_id("t1", "o1") == "t1:o1"


def test_listing_doc_from_catalog_matches_card_fields_and_enriches_offers():
    row = _by_name("Lightning Bolt")
    cat = docs.catalog_doc(row)
    printings = cat["printings"]
    p0, p1 = printings[0]["printing_id"], printings[-1]["printing_id"]
    doc = docs.listing_doc_from_catalog(cat, "t1", [
        # A POS offer: no set metadata of its own; extra keys are ignored.
        {"inventory_item_id": "i1", "printing_id": p1, "game": "mtg", "condition": "LP",
         "finish": "foil", "lang": "en", "price_cents": 500, "available": 1},
        {"inventory_item_id": "i2", "printing_id": p0, "game": "mtg", "condition": "NM",
         "finish": "nonfoil", "lang": "ja", "price_cents": 300, "available": 2},
        {"printing_id": "not-this-card", "price_cents": 1, "available": 9},
        {"printing_id": p0, "price_cents": None, "available": 4},
    ], updated_at=None)
    # Card-level fields are exactly what the catalog has (minus images/extras).
    for k, v in docs.card_fields(row).items():
        if k not in ("image_small", "image_normal"):
            assert doc[k] == v, k
    assert "printings" not in doc and "printing_count" not in doc and "price_source" not in doc
    assert doc["tenant_id"] == "t1" and doc["price_cents"] == 300 and doc["in_stock"] == 3
    by_id = {o["printing_id"]: o for o in doc["offers"]}
    assert set(by_id) == {p0, p1}
    assert by_id[p0]["set"] == printings[0]["set"]
    assert by_id[p0]["set_name"] == printings[0]["set_name"]
    assert by_id[p0]["lang"] == "ja"  # the store's copy, not the printing's
    assert by_id[p1]["rarity"] == printings[-1]["rarity"]
    assert by_id[p1]["image_small"] == printings[-1]["image_small"]
    # The listing shows a printing the store has.
    assert doc["image_normal"] in {by_id[p0]["image_normal"], by_id[p1]["image_normal"]}

    # Nothing sellable (or nothing of this card) => None (caller deletes).
    assert docs.listing_doc_from_catalog(cat, "t1", [
        {"printing_id": p0, "price_cents": 100, "available": 0},
        {"printing_id": "other", "price_cents": 100, "available": 3},
    ]) is None
