"""Sealed commander decks: catalog integrity, resolution, money, diff.

Every test here is offline. `catalog.refresh` takes an injectable fetcher, so the
network path is exercised against a fixture rather than skipped — `run_tests.py`
fails on any skip that isn't "ManaBox exports absent", so a network-gated test
would break the guard instead of quietly opting out.
"""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from datetime import date
from decimal import Decimal

from binders.catalog import (
    Catalog,
    extract_decks,
    load_catalog,
    nickname,
    refresh,
    serialize,
)
from binders.sealed import (
    KNOWN_CONDITIONS,
    MATCH_AMBIGUOUS,
    MATCH_EXACT,
    MATCH_NICKNAME,
    MATCH_SUFFIX,
    MATCH_UNMATCHED,
    MATCH_UUID,
    SEALED_COLUMNS,
    TEMPLATE_ROWS,
    SealedHolding,
    diff_sealed,
    load_sealed,
    resolve,
    save_sealed,
    summarize_sealed,
    template_csv,
)

HERE = os.path.dirname(__file__)
FIXTURES = os.path.join(HERE, "fixtures")
SEALED_SAMPLE = os.path.join(FIXTURES, "sealed_sample.csv")
SETLIST_FIXTURE = os.path.join(FIXTURES, "setlist_trimmed.json")


def _fixture_setlist() -> dict:
    with open(SETLIST_FIXTURE, encoding="utf-8") as fh:
        return json.load(fh)


class TestVendoredCatalog(unittest.TestCase):
    """The committed catalog is what makes everything else work offline."""

    @classmethod
    def setUpClass(cls):
        cls.catalog = load_catalog()

    def test_expected_size(self):
        # 220 commander decks, Commander 2011 through mid-2026.
        self.assertEqual(len(self.catalog), 220)

    def test_uuids_are_present_and_unique(self):
        uuids = [d.uuid for d in self.catalog]
        self.assertTrue(all(uuids))
        self.assertEqual(len(uuids), len(set(uuids)))

    def test_every_deck_has_a_name_and_set(self):
        for deck in self.catalog:
            with self.subTest(deck=deck.uuid):
                self.assertTrue(deck.name)
                self.assertTrue(deck.set_code)
                self.assertRegex(deck.release_date, r"^\d{4}-\d{2}-\d{2}$")

    def test_vendor_ids_are_mostly_present(self):
        """Not all decks have every ID, but TCGplayer coverage should be high."""
        with_tcg = [d for d in self.catalog if d.ids.get("tcgplayerProductId")]
        self.assertGreater(len(with_tcg) / len(self.catalog), 0.9)

    def test_the_eight_known_collisions(self):
        """These nicknames are shared by an original deck and a later reprint.

        They are the reason resolution reports ambiguity instead of guessing:
        the two printings can differ several-fold in price.
        """
        ambiguous = self.catalog.ambiguous_nicknames()
        self.assertEqual(len(ambiguous), 8)
        expected = {
            "breed lethality", "built from scratch", "devour for power",
            "evasive maneuvers", "guided by nature", "heavenly inferno",
            "plunder the graves", "wade into battle",
        }
        self.assertEqual(set(ambiguous), expected)
        for nick, decks in ambiguous.items():
            with self.subTest(nick=nick):
                self.assertEqual(len(decks), 2)
                self.assertEqual(len({d.set_code for d in decks}), 2)

    def test_collectors_editions_are_distinct_products(self):
        ce = [d for d in self.catalog if d.is_collectors_edition]
        self.assertEqual(len(ce), 16)
        # Each CE must have a base sibling that is a *different* product.
        for deck in ce:
            with self.subTest(deck=deck.name):
                base = deck.name.replace("Collectors Edition", "").replace(
                    "Collector's Edition", ""
                ).strip()
                siblings = self.catalog.by_name(base)
                if siblings:
                    self.assertNotEqual(siblings[0].uuid, deck.uuid)

    def test_lookup_by_uuid(self):
        deck = self.catalog.decks[0]
        self.assertIs(self.catalog.by_uuid(deck.uuid), deck)
        self.assertIsNone(self.catalog.by_uuid("nope"))

    def test_search_is_accent_and_case_insensitive(self):
        self.assertTrue(self.catalog.search("WARHAMMER"))
        self.assertEqual(len(self.catalog.search("")), len(self.catalog))


class TestNickname(unittest.TestCase):
    def test_strips_set_and_filler(self):
        self.assertEqual(
            nickname(
                "Duskmourn House of Horror Commander Deck Death Toll",
                "Duskmourn: House of Horror Commander",
            ),
            "death toll",
        )

    def test_collectors_edition_stays_in_the_nickname(self):
        """If CE dropped out, a CE deck would collapse onto its base product."""
        base = nickname("Marvel Super Heroes Commander Deck Wakanda Forever",
                        "Marvel Super Heroes Commander")
        ce = nickname("Marvel Super Heroes Commander Deck Wakanda Forever Collector's Edition",
                      "Marvel Super Heroes Commander")
        self.assertNotEqual(base, ce)
        self.assertIn("collector", ce)


class TestExtract(unittest.TestCase):
    def setUp(self):
        self.decks = extract_decks(_fixture_setlist())

    def test_only_commander_decks_survive_the_filter(self):
        self.assertEqual(len(self.decks), 32)
        names = {d.name for d in self.decks}
        self.assertNotIn("Commander 2011 Booster Box", names)
        self.assertNotIn("Commander 2011 Theme Deck Fake", names)
        self.assertNotIn("Commander 2011 Duel Deck Fake", names)

    def test_sorted_by_release_then_name(self):
        keys = [(d.release_date, d.name) for d in self.decks]
        self.assertEqual(keys, sorted(keys))

    def test_vendor_ids_are_carried(self):
        deck = next(d for d in self.decks if "Sneak Attack" in d.name)
        self.assertIn("tcgplayerProductId", deck.ids)

    def test_empty_setlist_yields_nothing(self):
        self.assertEqual(extract_decks({"data": []}), [])


class TestRefresh(unittest.TestCase):
    """The one networked function, exercised with an injected fetcher."""

    def _fetch(self, url):
        with open(SETLIST_FIXTURE, "rb") as fh:
            return fh.read()

    def test_writes_and_reports_additions(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = os.path.join(tmp, "cat.json")
            decks, added, removed = refresh(target, fetch=self._fetch)
            self.assertEqual(len(decks), 32)
            self.assertEqual(len(added), 32)  # from nothing
            self.assertEqual(removed, [])
            self.assertEqual(len(load_catalog(target)), 32)

    def test_second_run_reports_no_change(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = os.path.join(tmp, "cat.json")
            refresh(target, fetch=self._fetch)
            _, added, removed = refresh(target, fetch=self._fetch)
            self.assertEqual((added, removed), ([], []))

    def test_dry_run_does_not_write(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = os.path.join(tmp, "cat.json")
            refresh(target, fetch=self._fetch, write=False)
            self.assertFalse(os.path.exists(target))

    def test_refuses_to_overwrite_with_an_empty_result(self):
        """A bad fetch must not blank the catalog the whole package depends on."""
        def empty(url):
            return b'{"data": []}'

        with tempfile.TemporaryDirectory() as tmp:
            target = os.path.join(tmp, "cat.json")
            refresh(target, fetch=self._fetch)
            with open(target, encoding="utf-8") as fh:
                before = fh.read()
            with self.assertRaises(ValueError):
                refresh(target, fetch=empty)
            with open(target, encoding="utf-8") as fh:
                self.assertEqual(fh.read(), before)

    def test_serialize_round_trips(self):
        decks = extract_decks(_fixture_setlist())
        with tempfile.TemporaryDirectory() as tmp:
            target = os.path.join(tmp, "cat.json")
            with open(target, "w", encoding="utf-8") as fh:
                fh.write(serialize(decks))
            reloaded = load_catalog(target)
            self.assertEqual([d.uuid for d in reloaded], [d.uuid for d in decks])
            self.assertEqual([dict(d.ids) for d in reloaded], [dict(d.ids) for d in decks])


class TestResolution(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.catalog = load_catalog()

    def _one(self, name, set_hint=""):
        holdings, issues = resolve(
            [SealedHolding(raw_name=name, set_hint=set_hint)], self.catalog
        )
        return holdings[0], issues

    def test_full_official_name_resolves(self):
        h, _ = self._one("Zendikar Rising Commander Deck Sneak Attack")
        self.assertEqual(h.match, MATCH_EXACT)
        self.assertEqual(h.deck.set_code, "ZNC")

    def test_every_official_name_resolves(self):
        for deck in self.catalog:
            with self.subTest(deck=deck.name):
                h, _ = self._one(deck.name)
                self.assertIsNotNone(h.deck)
                self.assertEqual(h.deck.uuid, deck.uuid)

    def test_bare_nickname_resolves(self):
        h, _ = self._one("Sneak Attack")
        self.assertEqual(h.match, MATCH_NICKNAME)
        self.assertEqual(h.deck.set_code, "ZNC")

    def test_uuid_resolves(self):
        deck = self.catalog.decks[0]
        h, _ = self._one(deck.uuid)
        self.assertEqual(h.match, MATCH_UUID)
        self.assertEqual(h.deck.uuid, deck.uuid)

    def test_suffix_match_handles_a_set_prefix_left_in_the_nickname(self):
        """25 of 220 products keep a set prefix, because the set is named
        "Warhammer 40,000" while the product says "Warhammer 40000"."""
        h, _ = self._one("Forces of the Imperium")
        self.assertEqual(h.match, MATCH_SUFFIX)
        self.assertEqual(h.deck.set_code, "40K")
        self.assertFalse(h.deck.is_collectors_edition)

    def test_collision_is_reported_not_guessed(self):
        h, issues = self._one("Heavenly Inferno")
        self.assertEqual(h.match, MATCH_AMBIGUOUS)
        self.assertIsNone(h.deck)
        self.assertEqual(len(h.candidates), 2)
        self.assertEqual({d.set_code for d in h.candidates}, {"CMD", "CMA"})
        self.assertIn("ambiguous", {i.code for i in issues})

    def test_a_set_hint_breaks_the_collision(self):
        for code, year in (("CMD", "2011"), ("CMA", "2017")):
            with self.subTest(code=code):
                h, _ = self._one("Heavenly Inferno", code)
                self.assertIsNotNone(h.deck)
                self.assertEqual(h.deck.set_code, code)
                self.assertEqual(h.deck.year, year)

    def test_every_collision_resolves_once_pinned(self):
        for nick, decks in self.catalog.ambiguous_nicknames().items():
            for deck in decks:
                with self.subTest(nick=nick, set=deck.set_code):
                    h, _ = self._one(nick, deck.set_code)
                    self.assertEqual(h.deck.uuid, deck.uuid)

    def test_base_deck_never_resolves_to_the_collectors_edition(self):
        h, issues = self._one("Wakanda Forever")
        self.assertIsNotNone(h.deck)
        self.assertFalse(h.deck.is_collectors_edition)
        # ...but the user is told the pricier variant exists.
        self.assertIn("collectors-edition-exists", {i.code for i in issues})

    def test_collectors_edition_resolves_on_its_own(self):
        h, _ = self._one("Wakanda Forever Collector's Edition")
        self.assertIsNotNone(h.deck)
        self.assertTrue(h.deck.is_collectors_edition)

    def test_every_display_string_round_trips(self):
        """`doctor` prints its suggestions as `Deck.display` — `Name [SET]` —
        so pasting one into the Name column is the intended one-edit repair.
        Every such string therefore has to resolve to the deck it names.

        It used to resolve to nothing: `_norm` turns the brackets into spaces,
        leaving the set code as a trailing word that matches no name and no
        nickname, so doctor re-suggested the exact string it had just rejected.
        """
        for deck in self.catalog:
            with self.subTest(deck=deck.display):
                h, _ = self._one(deck.display)
                self.assertIsNotNone(h.deck, f"{deck.display} did not resolve")
                self.assertEqual(h.deck.uuid, deck.uuid)

    def test_a_display_suffix_does_not_collapse_a_deck_into_its_ce_sibling(self):
        """The suffix is stripped for lookup, so the Collector's Edition guard
        has to keep holding across it."""
        h, _ = self._one("Warhammer 40000 Commander Deck Necron Dynasties [40K]")
        self.assertIsNotNone(h.deck)
        self.assertFalse(h.deck.is_collectors_edition)

    def test_a_display_suffix_disambiguates_a_collision(self):
        """`[SET]` stands in as a set hint when the Set column is empty."""
        for code in ("CMD", "CMA"):
            with self.subTest(code=code):
                h, _ = self._one(f"Heavenly Inferno [{code}]")
                self.assertIsNotNone(h.deck)
                self.assertEqual(h.deck.set_code, code)

    def test_the_set_column_outranks_a_display_suffix(self):
        """Two set codes on one row is a contradiction; the explicit column is
        the one the user edited on purpose."""
        h, _ = self._one("Heavenly Inferno [CMD]", "CMA")
        self.assertIsNotNone(h.deck)
        self.assertEqual(h.deck.set_code, "CMA")

    def test_an_unknown_bracketed_code_is_left_on_the_name(self):
        """Only a real set code is treated as a display suffix — a name that
        merely ends in brackets is not quietly rewritten."""
        h, _ = self._one("Sneak Attack [NOTASET]")
        self.assertEqual(h.match, MATCH_UNMATCHED)

    def test_unmatched_is_reported_with_suggestions(self):
        h, issues = self._one("Forces of the Imperiumm")
        unmatched = [i for i in issues if i.code == "unmatched"]
        if h.match == MATCH_UNMATCHED:
            self.assertTrue(unmatched)
            self.assertIn("did you mean", unmatched[0].message)

    def test_total_nonsense_is_unmatched(self):
        h, issues = self._one("Definitely Not A Magic Product 12345")
        self.assertEqual(h.match, MATCH_UNMATCHED)
        self.assertIsNone(h.deck)
        self.assertIn("unmatched", {i.code for i in issues})

    def test_a_wrong_set_hint_falls_back_rather_than_unmatching(self):
        """A typo'd set is likelier than a reason to discard every candidate."""
        h, _ = self._one("Sneak Attack", "ZZZ")
        self.assertIsNotNone(h.deck)
        self.assertEqual(h.deck.set_code, "ZNC")

    def test_empty_name_is_an_error(self):
        _, issues = self._one("")
        self.assertIn("no-name", {i.code for i in issues})


class TestSealedIo(unittest.TestCase):
    def setUp(self):
        self.holdings, self.issues = resolve(load_sealed(SEALED_SAMPLE))

    def test_loads_every_row_with_line_numbers(self):
        self.assertEqual(len(self.holdings), 7)
        self.assertEqual([h.line for h in self.holdings], list(range(2, 9)))

    def test_prices_are_decimal(self):
        priced = [h for h in self.holdings if h.price is not None]
        self.assertTrue(priced)
        for h in priced:
            self.assertIsInstance(h.price, Decimal)

    def test_dates_parse(self):
        h = next(h for h in self.holdings if "Sneak Attack" in h.display)
        self.assertEqual(h.price_date, date(2026, 7, 27))

    def test_missing_price_is_none_not_zero(self):
        h = next(h for h in self.holdings if "Wakanda" in h.display)
        self.assertIsNone(h.price)
        self.assertFalse(h.has_price)
        self.assertEqual(h.total_value, Decimal("0"))

    def test_round_trip(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "s.csv")
            save_sealed(self.holdings, out)
            again = load_sealed(out)
            self.assertEqual(len(again), len(self.holdings))
            self.assertEqual(
                [h.price for h in again], [h.price for h in self.holdings]
            )
            self.assertEqual(
                [h.quantity for h in again], [h.quantity for h in self.holdings]
            )

    def test_pin_sets_fills_the_set_column_for_resolved_rows(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "s.csv")
            save_sealed(self.holdings, out, pin_sets=True)
            reloaded, _ = resolve(load_sealed(out))
            # The row that was ambiguous stays ambiguous; it never resolved, so
            # there is no set to pin.
            still_ambiguous = [h for h in reloaded if h.match == MATCH_AMBIGUOUS]
            self.assertEqual(len(still_ambiguous), 1)
            # Everything that did resolve now carries an explicit set.
            for h in reloaded:
                if h.resolved:
                    self.assertTrue(h.set_hint, h.display)


class TestIssues(unittest.TestCase):
    def setUp(self):
        self.holdings, self.issues = resolve(load_sealed(SEALED_SAMPLE))
        self.codes = {i.code for i in self.issues}

    def test_flags_the_undated_price(self):
        self.assertIn("no-price-date", self.codes)

    def test_flags_the_missing_price(self):
        self.assertIn("no-price", self.codes)

    def test_flags_the_unmatched_row(self):
        self.assertIn("unmatched", self.codes)

    def test_flags_the_ambiguous_row(self):
        self.assertIn("ambiguous", self.codes)

    def test_unknown_condition_is_flagged(self):
        rows = [SealedHolding(raw_name="Sneak Attack", condition="mint-ish")]
        _, issues = resolve(rows)
        self.assertIn("condition", {i.code for i in issues})

    def test_known_conditions_pass(self):
        for condition in KNOWN_CONDITIONS:
            with self.subTest(condition=condition):
                rows = [SealedHolding(
                    raw_name="Sneak Attack", condition=condition,
                    price=Decimal("40"), price_date=date(2026, 7, 27),
                )]
                _, issues = resolve(rows)
                self.assertNotIn("condition", {i.code for i in issues})


class TestSummary(unittest.TestCase):
    def setUp(self):
        self.holdings, _ = resolve(load_sealed(SEALED_SAMPLE))
        self.summary = summarize_sealed(self.holdings)

    def test_totals_are_exact(self):
        # 42.00 + 180.00 + 240.00*2 + 38.50 + 95.00
        self.assertEqual(self.summary.total_value, Decimal("835.50"))
        self.assertIsInstance(self.summary.total_value, Decimal)

    def test_quantity_counts_copies_not_rows(self):
        self.assertEqual(self.summary.rows, 7)
        self.assertEqual(self.summary.quantity, 8)

    def test_unpriced_is_reported_so_a_partial_total_cannot_pass_as_complete(self):
        self.assertEqual(self.summary.unpriced_quantity, 2)
        self.assertFalse(self.summary.fully_priced)

    def test_unresolved_rows_are_counted(self):
        self.assertEqual(self.summary.unresolved_rows, 2)

    def test_gain_only_where_cost_basis_exists(self):
        # Only the Sneak Attack row has a cost basis: 42.00 - 35.00
        self.assertEqual(self.summary.total_cost, Decimal("35.00"))
        self.assertEqual(self.summary.total_gain, Decimal("7.00"))

    def test_price_date_range(self):
        self.assertEqual(self.summary.oldest_price_date, date(2026, 7, 20))
        self.assertEqual(self.summary.newest_price_date, date(2026, 7, 27))

    def test_rollups_sum_to_the_total(self):
        for rollup in (self.summary.by_year, self.summary.by_set):
            with self.subTest(rollup=rollup):
                self.assertEqual(
                    sum(v for _, v in rollup.values()), self.summary.total_value
                )

    def test_empty_input(self):
        s = summarize_sealed([])
        self.assertEqual(s.rows, 0)
        self.assertEqual(s.total_value, Decimal("0.00"))
        self.assertTrue(s.fully_priced)


class TestDiff(unittest.TestCase):
    def _holding(self, name, price, qty=1):
        rows = [SealedHolding(
            raw_name=name, quantity=qty,
            price=None if price is None else Decimal(price),
            price_date=date(2026, 7, 27),
        )]
        return resolve(rows)[0][0]

    def test_price_move_is_reported_with_the_right_delta(self):
        old = [self._holding("Sneak Attack", "42.00")]
        new = [self._holding("Sneak Attack", "58.00")]
        result = diff_sealed(old, new)
        self.assertEqual(len(result.price_changed), 1)
        change = result.price_changed[0]
        self.assertEqual(change.price_delta, Decimal("16.00"))
        self.assertEqual(change.value_delta, Decimal("16.00"))
        self.assertEqual(result.value_delta, Decimal("16.00"))

    def test_percentage_change(self):
        result = diff_sealed(
            [self._holding("Sneak Attack", "40.00")],
            [self._holding("Sneak Attack", "50.00")],
        )
        self.assertEqual(round(result.price_changed[0].pct), 25)

    def test_renaming_a_row_to_the_official_name_is_not_a_change(self):
        """Identity is the MTGJSON UUID, so how the row is written doesn't matter."""
        old = [self._holding("Sneak Attack", "42.00")]
        new = [self._holding("Zendikar Rising Commander Deck Sneak Attack", "42.00")]
        self.assertTrue(diff_sealed(old, new).is_empty())

    def test_quantity_and_price_moving_together_is_counted_once(self):
        old = [self._holding("Sneak Attack", "40.00", qty=1)]
        new = [self._holding("Sneak Attack", "50.00", qty=2)]
        result = diff_sealed(old, new)
        self.assertEqual(len(result.quantity_changed), 1)
        self.assertEqual(len(result.price_changed), 0)
        self.assertEqual(result.value_delta, Decimal("60.00"))

    def test_added_and_removed(self):
        result = diff_sealed(
            [self._holding("Sneak Attack", "42.00")],
            [self._holding("Death Toll", "38.00")],
        )
        self.assertEqual(len(result.added), 1)
        self.assertEqual(len(result.removed), 1)
        self.assertEqual(result.value_delta, Decimal("-4.00"))

    def test_identical_diffs_to_nothing(self):
        holdings = [self._holding("Sneak Attack", "42.00")]
        result = diff_sealed(holdings, holdings)
        self.assertTrue(result.is_empty())
        self.assertEqual(result.value_delta, Decimal("0.00"))

    def test_unresolved_rows_still_diff_by_name(self):
        old = [self._holding("Definitely Not Real 999", "10.00")]
        new = [self._holding("Definitely Not Real 999", "20.00")]
        result = diff_sealed(old, new)
        self.assertEqual(len(result.price_changed), 1)


class TestLedger(unittest.TestCase):
    def test_sealed_ledger_uses_the_singles_schema(self):
        import csv as _csv

        from binders.export import LEDGER_COLUMNS, to_sealed_ledger_csv

        holdings, _ = resolve(load_sealed(SEALED_SAMPLE))
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "led.csv")
            to_sealed_ledger_csv(holdings, out)
            with open(out, newline="", encoding="utf-8") as fh:
                rows = list(_csv.DictReader(fh))
        self.assertEqual(list(rows[0].keys()), list(LEDGER_COLUMNS))

        by_name = {r["Name"]: r for r in rows}
        sneak = next(r for n, r in by_name.items() if "Sneak Attack" in n)
        # The row's own price date, not today's.
        self.assertEqual(sneak["Valuation Date"], "2026-07-27")
        self.assertEqual(sneak["Cost Basis"], "35.00")
        self.assertIn("MTGJSON", sneak["Notes"])

    def test_unpriced_rows_leave_market_value_blank(self):
        from binders.export import to_sealed_ledger_csv

        rows = [SealedHolding(raw_name="Wakanda Forever")]
        holdings, _ = resolve(rows)
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "led.csv")
            to_sealed_ledger_csv(holdings, out)
            with open(out, encoding="utf-8") as fh:
                text = fh.read()
        self.assertIn("Wakanda Forever", text)
        # An unpriced holding must not silently become a $0.00 valuation.
        row = [line for line in text.splitlines() if "Wakanda" in line][0]
        self.assertNotIn("0.00", row)


class TestCli(unittest.TestCase):
    def _run(self, *argv):
        import io as _io
        from contextlib import redirect_stdout

        from binders.cli import main

        buf = _io.StringIO()
        with redirect_stdout(buf):
            code = main(list(argv))
        return code, buf.getvalue()

    def test_summary(self):
        code, out = self._run("sealed", "summary", SEALED_SAMPLE)
        self.assertEqual(code, 0)
        self.assertIn("Market value", out)
        self.assertIn("is a floor, not the total", out)

    def test_doctor_exits_nonzero_when_a_row_is_unmatched(self):
        code, out = self._run("sealed", "doctor", SEALED_SAMPLE)
        self.assertEqual(code, 1)
        self.assertIn("ambiguous", out)
        self.assertIn("unmatched", out)

    def test_doctor_on_a_clean_file_exits_zero(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "clean.csv")
            with open(path, "w", newline="", encoding="utf-8") as fh:
                fh.write("Name,Set,Quantity,Condition,Price,Price date,Source,Cost basis,Notes\r\n")
                fh.write("Sneak Attack,ZNC,1,sealed,42.00,2026-07-27,tcgplayer,,\r\n")
            code, out = self._run("sealed", "doctor", path)
            self.assertEqual(code, 0)
            self.assertIn("Nothing to fix", out)

    def test_catalog_search(self):
        code, out = self._run("sealed", "catalog", "--search", "warhammer")
        self.assertEqual(code, 0)
        self.assertIn("40K", out)

    def test_template_then_doctor(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "sealed.csv")
            code, _ = self._run("sealed", "template", "-o", path)
            self.assertEqual(code, 0)
            self.assertTrue(os.path.exists(path))
            # The template must itself be loadable.
            self.assertEqual(len(load_sealed(path)), 2)

    def test_template_refuses_to_clobber(self):
        import io as _io
        from contextlib import redirect_stderr

        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "sealed.csv")
            self._run("sealed", "template", "-o", path)
            with redirect_stderr(_io.StringIO()):
                code, _ = self._run("sealed", "template", "-o", path)
            self.assertEqual(code, 2)

    def test_snapshot_and_diff(self):
        with tempfile.TemporaryDirectory() as tmp:
            code, _ = self._run("sealed", "snapshot", SEALED_SAMPLE, "--dir", tmp)
            self.assertEqual(code, 0)
            snap = [f for f in os.listdir(tmp) if f.endswith(".csv")]
            self.assertEqual(len(snap), 1)
            code, out = self._run(
                "sealed", "diff", os.path.join(tmp, snap[0]), SEALED_SAMPLE
            )
            self.assertEqual(code, 0)
            self.assertIn("net value", out)

    def test_ledger(self):
        with tempfile.TemporaryDirectory() as tmp:
            out_path = os.path.join(tmp, "led.csv")
            code, out = self._run("sealed", "ledger", SEALED_SAMPLE, "-o", out_path)
            self.assertEqual(code, 0)
            self.assertTrue(os.path.exists(out_path))


if __name__ == "__main__":
    unittest.main()


class TestTemplate(unittest.TestCase):
    """The starter file.

    It is offered from two places now — `sealed template` and the web app's
    Sealed screen — so the only interesting property is that it is one file,
    and that the parser accepts what it hands out.
    """

    def test_the_header_is_the_parser_s_own_columns(self):
        first = template_csv().splitlines()[0]
        self.assertEqual(first.split(","), list(SEALED_COLUMNS))

    def test_it_round_trips_through_the_loader(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "sealed.csv")
            with open(path, "w", newline="", encoding="utf-8") as handle:
                handle.write(template_csv())
            holdings, _ = resolve(load_sealed(path))

        self.assertEqual(len(holdings), len(TEMPLATE_ROWS))
        # Both example rows resolve — a template that shipped an unmatched name
        # would teach the error on first contact.
        self.assertTrue(all(h.resolved for h in holdings))
        # And neither invents money.
        self.assertTrue(all(h.price is None and h.cost_basis is None for h in holdings))

    def test_the_ambiguous_example_needs_its_set_to_resolve(self):
        """The second row exists to explain the Set column; check it earns it."""
        name, set_hint = TEMPLATE_ROWS[1][0], TEMPLATE_ROWS[1][1]
        self.assertTrue(set_hint)

        with_hint, _ = resolve([SealedHolding(raw_name=name, set_hint=set_hint)])
        without, _ = resolve([SealedHolding(raw_name=name)])

        self.assertTrue(with_hint[0].resolved)
        self.assertEqual(with_hint[0].set_code, set_hint)
        self.assertEqual(without[0].match, MATCH_AMBIGUOUS)

    def test_the_cli_writes_exactly_this(self):
        import contextlib
        import io as _io

        from binders.cli import main

        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "sealed.csv")
            with contextlib.redirect_stdout(_io.StringIO()):
                self.assertEqual(main(["sealed", "template", "-o", path]), 0)
            with open(path, newline="", encoding="utf-8") as handle:
                self.assertEqual(handle.read(), template_csv())
