"""Merging, filtering, tiering and diffing."""

from __future__ import annotations

import os
import unittest
from datetime import datetime, timezone
from decimal import Decimal

from binders import (
    diff,
    group_by,
    high_value,
    load,
    load_many,
    merge,
    multi_copies,
    price_tiers,
    summarize,
    top_n,
    where,
)
from binders.filters import any_of, is_rarity, negate, price_between
from binders.io import parse_row

HERE = os.path.dirname(__file__)
FIXTURES = os.path.join(HERE, "fixtures")
SAMPLE = os.path.join(FIXTURES, "sample.csv")
SAMPLE2 = os.path.join(FIXTURES, "sample2.csv")


class TestMerge(unittest.TestCase):
    def setUp(self):
        self.merged = merge(load_many(SAMPLE, SAMPLE2))

    def test_sums_quantities_across_files(self):
        mox = next(c for c in self.merged if c.title == "Mox Amber")
        self.assertEqual(mox.quantity, 13)  # 3 in sample + 10 in sample2

    def test_unions_sources(self):
        mox = next(c for c in self.merged if c.title == "Mox Amber")
        self.assertEqual(mox.sources, ("sample", "sample2"))

    def test_price_comes_from_the_most_recent_scan(self):
        # sample has 75.17 (June 26), sample2 has 74.00 (July 2).
        mox = next(c for c in self.merged if c.title == "Mox Amber")
        self.assertEqual(mox.market_price, Decimal("74.00"))
        self.assertEqual(mox.added.year, 2026)
        self.assertEqual(mox.added.month, 7)

    def test_foil_and_non_foil_stay_separate(self):
        elves = [c for c in self.merged if c.title == "Llanowar Elves"]
        self.assertEqual(len(elves), 2)
        self.assertEqual({c.foil for c in elves}, {True, False})

    def test_row_count_collapses_only_true_duplicates(self):
        self.assertEqual(len(self.merged), 9)  # 10 rows, one shared card

    def test_ordering_is_first_appearance(self):
        self.assertEqual(self.merged[0].title, "Mox Amber")

    def test_merging_is_idempotent(self):
        twice = merge(self.merged)
        self.assertEqual(len(twice), len(self.merged))
        self.assertEqual(twice.total_quantity, self.merged.total_quantity)


class TestFilters(unittest.TestCase):
    def setUp(self):
        self.cards = load_many(SAMPLE, SAMPLE2)

    def test_price_bounds(self):
        # Unmerged, so both Mox Amber rows count.
        self.assertEqual(len(where(self.cards, price_min=50)), 4)
        self.assertEqual(len(where(self.cards, price_max=2)), 2)

    def test_criteria_combine_with_and(self):
        hits = where(self.cards, price_min=1, rarity_in=["common"])
        self.assertEqual({c.title for c in hits}, {"Llanowar Elves"})

    def test_title_match_ignores_accents_and_case(self):
        self.assertEqual(len(where(self.cards, title_contains="jotun")), 1)

    def test_foil_filter(self):
        self.assertTrue(all(c.foil for c in where(self.cards, foil=True)))
        self.assertTrue(all(not c.foil for c in where(self.cards, foil=False)))

    def test_predicates_and_criteria_mix(self):
        hits = where(self.cards, negate(is_rarity("common")), price_max=10)
        self.assertNotIn("Llanowar Elves", {c.title for c in hits})

    def test_combinators(self):
        hits = where(self.cards, any_of(is_rarity("mythic"), price_between(400, None)))
        self.assertEqual({c.title for c in hits}, {"Mox Amber", "Grim Monolith"})

    def test_unknown_criterion_raises_rather_than_matching_everything(self):
        with self.assertRaises(TypeError):
            where(self.cards, prices_min=20)

    def test_none_valued_criteria_are_ignored(self):
        self.assertEqual(len(where(self.cards, price_min=None)), len(self.cards))

    def test_source_filter(self):
        self.assertEqual(len(where(self.cards, source_in=["sample2"])), 4)


class TestTiers(unittest.TestCase):
    def test_bands_do_not_overlap_and_cover_everything(self):
        cards = merge(load_many(SAMPLE, SAMPLE2))
        rows = price_tiers(cards)
        self.assertEqual(
            sum(r.quantity for r in rows.values()), cards.total_quantity
        )
        self.assertEqual(
            sum(r.market_value for r in rows.values()), cards.total_value
        )

    def test_boundary_prices_land_in_the_higher_band(self):
        rows = price_tiers([
            parse_row({"Title": "At20", "Quantity": "1", "Purchase price": "20.00"}),
            parse_row({"Title": "Just under", "Quantity": "1", "Purchase price": "19.99"}),
            parse_row({"Title": "At5", "Quantity": "1", "Purchase price": "5.00"}),
            parse_row({"Title": "Under5", "Quantity": "1", "Purchase price": "4.99"}),
        ])
        self.assertEqual(rows["prime"].quantity, 1)
        self.assertEqual(rows["mid"].quantity, 2)
        self.assertEqual(rows["bulk"].quantity, 1)

    def test_cash_and_credit_use_the_vault_rates(self):
        rows = price_tiers([
            parse_row({"Title": "X", "Quantity": "1", "Purchase price": "100.00"})
        ])
        self.assertEqual(rows["prime"].cash, Decimal("60.00"))
        self.assertEqual(rows["prime"].credit, Decimal("75.00"))


class TestFlags(unittest.TestCase):
    def test_multi_copies_finds_stacks_only_visible_after_merging(self):
        # 3 copies in one file and 10 in the other: neither file shows a x13.
        stacks = multi_copies(load_many(SAMPLE, SAMPLE2), min_qty=10)
        self.assertEqual([c.title for c in stacks], ["Mox Amber"])
        self.assertEqual(stacks[0].quantity, 13)

    def test_multi_copies_sorted_by_value(self):
        stacks = multi_copies(load_many(SAMPLE, SAMPLE2), min_qty=2)
        values = [c.total_value for c in stacks]
        self.assertEqual(values, sorted(values, reverse=True))

    def test_high_value_threshold_is_inclusive(self):
        hits = high_value(load(SAMPLE), threshold=15.16)
        self.assertIn("Ashnod's Altar", {c.title for c in hits})

    def test_top_n(self):
        top = top_n(merge(load_many(SAMPLE, SAMPLE2)), n=2)
        self.assertEqual(len(top), 2)
        self.assertEqual(top[0].total_value, Decimal("962.00"))  # Mox Amber x13 @ 74

    def test_top_n_on_unmerged_rows_ranks_rows_not_cards(self):
        # Worth pinning: the same call without merge() sees a x10 stack, not x13.
        top = top_n(load_many(SAMPLE, SAMPLE2), n=1)
        self.assertEqual(top[0].total_value, Decimal("740.00"))


class TestSummary(unittest.TestCase):
    def test_totals(self):
        s = summarize(load(SAMPLE))
        self.assertEqual(s.rows, 6)
        self.assertEqual(s.quantity, 17)
        self.assertEqual(s.total_value, Decimal("431.57"))
        self.assertEqual(s.max_price, Decimal("75.17"))

    def test_rarity_breakdown_sums_to_the_total(self):
        s = summarize(load(SAMPLE))
        self.assertEqual(sum(q for q, _ in s.by_rarity.values()), s.quantity)
        self.assertEqual(sum(v for _, v in s.by_rarity.values()), s.total_value)

    def test_empty_collection(self):
        s = summarize([])
        self.assertEqual(s.rows, 0)
        self.assertEqual(s.total_value, Decimal("0.00"))

    def test_group_by_orders_by_value(self):
        groups = group_by(load_many(SAMPLE, SAMPLE2), "rarity")
        values = [g.total_value for g in groups.values()]
        self.assertEqual(values, sorted(values, reverse=True))


class TestDiff(unittest.TestCase):
    def test_detects_adds_removes_and_changes(self):
        result = diff(load(SAMPLE), load(SAMPLE2))
        self.assertIn("Grim Monolith", {c.title for c in result.added})
        self.assertIn("Ashnod's Altar", {c.title for c in result.removed})

    def test_quantity_change_is_reported_once(self):
        result = diff(load(SAMPLE), load(SAMPLE2))
        moved = [c for c in result.quantity_changed if c.name == "Mox Amber"]
        self.assertEqual(len(moved), 1)
        self.assertEqual(moved[0].quantity_delta, 7)  # 3 -> 10
        self.assertNotIn("Mox Amber", {c.name for c in result.price_changed})

    def test_identical_collections_diff_to_nothing(self):
        result = diff(load(SAMPLE), load(SAMPLE))
        self.assertTrue(result.is_empty())
        self.assertEqual(result.value_delta, Decimal("0.00"))
        self.assertEqual(result.quantity_delta, 0)

    def test_value_delta_reconciles(self):
        old, new = load(SAMPLE), load(SAMPLE2)
        result = diff(old, new)
        self.assertEqual(result.value_delta, new.total_value - old.total_value)

    def test_splitting_a_file_in_two_is_not_a_change(self):
        cards = list(load_many(SAMPLE, SAMPLE2))
        result = diff(cards, cards[:5] + cards[5:])
        self.assertTrue(result.is_empty())


if __name__ == "__main__":
    unittest.main()
