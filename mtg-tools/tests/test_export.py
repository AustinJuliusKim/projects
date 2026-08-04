"""Exporters and the CLI surface."""

from __future__ import annotations

import csv
import io as _io
import os
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import date
from decimal import Decimal

from binders import load, load_many, merge, tier_table, to_buylist_csv, to_ledger_csv
from binders.cli import main
from binders.export import BUYLIST_COLUMNS, LEDGER_COLUMNS, multi_copy_table, to_markdown

HERE = os.path.dirname(__file__)
FIXTURES = os.path.join(HERE, "fixtures")
SAMPLE = os.path.join(FIXTURES, "sample.csv")
SAMPLE2 = os.path.join(FIXTURES, "sample2.csv")


def _read(path):
    with open(path, newline="", encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


class TestBuylist(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, "buylist.csv")
        self.addCleanup(self.tmp.cleanup)

    def test_columns_and_ordering(self):
        to_buylist_csv(load_many(SAMPLE, SAMPLE2), self.path, min_price=0)
        rows = _read(self.path)
        self.assertEqual(list(rows[0].keys()), list(BUYLIST_COLUMNS))
        totals = [Decimal(r["Market total"]) for r in rows]
        self.assertEqual(totals, sorted(totals, reverse=True))

    def test_merges_before_writing(self):
        to_buylist_csv(load_many(SAMPLE, SAMPLE2), self.path, min_price=0)
        moxes = [r for r in _read(self.path) if r["Name"] == "Mox Amber"]
        self.assertEqual(len(moxes), 1)
        self.assertEqual(moxes[0]["Quantity"], "13")

    def test_min_price_drops_cheap_cards(self):
        returned = to_buylist_csv(load(SAMPLE), self.path, min_price=10)
        names = {r["Name"] for r in _read(self.path)}
        self.assertNotIn("Llanowar Elves", names)
        self.assertIn("Mox Amber", names)
        self.assertEqual(len(returned), len(_read(self.path)))

    def test_estimates_use_the_band_the_card_falls_in(self):
        to_buylist_csv(load(SAMPLE), self.path, min_price=0)
        row = next(r for r in _read(self.path) if r["Name"] == "Mox Amber")
        # 3 x 75.17 = 225.51, prime band -> 60% cash, 75% credit
        self.assertEqual(row["Market total"], "225.51")
        self.assertEqual(row["Est. cash"], "135.31")
        self.assertEqual(row["Est. credit"], "169.13")

    def test_foil_column_is_blank_for_non_foils(self):
        to_buylist_csv(load(SAMPLE), self.path, min_price=0)
        rows = {r["Name"]: r for r in _read(self.path)}
        self.assertEqual(rows["Mox Amber"]["Foil"], "")
        self.assertEqual(rows["Miirym, Sentinel Wyrm"]["Foil"], "foil")


class TestLedger(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, "ledger.csv")
        self.addCleanup(self.tmp.cleanup)

    def test_columns_match_the_vault_schema(self):
        to_ledger_csv(load(SAMPLE), self.path)
        self.assertEqual(list(_read(self.path)[0].keys()), list(LEDGER_COLUMNS))

    def test_tax_columns_are_left_blank_for_manual_reconstruction(self):
        to_ledger_csv(load(SAMPLE), self.path)
        row = _read(self.path)[0]
        for column in ("Cost Basis", "Sold", "Fees", "Net Proceeds", "Realized Gain/Loss"):
            self.assertEqual(row[column], "", column)

    def test_market_value_and_valuation_date_are_filled(self):
        to_ledger_csv(load(SAMPLE), self.path, valuation_date=date(2026, 7, 27))
        row = next(r for r in _read(self.path) if r["Name"] == "Mox Amber")
        self.assertEqual(row["Market Value"], "225.51")
        self.assertEqual(row["Valuation Date"], "2026-07-27")

    def test_insurance_flag_uses_the_threshold(self):
        to_ledger_csv(load(SAMPLE), self.path, insurance_threshold=100)
        rows = {r["Name"]: r for r in _read(self.path)}
        self.assertEqual(rows["Mox Amber"]["Insurance Flag"], "Y")  # $225.51
        self.assertEqual(rows["Llanowar Elves"]["Insurance Flag"], "")  # $1.10

    def test_source_records_the_binder(self):
        to_ledger_csv(load_many(SAMPLE, SAMPLE2), self.path)
        row = next(r for r in _read(self.path) if r["Name"] == "Mox Amber")
        self.assertEqual(row["Source"], "sample|sample2")


class TestMarkdown(unittest.TestCase):
    def test_pipe_table_shape(self):
        out = to_markdown([["a", "b"], ["c", "d"]], ["One", "Two"])
        lines = out.splitlines()
        self.assertEqual(lines[0], "| One | Two |")
        self.assertEqual(lines[1], "|---|---|")
        self.assertEqual(lines[2], "| a | b |")

    def test_tier_table_has_a_row_per_band_plus_total(self):
        out = tier_table(load_many(SAMPLE, SAMPLE2))
        lines = out.splitlines()
        self.assertEqual(len(lines), 6)  # header, rule, 3 bands, total
        self.assertIn("$20+ (prime)", out)
        self.assertIn("**Total**", out)

    def test_multi_copy_table_marks_quantities(self):
        out = multi_copy_table(load_many(SAMPLE, SAMPLE2), min_qty=4)
        self.assertIn("| Mox Amber | ×13 |", out)


class TestCli(unittest.TestCase):
    def _run(self, *argv):
        buffer = _io.StringIO()
        with redirect_stdout(buffer):
            code = main(list(argv))
        return code, buffer.getvalue()

    def test_summary(self):
        code, out = self._run("summary", SAMPLE, SAMPLE2)
        self.assertEqual(code, 0)
        self.assertIn("Total quantity", out)
        self.assertIn("By source (as scanned, before merging)", out)

    def test_summary_source_rows_sum_to_the_unmerged_total(self):
        _, out = self._run("summary", SAMPLE, SAMPLE2)
        # sample totals $431.57, sample2 $1,222.76 — neither is double counted,
        # even though Mox Amber appears in both.
        self.assertIn("$431.57", out)
        self.assertIn("$1,222.76", out)

    def test_tiers_markdown(self):
        code, out = self._run("tiers", SAMPLE, SAMPLE2, "--markdown")
        self.assertEqual(code, 0)
        self.assertTrue(out.startswith("| Tier |"))

    def test_dupes_finds_the_merged_stack(self):
        code, out = self._run("dupes", SAMPLE, SAMPLE2, "--min-qty", "10")
        self.assertEqual(code, 0)
        self.assertIn("x13", out)

    def test_top(self):
        code, out = self._run("top", SAMPLE, SAMPLE2, "-n", "1")
        self.assertEqual(code, 0)
        self.assertIn("Mox Amber", out)

    def test_filter_by_rarity(self):
        code, out = self._run("filter", SAMPLE, SAMPLE2, "--rarity", "common")
        self.assertEqual(code, 0)
        self.assertIn("Llanowar Elves", out)
        self.assertNotIn("Grim Monolith", out)

    def test_filter_to_a_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            out_path = os.path.join(tmp, "sel.csv")
            code, out = self._run(
                "filter", SAMPLE, SAMPLE2, "--price-min", "50", "-o", out_path
            )
            self.assertEqual(code, 0)
            self.assertTrue(os.path.exists(out_path))
            self.assertGreater(len(load(out_path)), 0)

    def test_diff(self):
        code, out = self._run("diff", SAMPLE, SAMPLE2, "--summary-only")
        self.assertEqual(code, 0)
        self.assertIn("net value", out)

    def test_validate_exit_code_is_zero_when_only_warnings(self):
        code, out = self._run("validate", SAMPLE)
        self.assertEqual(code, 0)
        self.assertIn("language", out)

    def test_missing_file_is_a_clean_error(self):
        with redirect_stderr(_io.StringIO()) as err:
            code, _ = self._run("summary", os.path.join(FIXTURES, "nope.csv"))
        self.assertEqual(code, 2)
        self.assertIn("no such file", err.getvalue())

    def test_merge_writes_a_reloadable_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            out_path = os.path.join(tmp, "all.csv")
            code, _ = self._run("merge", SAMPLE, SAMPLE2, "-o", out_path)
            self.assertEqual(code, 0)
            reloaded = load(out_path)
            self.assertEqual(reloaded.total_quantity, merge(load_many(SAMPLE, SAMPLE2)).total_quantity)


if __name__ == "__main__":
    unittest.main()
