"""The HTML dashboard: exact money, self-containment, and escaping."""

from __future__ import annotations

import json
import os
import re
import tempfile
import unittest
from decimal import Decimal

from binders import build_payload, load, load_many, merge, render_html
from binders.dashboard import HEAD_MARKER, _embed_json, to_cents
from binders.io import parse_row

HERE = os.path.dirname(__file__)
FIXTURES = os.path.join(HERE, "fixtures")
SAMPLE = os.path.join(FIXTURES, "sample.csv")
SAMPLE2 = os.path.join(FIXTURES, "sample2.csv")

PAYLOAD_RE = re.compile(
    r'<script type="application/json" id="payload">(.*?)</script>', re.DOTALL
)


def assert_no_remote_subresources(case, html: str) -> None:
    """No remote *subresource* may appear — the rule the CSP actually enforces.

    Shared with the sealed dashboard tests so one definition governs both pages.
    Deliberately says nothing about `<a href>`: an anchor is navigation, not a
    fetch, and banning it would be a proxy for the real rule rather than the
    rule itself.
    """
    case.assertNotRegex(html, r"<script[^>]+\ssrc\s*=")
    case.assertNotRegex(html, r"<link[^>]+stylesheet")
    case.assertNotRegex(html, r"<(?:img|iframe|embed|object|video|audio|source)\b[^>]*\ssrc\s*=")
    case.assertNotIn("@import", html)
    case.assertNotRegex(html, r"url\(\s*['\"]?https?:")
    case.assertNotIn("fonts.googleapis", html)
    case.assertNotRegex(html, r"\bfetch\s*\(\s*['\"]https?:")
    case.assertNotRegex(html, r"new\s+(?:WebSocket|EventSource)\s*\(")
    case.assertNotRegex(html, r"XMLHttpRequest")


def _payload_from(html: str) -> dict:
    match = PAYLOAD_RE.search(html)
    assert match, "payload script block not found"
    return json.loads(match.group(1))


class TestCents(unittest.TestCase):
    def test_exact_conversion(self):
        for text, expected in [("75.17", 7517), ("1.10", 110), ("0", 0), ("471.51", 47151)]:
            self.assertEqual(to_cents(Decimal(text)), expected)

    def test_no_float_drift_on_a_known_trap(self):
        # 2.675 in float is 2.67499999...; Decimal keeps it exact.
        self.assertEqual(to_cents(Decimal("2.67")), 267)
        self.assertEqual(to_cents(Decimal("8.41")), 841)

    def test_payload_total_matches_the_collection_exactly(self):
        cards = merge(load_many(SAMPLE, SAMPLE2))
        payload = build_payload(cards)
        self.assertEqual(
            Decimal(payload["meta"]["totalCents"]) / 100, cards.total_value
        )

    def test_per_card_totals_sum_to_the_meta_total(self):
        payload = build_payload(merge(load_many(SAMPLE, SAMPLE2)))
        self.assertEqual(
            sum(c["totalCents"] for c in payload["cards"]),
            payload["meta"]["totalCents"],
        )

    def test_tier_cents_sum_to_the_total(self):
        payload = build_payload(merge(load_many(SAMPLE, SAMPLE2)))
        self.assertEqual(
            sum(t["marketCents"] for t in payload["tiers"]),
            payload["meta"]["totalCents"],
        )

    def test_browser_arithmetic_reproduces_the_decimal_answer(self):
        """Pin the algorithm the page runs on the sell pile.

        The page sums a band's market cents, then applies that band's rate once
        and rounds — mirroring `aggregate.price_tiers`. Verified against the real
        exports: marking everything Sell reproduces `binders tiers` to the cent
        in all three bands. This asserts the same equivalence on the fixtures so
        a change to either side can't silently drift.
        """
        payload = build_payload(merge(load_many(SAMPLE, SAMPLE2)))
        rates = {r["tier"]: r for r in payload["rates"]}

        for tier in payload["tiers"]:
            with self.subTest(tier=tier["tier"]):
                rate = rates[tier["tier"]]
                # Integer arithmetic, exactly as the JS does it.
                cash_bp = round(float(rate["cash"]) * 100)
                credit_bp = round(float(rate["credit"]) * 100)
                self.assertEqual(
                    round(tier["marketCents"] * cash_bp / 100), tier["cashCents"]
                )
                self.assertEqual(
                    round(tier["marketCents"] * credit_bp / 100), tier["creditCents"]
                )

    def test_quantity_is_carried_not_recomputed(self):
        cards = merge(load_many(SAMPLE, SAMPLE2))
        payload = build_payload(cards)
        self.assertEqual(
            sum(c["qty"] for c in payload["cards"]), cards.total_quantity
        )


class TestPayloadShape(unittest.TestCase):
    def setUp(self):
        self.cards = merge(load_many(SAMPLE, SAMPLE2))
        self.payload = build_payload(self.cards)

    def test_sorted_by_total_value_descending(self):
        totals = [c["totalCents"] for c in self.payload["cards"]]
        self.assertEqual(totals, sorted(totals, reverse=True))

    def test_ids_are_stable_and_unique(self):
        ids = [c["id"] for c in self.payload["cards"]]
        self.assertEqual(len(ids), len(set(ids)))
        # Regenerating must produce the same ids or stored verdicts detach.
        again = build_payload(merge(load_many(SAMPLE, SAMPLE2)))
        self.assertEqual(ids, [c["id"] for c in again["cards"]])

    def test_id_survives_a_new_file_being_merged_in(self):
        first = build_payload(merge(load(SAMPLE)))
        both = build_payload(merge(load_many(SAMPLE, SAMPLE2)))
        mox_first = next(c["id"] for c in first["cards"] if c["name"] == "Mox Amber")
        mox_both = next(c["id"] for c in both["cards"] if c["name"] == "Mox Amber")
        self.assertEqual(mox_first, mox_both)

    def test_flags_reuse_the_existing_logic(self):
        mox = next(c for c in self.payload["cards"] if c["name"] == "Mox Amber")
        self.assertIn("multi", mox["flags"])   # 13 copies
        self.assertIn("review", mox["flags"])  # over $10

    def test_language_flag_surfaces(self):
        tithe = next(
            c for c in self.payload["cards"] if c["name"] == "Smothering Tithe"
        )
        self.assertIn("language", tithe["flags"])

    def test_every_flag_has_a_label(self):
        used = {f for c in self.payload["cards"] for f in c["flags"]}
        for flag in used:
            self.assertIn(flag, self.payload["flagLabels"], flag)

    def test_rates_are_present_for_every_tier(self):
        tiers = {t["tier"] for t in self.payload["tiers"]}
        rates = {r["tier"] for r in self.payload["rates"]}
        self.assertEqual(tiers, rates)

    def test_sources_are_computed_pre_merge(self):
        raw = load_many(SAMPLE, SAMPLE2)
        payload = build_payload(merge(raw), raw=raw)
        # Mox Amber is in both files; per-binder totals must not double count it.
        self.assertEqual(
            sum(s["cents"] for s in payload["sources"]),
            sum(to_cents(c.market_price) * c.quantity for c in raw),
        )

    def test_concentration_marks_are_ordered(self):
        marks = self.payload["concentration"]["marks"]
        self.assertTrue(marks)
        self.assertEqual(
            [m["valuePct"] for m in marks], sorted(m["valuePct"] for m in marks)
        )

    def test_empty_collection_does_not_crash(self):
        payload = build_payload([])
        self.assertEqual(payload["meta"]["rows"], 0)
        self.assertEqual(payload["concentration"]["points"], [])


class TestEmbedding(unittest.TestCase):
    def test_script_block_cannot_be_terminated_by_a_card_name(self):
        text = _embed_json({"n": "</script><script>alert(1)</script>"})
        self.assertNotIn("</script", text)
        self.assertNotIn("<script", text)
        self.assertEqual(
            json.loads(text)["n"], "</script><script>alert(1)</script>"
        )

    def test_comment_open_is_escaped(self):
        text = _embed_json({"n": "<!-- hi -->"})
        self.assertNotIn("<!--", text)
        self.assertEqual(json.loads(text)["n"], "<!-- hi -->")

    def test_js_line_terminators_are_escaped(self):
        raw = "before after end"
        text = _embed_json({"n": raw})
        self.assertNotIn(" ", text)
        self.assertNotIn(" ", text)
        self.assertEqual(json.loads(text)["n"], raw)

    def test_ordinary_text_is_untouched(self):
        for value in ["Ashnod's Altar", "a b  c", "Jötun Grunt", "140★",
                      "Search for Azcanta // Azcanta, the Sunken Ruin"]:
            with self.subTest(value=value):
                self.assertEqual(json.loads(_embed_json({"n": value}))["n"], value)

    def test_apostrophes_and_ampersands_round_trip_through_the_page(self):
        rows = [
            parse_row({"Title": "Ashnod's Altar & \"Friends\"", "Quantity": "1",
                       "Purchase price": "5.00", "Scryfall ID": "a"}),
            parse_row({"Title": "</script>", "Quantity": "1",
                       "Purchase price": "1.00", "Scryfall ID": "b"}),
        ]
        html = render_html(build_payload(rows))
        names = {c["name"] for c in _payload_from(html)["cards"]}
        self.assertEqual(names, {"Ashnod's Altar & \"Friends\"", "</script>"})


class TestRender(unittest.TestCase):
    def setUp(self):
        self.payload = build_payload(merge(load_many(SAMPLE, SAMPLE2)))
        self.html = render_html(self.payload)

    def test_payload_parses_back_out(self):
        self.assertEqual(
            _payload_from(self.html)["meta"]["totalCents"],
            self.payload["meta"]["totalCents"],
        )

    def test_css_and_js_are_inlined(self):
        self.assertIn("--series-1", self.html)
        self.assertIn("Collection triage", self.html)
        self.assertNotIn("/*__CSS__*/", self.html)
        self.assertNotIn("/*__JS__*/", self.html)
        self.assertNotIn("__PAYLOAD__", self.html)
        self.assertNotIn("__TITLE__", self.html)

    def test_nothing_is_fetched_from_a_remote_host(self):
        """The Artifact CSP blocks every external host, so this is a test.

        Subresources only. An `<a href>` is navigation, which CSP does not block
        and which the sealed page uses to link out to price lookups —
        `assert_no_remote_subresources` is shared so both pages hold the same
        line, and `test_external_urls_are_only_anchors` pins where URLs may
        legally appear.
        """
        assert_no_remote_subresources(self, self.html)

    def test_the_singles_page_has_no_external_urls_at_all(self):
        """Nothing on this page needs to link out, so nothing should."""
        self.assertNotIn("http://", self.html)
        self.assertNotIn("https://", self.html)

    def test_standalone_is_a_complete_document(self):
        self.assertTrue(self.html.startswith("<!doctype html>"))
        self.assertIn("<head>", self.html)
        self.assertIn("<body>", self.html)
        self.assertNotIn(HEAD_MARKER, self.html)
        # The title belongs in the head, not adrift in the body.
        self.assertLess(self.html.index("<title>"), self.html.index("</head>"))
        self.assertLess(self.html.index("<style>"), self.html.index("</head>"))

    def test_fragment_omits_the_document_shell(self):
        fragment = render_html(self.payload, standalone=False)
        for tag in ("<!doctype", "<html", "<head>", "<body>"):
            self.assertNotIn(tag, fragment.lower())
        self.assertNotIn(HEAD_MARKER, fragment)
        self.assertIn("<title>", fragment)
        self.assertIn("<style>", fragment)

    def test_title_is_escaped(self):
        html = render_html(self.payload, title='Austin & "the" <collection>')
        self.assertIn("Austin &amp; &quot;the&quot; &lt;collection&gt;", html)

    def test_both_themes_are_defined(self):
        self.assertIn("prefers-color-scheme: dark", self.html)
        self.assertIn(':root[data-theme="dark"]', self.html)
        self.assertIn(':root[data-theme="light"]', self.html)

    def test_reduced_motion_is_respected(self):
        self.assertIn("prefers-reduced-motion", self.html)


class TestCli(unittest.TestCase):
    def test_dashboard_command_writes_a_usable_file(self):
        from binders.cli import main

        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "d.html")
            import io as _io
            from contextlib import redirect_stdout

            buf = _io.StringIO()
            with redirect_stdout(buf):
                code = main(["dashboard", SAMPLE, SAMPLE2, "-o", out])
            self.assertEqual(code, 0)
            with open(out, encoding="utf-8") as fh:
                html = fh.read()
            self.assertTrue(html.startswith("<!doctype html>"))
            self.assertEqual(
                _payload_from(html)["meta"]["totalCents"],
                build_payload(merge(load_many(SAMPLE, SAMPLE2)))["meta"]["totalCents"],
            )

    def test_fragment_flag(self):
        from binders.cli import main

        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "d.html")
            import io as _io
            from contextlib import redirect_stdout

            with redirect_stdout(_io.StringIO()):
                main(["dashboard", SAMPLE, "-o", out, "--fragment"])
            with open(out, encoding="utf-8") as fh:
                self.assertNotIn("<!doctype", fh.read().lower())


if __name__ == "__main__":
    unittest.main()
