"""The sealed triage page: exact money, no invented rates, self-containment."""

from __future__ import annotations

import json
import os
import re
import tempfile
import unittest
from decimal import Decimal

from binders.sealed import SealedHolding, load_sealed, resolve, summarize_sealed
from binders.sealed_dashboard import (
    build_sealed_payload,
    render_sealed_html,
)
from tests.test_dashboard import assert_no_remote_subresources

HERE = os.path.dirname(__file__)
FIXTURES = os.path.join(HERE, "fixtures")
SEALED_SAMPLE = os.path.join(FIXTURES, "sealed_sample.csv")

PAYLOAD_RE = re.compile(
    r'<script type="application/json" id="payload">(.*?)</script>', re.DOTALL
)


def _payload_from(html: str) -> dict:
    match = PAYLOAD_RE.search(html)
    assert match, "payload block not found"
    return json.loads(match.group(1))


def _built():
    holdings, issues = resolve(load_sealed(SEALED_SAMPLE))
    return holdings, issues, build_sealed_payload(
        holdings, issues, source_file=SEALED_SAMPLE
    )


class TestPayload(unittest.TestCase):
    def setUp(self):
        self.holdings, self.issues, self.payload = _built()

    def test_totals_match_the_summary_exactly(self):
        summary = summarize_sealed(self.holdings)
        self.assertEqual(
            Decimal(self.payload["meta"]["totalCents"]) / 100, summary.total_value
        )

    def test_per_deck_cents_sum_to_the_total(self):
        self.assertEqual(
            sum(d["totalCents"] for d in self.payload["decks"]),
            self.payload["meta"]["totalCents"],
        )

    def test_unpriced_decks_carry_null_not_zero(self):
        """A null price is 'unknown'; zero would read as 'worthless'."""
        wakanda = next(d for d in self.payload["decks"] if "Wakanda" in d["name"])
        self.assertIsNone(wakanda["cents"])
        self.assertEqual(wakanda["totalCents"], 0)

    def test_unpriced_count_is_reported(self):
        meta = self.payload["meta"]
        self.assertEqual(meta["unpricedQuantity"], 2)
        self.assertFalse(meta["fullyPriced"])

    def test_sorted_by_value_descending(self):
        totals = [d["totalCents"] for d in self.payload["decks"]]
        self.assertEqual(totals, sorted(totals, reverse=True))

    def test_ids_are_stable_across_rebuilds(self):
        _, _, again = _built()
        self.assertEqual(
            [d["id"] for d in self.payload["decks"]],
            [d["id"] for d in again["decks"]],
        )

    def test_gain_only_where_a_cost_basis_exists(self):
        with_gain = [d for d in self.payload["decks"] if d["gainCents"] is not None]
        self.assertEqual(len(with_gain), 1)
        self.assertEqual(with_gain[0]["gainCents"], 700)  # 42.00 - 35.00

    def test_by_year_is_chronological_not_value_sorted(self):
        years = [row["year"] for row in self.payload["byYear"]]
        self.assertEqual(years, sorted(years))

    def test_by_year_sums_to_the_total(self):
        self.assertEqual(
            sum(r["cents"] for r in self.payload["byYear"]),
            self.payload["meta"]["totalCents"],
        )

    def test_coverage_splits_every_deck(self):
        cov = self.payload["coverage"]
        self.assertEqual(
            cov["pricedDecks"] + cov["unpricedDecks"],
            self.payload["meta"]["quantity"],
        )

    def test_concentration_uses_priced_decks_only(self):
        """An unpriced deck contributing 0 would flatten the tail."""
        points = self.payload["concentration"]["points"]
        priced = [d for d in self.payload["decks"] if d["cents"] is not None]
        self.assertEqual(len(points), len(priced))
        self.assertAlmostEqual(points[-1]["valuePct"], 100.0, places=1)

    def test_empty_input_does_not_crash(self):
        payload = build_sealed_payload([], [])
        self.assertEqual(payload["meta"]["rows"], 0)
        self.assertEqual(payload["concentration"]["points"], [])
        self.assertEqual(payload["byYear"], [])


class TestNoInventedRates(unittest.TestCase):
    """The honesty guarantee gets a test.

    Card Kingdom's 60/47/20% cash and 75/62/25% credit bands are singles buylist
    rates. Sealed product isn't going to CK, so any appearance of those numbers
    here would be a figure corresponding to no real offer.
    """

    def setUp(self):
        _, _, self.payload = _built()
        self.html = render_sealed_html(self.payload)

    def test_payload_has_no_rate_or_tier_structure(self):
        self.assertNotIn("rates", self.payload)
        self.assertNotIn("tiers", self.payload)
        blob = json.dumps(self.payload)
        for token in ("cashRate", "creditRate", "cashCents", "creditCents", "tier"):
            self.assertNotIn(token, blob, token)

    def test_no_cash_or_credit_figure_is_displayed(self):
        """Checks the visible markup, not the source.

        Bare percentages like "25%" legitimately appear as axis ticks, and the
        JS comment explaining *why* there are no CK rates naturally names Card
        Kingdom — neither is the failure mode. What must never appear is a
        derived cash/credit figure presented as a number.
        """
        visible = re.sub(r"<style>.*?</style>|<script.*?</script>", "", self.html,
                         flags=re.DOTALL)
        for token in ("Est. cash", "Est. credit", "Sell → cash", "Sell → credit",
                      "buylist", "Buylist", "Card Kingdom"):
            self.assertNotIn(token, visible, token)

    def test_the_page_says_prices_are_manual(self):
        self.assertIn("entered by hand", self.html)


class TestRender(unittest.TestCase):
    def setUp(self):
        _, _, self.payload = _built()
        self.html = render_sealed_html(self.payload)

    def test_payload_parses_back_out(self):
        self.assertEqual(
            _payload_from(self.html)["meta"]["totalCents"],
            self.payload["meta"]["totalCents"],
        )

    def test_assets_are_inlined(self):
        self.assertIn("--series-1", self.html)          # shared dashboard.css
        self.assertIn("Sealed commander deck triage", self.html)  # sealed js
        for placeholder in ("/*__CSS__*/", "/*__JS__*/", "__PAYLOAD__", "__TITLE__"):
            self.assertNotIn(placeholder, self.html)

    def test_no_remote_subresources(self):
        assert_no_remote_subresources(self, self.html)

    def test_external_urls_are_only_anchors_or_payload(self):
        """Enumerate where an external URL may appear, rather than banning one
        attribute name. Every http(s) occurrence must be an MTGJSON purchase
        link — in an <a href> in the markup, or in the JSON payload that feeds
        those links."""
        payload_text = PAYLOAD_RE.search(self.html).group(1)
        outside = self.html.replace(payload_text, "")
        for match in re.finditer(r"https?://[^\s\"'<>]+", outside):
            url = match.group(0)
            context = outside[max(0, match.start() - 40): match.start()]
            with self.subTest(url=url):
                self.assertRegex(context, r'href\s*=\s*["\']$|href="$')

    def test_purchase_links_point_at_mtgjson(self):
        urls = [d["url"] for d in self.payload["decks"] if d["url"]]
        self.assertTrue(urls)
        for url in urls:
            self.assertTrue(url.startswith("https://mtgjson.com/links/"), url)

    def test_a_deck_without_a_purchase_url_renders_no_link(self):
        holdings, issues = resolve([SealedHolding(raw_name="Not A Real Deck 999")])
        html = render_sealed_html(build_sealed_payload(holdings, issues))
        self.assertNotIn('href=""', html)
        self.assertNotIn("href='>", html)

    def test_standalone_document_shape(self):
        self.assertTrue(self.html.startswith("<!doctype html>"))
        self.assertLess(self.html.index("<title>"), self.html.index("</head>"))
        self.assertLess(self.html.index("<style>"), self.html.index("</head>"))

    def test_fragment_omits_the_shell(self):
        fragment = render_sealed_html(self.payload, standalone=False)
        for tag in ("<!doctype", "<html", "<head>", "<body>"):
            self.assertNotIn(tag, fragment.lower())
        self.assertIn("<title>", fragment)

    def test_both_themes_present(self):
        self.assertIn("prefers-color-scheme: dark", self.html)
        self.assertIn(':root[data-theme="dark"]', self.html)
        self.assertIn(':root[data-theme="light"]', self.html)

    def test_escaping_survives_a_hostile_deck_name(self):
        rows = [SealedHolding(raw_name="</script><script>alert(1)</script>",
                              price=Decimal("5"))]
        holdings, issues = resolve(rows)
        html = render_sealed_html(build_sealed_payload(holdings, issues))
        payload = _payload_from(html)
        self.assertEqual(
            payload["decks"][0]["name"], "</script><script>alert(1)</script>"
        )

    def test_title_is_escaped(self):
        html = render_sealed_html(self.payload, title='Austin & "sealed" <stuff>')
        self.assertIn("Austin &amp; &quot;sealed&quot; &lt;stuff&gt;", html)


class TestResolutionStateReachesThePage(unittest.TestCase):
    def setUp(self):
        _, _, self.payload = _built()
        self.by_name = {d["name"]: d for d in self.payload["decks"]}

    def test_ambiguous_row_is_flagged_with_its_candidates(self):
        row = next(
            d for d in self.payload["decks"]
            if d["name"] == "Heavenly Inferno" and not d["resolved"]
        )
        self.assertIn("ambiguous", row["flags"])
        self.assertEqual(sorted(row["candidates"]), ["CMA (2017)", "CMD (2011)"])

    def test_unmatched_row_is_present_not_dropped(self):
        names = list(self.by_name)
        self.assertTrue(any("Not A Real Deck" in n for n in names))
        row = next(d for d in self.payload["decks"] if "Not A Real Deck" in d["name"])
        self.assertIn("unmatched", row["flags"])
        self.assertFalse(row["resolved"])

    def test_undated_price_is_flagged(self):
        row = next(d for d in self.payload["decks"] if "Death Toll" in d["name"])
        self.assertIn("no-price-date", row["flags"])

    def test_every_flag_has_a_label(self):
        used = {f for d in self.payload["decks"] for f in d["flags"]}
        for flag in used:
            self.assertIn(flag, self.payload["flagLabels"], flag)


class TestCli(unittest.TestCase):
    def _run(self, *argv):
        import io as _io
        from contextlib import redirect_stdout

        from binders.cli import main

        buf = _io.StringIO()
        with redirect_stdout(buf):
            code = main(list(argv))
        return code, buf.getvalue()

    def test_writes_a_usable_page(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "sealed.html")
            code, text = self._run("sealed", "dashboard", SEALED_SAMPLE, "-o", out)
            self.assertEqual(code, 0)
            self.assertIn("no price", text)
            with open(out, encoding="utf-8") as fh:
                html = fh.read()
            self.assertTrue(html.startswith("<!doctype html>"))
            _, _, payload = _built()
            self.assertEqual(
                _payload_from(html)["meta"]["totalCents"],
                payload["meta"]["totalCents"],
            )

    def test_fragment_flag(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "s.html")
            self._run("sealed", "dashboard", SEALED_SAMPLE, "-o", out, "--fragment")
            with open(out, encoding="utf-8") as fh:
                self.assertNotIn("<!doctype", fh.read().lower())


if __name__ == "__main__":
    unittest.main()
