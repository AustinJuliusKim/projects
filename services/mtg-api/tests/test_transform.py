"""Row shaping and hash stability over the real-card fixtures."""

import copy
import json
from pathlib import Path

from mtg_api.ingest import transform

FIXTURES = Path(__file__).resolve().parent / "fixtures"


def load_jsonl(name):
    with open(FIXTURES / name, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


ORACLE = load_jsonl("oracle_sample.jsonl")
BY_LAYOUT = {}
for c in ORACLE:
    BY_LAYOUT.setdefault(c.get("layout"), c)


def by_name(name):
    return next(c for c in ORACLE if c["name"].startswith(name))


def test_skip_layouts_produce_no_rows():
    for layout in transform.SKIP_LAYOUTS:
        card = BY_LAYOUT.get(layout)
        assert card is not None, f"fixture missing layout {layout}"
        assert transform.card_row(card) is None
        assert transform.printing_row(card) is None


def test_normal_card_row():
    row = transform.card_row(by_name("Lightning Bolt"))
    assert row["oracle_id"]
    assert row["mana_value"] == 1
    assert "3 damage" in row["oracle_text"]
    assert row["content_hash"]


def test_reversible_card_takes_oracle_id_from_first_face():
    card = BY_LAYOUT["reversible_card"]
    assert card.get("oracle_id") is None
    row = transform.card_row(card)
    assert row is not None
    assert row["oracle_id"] == card["card_faces"][0]["oracle_id"]


def test_multiface_text_is_joined():
    card = BY_LAYOUT["modal_dfc"]
    assert card.get("oracle_text") is None
    row = transform.card_row(card)
    assert " // " in row["oracle_text"]
    face_text = card["card_faces"][0]["oracle_text"]
    assert face_text.split("\n")[0] in row["oracle_text"]


def test_slim_faces_drop_image_and_artist_noise():
    card = BY_LAYOUT["transform"]
    row = transform.card_row(card)
    assert row["card_faces"]
    for face in row["card_faces"]:
        assert set(face) <= set(transform.FACE_FIELDS)


def test_content_hash_is_stable_and_sensitive():
    card = by_name("Sanguine Bond")
    assert transform.card_row(card)["content_hash"] == transform.card_row(card)["content_hash"]
    errata = copy.deepcopy(card)
    errata["oracle_text"] = card["oracle_text"] + " (errata)"
    assert transform.card_row(errata)["content_hash"] != transform.card_row(card)["content_hash"]


def test_printing_hash_excludes_prices():
    card = by_name("Lightning Bolt")
    repriced = copy.deepcopy(card)
    repriced["prices"] = {"usd": "999.99", "usd_foil": None, "eur": None, "tix": None}
    assert (
        transform.printing_row(card)["content_hash"]
        == transform.printing_row(repriced)["content_hash"]
    )
    assert transform.prices_row(repriced)["price_usd"] == "999.99"


def test_printing_row_uses_face_images_when_top_level_missing():
    card = BY_LAYOUT["transform"]
    assert card.get("image_uris") is None
    row = transform.printing_row(card)
    assert row["image_normal"]


def test_ruling_row_hashes_comment():
    rulings = load_jsonl("rulings_sample.jsonl")
    assert rulings
    row = transform.ruling_row(rulings[0])
    assert row["oracle_id"]
    assert row["comment_hash"] == transform.ruling_row(rulings[0])["comment_hash"]
