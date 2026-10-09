"""TCGplayer CSV parsing — pure, no database."""

from pathlib import Path

import pytest

from tcg_pos_api import tcgplayer

FIXTURE = Path(__file__).parent / "fixtures" / "tcgplayer_inventory.csv"


@pytest.mark.parametrize(
    "text, expected",
    [
        ("Near Mint", ("NM", "nonfoil", "en")),
        ("Lightly Played Foil", ("LP", "foil", "en")),
        ("Near Mint Etched", ("NM", "etched", "en")),
        ("Near Mint Etched Foil", ("NM", "etched", "en")),
        ("Moderately Played", ("MP", "nonfoil", "en")),
        ("heavily played  foil", ("HP", "foil", "en")),
        ("Damaged", ("DMG", "nonfoil", "en")),
        ("Near Mint Foil - Japanese", ("NM", "foil", "ja")),
        ("Lightly Played - Chinese Simplified", ("LP", "nonfoil", "zhs")),
        ("Near Mint Non Foil", ("NM", "nonfoil", "en")),
    ],
)
def test_parse_condition(text, expected):
    assert tcgplayer.parse_condition(text) == expected


@pytest.mark.parametrize("text", ["Mint", "", "Near Mint Shiny", "Played", "Foil"])
def test_parse_condition_rejects_unknown(text):
    with pytest.raises(ValueError):
        tcgplayer.parse_condition(text)


def test_parse_cents_uses_decimal():
    assert tcgplayer.parse_cents("1.49") == 149
    assert tcgplayer.parse_cents("$4.99") == 499
    assert tcgplayer.parse_cents("1,012.50") == 101250
    assert tcgplayer.parse_cents("0.295") == 30  # half-up, no float drift
    assert tcgplayer.parse_cents("0.10") == 10
    assert tcgplayer.parse_cents("") is None
    for bad in ("abc", "-1.00", "NaN", "Infinity", "99999999999"):
        with pytest.raises(ValueError):
            tcgplayer.parse_cents(bad)


def test_normalise_number():
    assert tcgplayer.normalise_number("149/249") == "149"
    assert tcgplayer.normalise_number("0472") == "472"
    assert tcgplayer.normalise_number("0") == "0"
    assert tcgplayer.normalise_number("12a") == "12a"


def test_parse_fixture():
    rows = tcgplayer.parse_csv(FIXTURE.read_bytes())
    assert [r["row"] for r in rows] == list(range(2, 11))
    first = rows[0]
    assert first == {
        **first,
        "status": "parsed",
        "set_name": "Magic 2011",
        "number": "149",
        "condition": "NM",
        "finish": "nonfoil",
        "lang": "en",
        "qty": 3,
        "price_cents": 149,
    }
    assert rows[2]["finish"] == "etched" and rows[2]["price_cents"] == 101250
    assert rows[3]["status"] == "skipped"
    assert rows[4]["price_cents"] is None
    assert rows[5]["status"] == "parsed"
    assert rows[6]["status"] == "unmatched" and "condition" in rows[6]["reason"]
    assert rows[7]["set_name"] == "magic 2011"


def test_headers_are_tolerant():
    data = b"total  quantity,CONDITION, set name ,Number,Product Line\n2,Near Mint,M11,1,Magic\n"
    (row,) = tcgplayer.parse_csv(data)
    assert (row["qty"], row["condition"], row["set_name"], row["price_cents"]) == (
        2, "NM", "M11", None
    )


@pytest.mark.parametrize(
    "data, fragment",
    [
        (b"", "empty"),
        (b"Product Line,Set Name\nMagic,M11\n", "missing column"),
        (b"\xff\xfe\x00bad", "UTF-8"),
        (b"Product Line,Set Name,Number,Condition,Total Quantity\nMagic,M\x00,1,Near Mint,1\n",
         "NUL"),
    ],
)
def test_file_level_errors(data, fragment):
    with pytest.raises(tcgplayer.CsvError, match=fragment):
        tcgplayer.parse_csv(data)


def test_size_and_row_caps(monkeypatch):
    with pytest.raises(tcgplayer.CsvError, match="larger than"):
        tcgplayer.parse_csv(b"x" * (tcgplayer.MAX_BYTES + 1))
    monkeypatch.setattr(tcgplayer, "MAX_ROWS", 2)
    data = b"Product Line,Set Name,Number,Condition,Total Quantity\n" + (
        b"Magic,M11,1,Near Mint,1\n" * 3
    )
    with pytest.raises(tcgplayer.CsvError, match="more than 2 rows"):
        tcgplayer.parse_csv(data)


def test_bad_quantity_is_unmatched():
    data = b"Product Line,Set Name,Number,Condition,Total Quantity\nMagic,M11,1,Near Mint,-1\n"
    (row,) = tcgplayer.parse_csv(data)
    assert row["status"] == "unmatched" and "quantity" in row["reason"]
