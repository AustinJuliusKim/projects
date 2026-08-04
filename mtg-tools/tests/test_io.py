"""Parsing and round-trip fidelity."""

from __future__ import annotations

import os
import tempfile
import unittest
from datetime import datetime
from decimal import Decimal

from binders import load, load_many, save, validate
from binders.io import MANABOX_COLUMNS, parse_row, to_row
from binders.model import normalize_title
from tests.support import BINDERS, require_exports

HERE = os.path.dirname(__file__)
FIXTURES = os.path.join(HERE, "fixtures")
SAMPLE = os.path.join(FIXTURES, "sample.csv")
SAMPLE2 = os.path.join(FIXTURES, "sample2.csv")


class TestParsing(unittest.TestCase):
    def setUp(self):
        self.cards = load(SAMPLE)

    def test_row_count_and_source_tag(self):
        self.assertEqual(len(self.cards), 6)
        self.assertEqual(self.cards[0].sources, ("sample",))

    def test_prices_are_decimal_not_float(self):
        for card in self.cards:
            self.assertIsInstance(card.market_price, Decimal)

    def test_decimal_arithmetic_is_exact(self):
        total = self.cards.total_value
        self.assertIsInstance(total, Decimal)
        self.assertEqual(total, Decimal("431.57"))
        # The float sum reprs as 431.57 but is not actually 431.57 — it carries
        # a small error that grows with the collection. This is why nothing in
        # the package touches float.
        as_float = sum(float(c.market_price) * c.quantity for c in self.cards)
        self.assertNotEqual(Decimal(as_float), Decimal("431.57"))

    def test_collector_number_stays_a_string(self):
        altar = next(c for c in self.cards if c.title == "Ashnod's Altar")
        self.assertEqual(altar.collector_number, "140★")
        tithe = next(c for c in self.cards if c.title == "Smothering Tithe")
        self.assertEqual(tithe.collector_number, "22s")

    def test_numeric_foil_dialect(self):
        miirym = next(c for c in self.cards if c.title.startswith("Miirym"))
        self.assertTrue(miirym.foil)
        self.assertEqual(miirym.finish, "")  # numeric dialect leaves finish blank
        self.assertFalse(self.cards[0].foil)

    def test_word_foil_dialect(self):
        for token, expected_foil, expected_finish in [
            ("foil", True, "foil"),
            ("normal", False, "normal"),
            ("etched", True, "etched"),
            ("Etched Foil", True, "etched"),
        ]:
            card = parse_row({"Title": "X", "Foil": token, "Quantity": "1", "Purchase price": "1"})
            self.assertEqual(card.foil, expected_foil, token)
            self.assertEqual(card.finish, expected_finish, token)

    def test_etched_is_a_distinct_identity_from_foil(self):
        base = {"Title": "X", "Quantity": "1", "Purchase price": "1", "Scryfall ID": "abc"}
        etched = parse_row(dict(base, Foil="etched"))
        foil = parse_row(dict(base, Foil="foil"))
        self.assertNotEqual(etched.identity, foil.identity)

    def test_timestamp_parsed(self):
        card = self.cards[0]
        self.assertIsInstance(card.added, datetime)
        self.assertEqual(card.added.year, 2026)
        self.assertEqual(card.added.microsecond, 140000)

    def test_split_card_detected(self):
        split = next(c for c in self.cards if c.is_split)
        self.assertTrue(split.title.startswith("Search for Azcanta"))

    def test_display_name_marks_foils(self):
        miirym = next(c for c in self.cards if c.title.startswith("Miirym"))
        self.assertTrue(miirym.display_name.endswith("(foil)"))
        self.assertFalse(self.cards[0].display_name.endswith("(foil)"))

    def test_derived_values(self):
        mox = self.cards[0]
        self.assertEqual(mox.quantity, 3)
        self.assertEqual(mox.total_value, Decimal("225.51"))
        self.assertEqual(mox.tier, "prime")

    def test_bom_is_stripped(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "bom.csv")
            with open(SAMPLE, "rb") as src, open(path, "wb") as dst:
                dst.write(b"\xef\xbb\xbf" + src.read())
            cards = load(path)
            self.assertEqual(cards[0].title, "Mox Amber")

    def test_blank_and_malformed_values_do_not_crash(self):
        card = parse_row({"Title": "Weird", "Quantity": "", "Purchase price": "", "Added": ""})
        self.assertEqual(card.quantity, 1)
        self.assertEqual(card.market_price, Decimal("0"))
        self.assertIsNone(card.added)

    def test_currency_symbols_tolerated(self):
        card = parse_row({"Title": "X", "Quantity": "1", "Purchase price": "$1,234.56"})
        self.assertEqual(card.market_price, Decimal("1234.56"))


class TestIdentity(unittest.TestCase):
    def test_scryfall_id_preferred(self):
        card = parse_row(
            {"Title": "X", "Quantity": "1", "Purchase price": "1", "Scryfall ID": "abc", "Foil": "0"}
        )
        self.assertEqual(card.identity, ("abc", "normal"))

    def test_falls_back_to_name_when_scryfall_id_missing(self):
        row = {
            "Title": "Jötun Grunt",
            "Edition": "CSP",
            "Collector number": "15",
            "Quantity": "1",
            "Purchase price": "1",
            "Foil": "0",
        }
        card = parse_row(row)
        self.assertEqual(card.identity, ("jotun grunt", "csp", "15", "normal"))

    def test_fallback_identity_survives_accent_and_case_differences(self):
        base = {"Edition": "CSP", "Collector number": "15", "Quantity": "1", "Purchase price": "1"}
        a = parse_row(dict(base, Title="Jötun Grunt"))
        b = parse_row(dict(base, Title="jotun grunt"))
        self.assertEqual(a.identity, b.identity)


class TestNormalizeTitle(unittest.TestCase):
    def test_strips_accents_case_and_punctuation(self):
        self.assertEqual(normalize_title("Jötun Grunt"), "jotun grunt")
        self.assertEqual(normalize_title("Lim-Dûl's Vault"), "lim dul s vault")

    def test_front_face_only(self):
        title = "Invasion of Shandalar // Leyline Surge"
        self.assertEqual(normalize_title(title, front_only=True), "invasion of shandalar")
        self.assertIn("leyline", normalize_title(title))


class TestRoundTrip(unittest.TestCase):
    def _round_trip(self, path):
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "out.csv")
            save(load(path), out)
            with open(path, "rb") as fh:
                original = fh.read().lstrip(b"\xef\xbb\xbf")
            with open(out, "rb") as fh:
                written = fh.read()
        return original, written

    def test_fixture_round_trips_byte_for_byte(self):
        original, written = self._round_trip(SAMPLE)
        self.assertEqual(original, written)

    def test_header_order_is_preserved(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "out.csv")
            save(load(SAMPLE), out)
            with open(out, encoding="utf-8") as fh:
                header = fh.readline().rstrip("\r\n")
        self.assertEqual(header, ",".join(MANABOX_COLUMNS))

    def test_source_column_is_opt_in(self):
        with tempfile.TemporaryDirectory() as tmp:
            plain = os.path.join(tmp, "plain.csv")
            tagged = os.path.join(tmp, "tagged.csv")
            cards = load(SAMPLE)
            save(cards, plain)
            save(cards, tagged, include_sources=True)
            with open(plain, encoding="utf-8") as fh:
                self.assertNotIn("Source", fh.readline())
            with open(tagged, encoding="utf-8") as fh:
                self.assertIn("Source", fh.readline())

    def test_price_scale_is_preserved(self):
        card = parse_row({"Title": "X", "Quantity": "1", "Purchase price": "1.10"})
        self.assertEqual(to_row(card)["Purchase price"], "1.10")

    def test_extra_columns_survive(self):
        card = parse_row({"Title": "X", "Quantity": "1", "Purchase price": "1", "Deck": "Miirym"})
        self.assertEqual(card.extra, {"Deck": "Miirym"})
        self.assertEqual(to_row(card)["Deck"], "Miirym")

    def test_real_export_round_trips_if_present(self):
        """Byte-identity is only the right assertion for a current-dialect file.

        `save()` deliberately normalizes a legacy `Name,Set code,...` export to
        the current ManaBox header — that is a documented feature, and it means
        a legacy file cannot come back byte-identical. Asserting it anyway made
        this test fail the moment the Desktop exports were replaced with legacy
        ones, which is a bug in the test, not the code.

        So: byte-identity when the dialect already matches, and semantic
        round-trip either way.
        """
        require_exports(BINDERS)
        with open(BINDERS, "rb") as fh:
            head = fh.readline().decode("utf-8-sig")
        is_canonical = head.startswith("Title,")

        original, written = self._round_trip(BINDERS)
        if is_canonical:
            self.assertEqual(original, written)
        else:
            self.assertNotEqual(original, written)
            self.assertTrue(written.startswith(b"Title,"), "should normalize")

        # The cards must survive regardless of which header they arrived in.
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "again.csv")
            first = load(BINDERS)
            save(first, out)
            second = load(out, source=first[0].sources[0] if first else None)
            self.assertEqual(len(first), len(second))
            self.assertEqual(first.total_quantity, second.total_quantity)
            self.assertEqual(first.total_value, second.total_value)
            self.assertEqual(
                [c.identity for c in first], [c.identity for c in second]
            )


class TestLoadMany(unittest.TestCase):
    def test_rows_are_tagged_per_file_and_not_merged(self):
        cards = load_many(SAMPLE, SAMPLE2)
        self.assertEqual(len(cards), 10)
        self.assertEqual(set(cards.sources), {"sample", "sample2"})
        moxes = [c for c in cards if c.title == "Mox Amber"]
        self.assertEqual(len(moxes), 2)


class TestValidate(unittest.TestCase):
    def test_flags_non_english(self):
        issues = validate(load(SAMPLE))
        codes = {i.code for i in issues}
        self.assertIn("language", codes)
        message = next(i for i in issues if i.code == "language").message
        self.assertIn("Smothering Tithe", message)
        self.assertIn("100.80", message)

    def test_clean_rows_produce_no_issues(self):
        self.assertEqual(validate(load(SAMPLE2)), [])

    def test_flags_zero_price_and_bad_quantity(self):
        rows = [
            parse_row({"Title": "Free", "Quantity": "1", "Purchase price": "0"}),
            parse_row({"Title": "Nothing", "Quantity": "0", "Purchase price": "5"}),
        ]
        codes = {i.code for i in validate(rows)}
        self.assertIn("zero-price", codes)
        self.assertIn("bad-quantity", codes)

    def test_flags_duplicate_rows_within_one_file(self):
        row = {"Title": "X", "Quantity": "1", "Purchase price": "1", "Scryfall ID": "abc"}
        issues = validate([parse_row(row, source="f"), parse_row(row, source="f")])
        self.assertIn("duplicate-row", {i.code for i in issues})


if __name__ == "__main__":
    unittest.main()
