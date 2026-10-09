"""Suggested-price math — pure, no database."""

import pytest

from conftest import price_object
from tcg_pos_api.pricing import DEFAULT_RULE, apply_rule, pick_price, usd_reference


@pytest.mark.parametrize(
    "ref, condition, expected",
    [
        (124, "NM", 125),  # 124 -> up to the next quarter
        (1410, "NM", 1425),
        (1400, "NM", 1400),  # already a multiple: unchanged
        (1000, "LP", 900),
        (1000, "MP", 750),
        (1000, "HP", 600),
        (1000, "DMG", 400),
        (1001, "LP", 925),  # 900.9 -> 901 (half-up) -> 925
        (0, "NM", 25),  # floor
        (10, "DMG", 25),  # floor
    ],
)
def test_apply_default_rule(ref, condition, expected):
    assert apply_rule(ref, condition, DEFAULT_RULE) == expected


def test_apply_rule_half_up_and_no_rounding():
    rule = {**DEFAULT_RULE, "round_up_to_cents": 1, "min_price_cents": 0}
    assert apply_rule(5, "LP", rule) == 5  # 4.5 -> 5 (half up)
    assert apply_rule(4, "LP", rule) == 4  # 3.6 -> 4
    assert apply_rule(0, "NM", rule) == 0
    assert isinstance(apply_rule(999_999_999, "NM", {**rule, "nm_bp": 100_000}), int)


def test_usd_reference_prefers_tcgplayer_then_scryfall():
    p = price_object("x", "nonfoil", {"mtgjson_tcgplayer_retail_usd": 120,
                                      "scryfall_usd_trend_usd": 130})
    assert usd_reference(p) == ("mtgjson_tcgplayer_retail_usd", 120)
    p = price_object("x", "nonfoil", {"scryfall_usd_trend_usd": 130,
                                      "cardmarket_guide_trend_eur": 99})
    assert usd_reference(p) == ("scryfall_usd_trend_usd", 130)
    p = price_object("x", "nonfoil", {"cardmarket_guide_trend_eur": 99})
    assert usd_reference(p) == (None, None)


def test_pick_price_prefers_nm_in_lang_with_usd():
    eur_only = price_object("x", "foil", {"cardmarket_guide_trend_eur": 5}, sku_id=1)
    lp = price_object("x", "foil", {"scryfall_usd_trend_usd": 50}, sku_id=2, condition="LP")
    nm_ja = price_object("x", "foil", {"scryfall_usd_trend_usd": 70}, sku_id=3, lang="ja")
    nm_en = price_object("x", "foil", {"scryfall_usd_trend_usd": 60}, sku_id=4)
    assert pick_price([eur_only, lp, nm_ja, nm_en])["sku_id"] == 4
    assert pick_price([eur_only, lp, nm_ja, nm_en], "ja")["sku_id"] == 3
    assert pick_price([eur_only]) is None
    assert pick_price([]) is None
