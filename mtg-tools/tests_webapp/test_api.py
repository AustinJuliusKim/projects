"""The JSON API contract.

Replaces the HTML-scraping tests that came with the Jinja UI. Those counted
occurrences of `pill sell` and regexed `name="csrf"` out of rendered markup;
these assert response shape, which is both stronger and no longer coupled to
how anything looks.

`test_core.py` is untouched by the front-end change — it never spoke HTTP.
"""

from __future__ import annotations

import csv
import io
import json
import os
import re
import unittest
from decimal import Decimal

from webapp import importer
from webapp.app import create_app, serve

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXTURES = os.path.join(REPO, "tests", "fixtures")
SAMPLE = os.path.join(FIXTURES, "sample.csv")
SAMPLE2 = os.path.join(FIXTURES, "sample2.csv")
SEALED = os.path.join(FIXTURES, "sealed_sample.csv")


def read(path):
    with open(path, "rb") as handle:
        return handle.read()


class Base(unittest.TestCase):
    def setUp(self):
        self.app = create_app(":memory:", testing=True)
        self.client = self.app.test_client()
        self.token = self.client.get("/api/session").get_json()["csrfToken"]

    # -- helpers ---------------------------------------------------------

    def post(self, path, body=None, **kwargs):
        return self.client.post(
            path,
            json=body if body is not None else {},
            headers={"X-CSRF-Token": self.token},
            **kwargs,
        )

    def upload(self, path=SAMPLE, name="sample.csv"):
        return self.client.post(
            "/api/imports",
            data={"file": (io.BytesIO(read(path)), name)},
            content_type="multipart/form-data",
            headers={"X-CSRF-Token": self.token},
        )

    def commit(self, path=SAMPLE, name="sample.csv"):
        import_id = self.upload(path, name).get_json()["importId"]
        return self.post(f"/api/imports/{import_id}/commit")

    def rows(self, query=""):
        return self.client.get(f"/api/collection{query}").get_json()


class TestSession(Base):
    def test_session_carries_a_token_and_the_database(self):
        body = self.client.get("/api/session").get_json()
        self.assertTrue(body["csrfToken"])
        self.assertIn("database", body)
        self.assertIsNone(body["undoable"])

    def test_undoable_appears_after_a_change(self):
        self.commit()
        undoable = self.client.get("/api/session").get_json()["undoable"]
        self.assertIsNotNone(undoable)
        self.assertIn("Imported", undoable["summary"])


class TestCsrf(Base):
    def test_mutation_without_the_header_is_refused(self):
        response = self.client.post("/api/bulk", json={"action": "verdict"})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()["code"], "csrf")

    def test_a_wrong_token_is_refused(self):
        response = self.client.post(
            "/api/bulk", json={}, headers={"X-CSRF-Token": "nope"}
        )
        self.assertEqual(response.status_code, 400)

    def test_reads_do_not_need_a_token(self):
        for path in ("/api/session", "/api/collection", "/api/history", "/api/imports"):
            with self.subTest(path=path):
                self.assertEqual(self.client.get(path).status_code, 200)


class TestCollection(Base):
    def setUp(self):
        super().setUp()
        self.commit()

    def test_shape(self):
        body = self.rows()
        self.assertEqual(body["totalRows"], 6)
        self.assertEqual(len(body["rows"]), 6)
        for key in ("page", "pages", "totals", "grandTotals", "facets", "sort"):
            self.assertIn(key, body)

    def test_money_crosses_as_integer_cents(self):
        """Dollars as JSON floats would reintroduce the drift Decimal prevents."""
        mox = next(r for r in self.rows()["rows"] if r["title"] == "Mox Amber")
        self.assertEqual(mox["priceCents"], 7517)
        self.assertIsInstance(mox["priceCents"], int)
        self.assertEqual(mox["totalCents"], 7517 * 3)
        # …plus a preformatted string, so the client never does the arithmetic.
        self.assertEqual(mox["price"], "$75.17")
        self.assertEqual(mox["total"], "$225.51")

    def test_an_unpriced_row_is_null_not_zero(self):
        body = json.dumps(self.rows())
        self.assertNotIn('"priceCents": 0.0', body)

    def test_totals_track_the_filter(self):
        everything = self.rows()["totals"]
        filtered = self.rows("?price_min=10")["totals"]
        self.assertLess(filtered["valueCents"], everything["valueCents"])
        self.assertEqual(everything["rows"], 6)

    def test_grand_totals_ignore_the_filter(self):
        body = self.rows("?price_min=10")
        self.assertEqual(body["grandTotals"]["rows"], 6)
        self.assertLess(body["totals"]["rows"], 6)

    def test_unknown_filter_is_rejected_not_ignored(self):
        """A typo'd filter that quietly matched everything is how a bad bulk
        edit happens."""
        response = self.client.get("/api/collection?prices_min=10")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()["code"], "bad-filter")

    def test_sorting_and_pagination(self):
        body = self.rows("?sort=price&dir=asc&perPage=2&page=1")
        self.assertEqual(len(body["rows"]), 2)
        self.assertEqual(body["pages"], 3)
        prices = [r["priceCents"] for r in body["rows"]]
        self.assertEqual(prices, sorted(prices))

    def test_facets_are_offered_for_filtering(self):
        facets = self.rows()["facets"]
        self.assertIn("DOM", facets["editions"])
        self.assertIn("mythic", facets["rarities"])


class TestBulk(Base):
    def setUp(self):
        super().setUp()
        self.commit()
        self.ids = [r["id"] for r in self.rows()["rows"]]

    def test_actions_are_advertised(self):
        actions = self.client.get("/api/bulk/actions").get_json()
        keys = {a["key"] for a in actions}
        self.assertIn("verdict", keys)
        delete = next(a for a in actions if a["key"] == "delete")
        self.assertTrue(delete["destructive"])

    def test_preview_reports_the_real_count_and_sample(self):
        body = self.post(
            "/api/bulk/preview", {"selectAll": True, "filters": {"price_min": 10}}
        ).get_json()
        self.assertEqual(body["count"], 3)
        self.assertTrue(body["sample"])
        self.assertEqual(body["sample"][0]["title"], "Mox Amber")

    def test_apply_by_explicit_ids(self):
        body = self.post(
            "/api/bulk", {"action": "verdict", "value": "sell", "ids": self.ids[:3]}
        ).get_json()
        self.assertEqual(body["affected"], 3)
        sold = [r for r in self.rows()["rows"] if r["verdict"] == "sell"]
        self.assertEqual(len(sold), 3)

    def test_select_all_uses_the_filter_not_the_page(self):
        """The invariant the rewrite had to preserve: the server resolves the
        selection, so a filter that changed since render cannot widen it."""
        body = self.post(
            "/api/bulk",
            {
                "action": "verdict",
                "value": "keep",
                "selectAll": True,
                "filters": {"price_min": 10},
            },
        ).get_json()
        self.assertEqual(body["affected"], 3)
        kept = [r for r in self.rows()["rows"] if r["verdict"] == "keep"]
        self.assertEqual(len(kept), 3)

    def test_select_all_ignores_any_ids_the_client_also_sent(self):
        """A client that sends both must not get the union."""
        body = self.post(
            "/api/bulk",
            {
                "action": "verdict",
                "value": "keep",
                "selectAll": True,
                "ids": self.ids,
                "filters": {"price_min": 10},
            },
        ).get_json()
        self.assertEqual(body["affected"], 3)

    def test_empty_selection_is_refused(self):
        response = self.post("/api/bulk", {"action": "verdict", "value": "sell"})
        self.assertEqual(response.status_code, 400)
        self.assertIn("Nothing was selected", response.get_json()["error"])

    def test_unknown_action_is_refused(self):
        response = self.post("/api/bulk", {"action": "drop_table", "ids": self.ids})
        self.assertEqual(response.status_code, 400)

    def test_price_adjustment_is_exact(self):
        target = next(r for r in self.rows()["rows"] if r["priceCents"] == 684)
        self.post("/api/bulk", {"action": "adjust_price", "value": "5",
                                "ids": [target["id"]]})
        after = next(r for r in self.rows()["rows"] if r["id"] == target["id"])
        self.assertEqual(after["priceCents"], 718)  # half-up, no float


class TestImports(Base):
    def test_upload_stages_without_touching_the_collection(self):
        body = self.upload().get_json()
        self.assertIn("importId", body)
        self.assertEqual(body["kind"], "singles")
        self.assertEqual(self.rows()["totalRows"], 0)

    def test_detail_lists_issues_grouped_by_code(self):
        import_id = self.upload().get_json()["importId"]
        body = self.client.get(f"/api/imports/{import_id}").get_json()
        codes = {i["code"] for i in body["issues"]}
        self.assertIn("language", codes)
        self.assertEqual(body["blocking"], 0)

    def test_commit_populates_the_collection(self):
        body = self.commit().get_json()
        self.assertEqual(body["added"], 6)
        self.assertEqual(self.rows()["totals"]["value"], "$431.57")

    def test_duplicate_upload_is_refused(self):
        self.commit()
        response = self.upload()
        self.assertEqual(response.status_code, 409)
        self.assertIn("double", response.get_json()["error"])

    def test_unrecognized_file_reports_its_header(self):
        response = self.client.post(
            "/api/imports",
            data={"file": (io.BytesIO(b"Alpha,Beta\n1,2\n"), "weird.csv")},
            content_type="multipart/form-data",
            headers={"X-CSRF-Token": self.token},
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("Alpha", response.get_json()["error"])

    def test_no_file_is_reported(self):
        response = self.client.post(
            "/api/imports",
            data={},
            content_type="multipart/form-data",
            headers={"X-CSRF-Token": self.token},
        )
        self.assertEqual(response.status_code, 400)

    def test_blocking_rows_prevent_commit(self):
        import_id = self.upload(SEALED, "sealed.csv").get_json()["importId"]
        detail = self.client.get(f"/api/imports/{import_id}").get_json()
        self.assertGreater(detail["blocking"], 0)

        response = self.post(f"/api/imports/{import_id}/commit")
        self.assertEqual(response.status_code, 409)
        self.assertIn("need a decision", response.get_json()["error"])

    def test_ambiguous_rows_carry_their_candidates(self):
        import_id = self.upload(SEALED, "sealed.csv").get_json()["importId"]
        detail = self.client.get(f"/api/imports/{import_id}").get_json()
        ambiguous = next(i for i in detail["issues"] if i["code"] == "ambiguous")
        self.assertTrue(ambiguous["rows"][0]["candidates"])

    def test_skipping_a_row_clears_the_blocker(self):
        import_id = self.upload(SEALED, "sealed.csv").get_json()["importId"]
        detail = self.client.get(f"/api/imports/{import_id}").get_json()
        blocking_rows = [
            row
            for issue in detail["issues"] if issue["blocking"]
            for row in issue["rows"]
        ]
        for row in blocking_rows:
            body = self.post(
                f"/api/imports/{import_id}/rows/{row['id']}", {"skip": True}
            ).get_json()
        self.assertEqual(body["blocking"], 0)
        self.assertEqual(self.post(f"/api/imports/{import_id}/commit").status_code, 200)

    def test_discard_leaves_the_collection_untouched(self):
        import_id = self.upload().get_json()["importId"]
        self.post(f"/api/imports/{import_id}/discard")
        self.assertEqual(self.rows()["totalRows"], 0)
        listed = self.client.get("/api/imports").get_json()
        self.assertEqual(listed[0]["status"], "discarded")

    def test_missing_import_is_404(self):
        self.assertEqual(self.client.get("/api/imports/999").status_code, 404)


class TestHistoryAndUndo(Base):
    def test_undo_reverses_a_bulk_edit(self):
        self.commit()
        ids = [r["id"] for r in self.rows()["rows"]]
        before = {r["id"]: r["priceCents"] for r in self.rows()["rows"]}

        self.post("/api/bulk", {"action": "adjust_price", "value": "10", "ids": ids})
        self.assertNotEqual(
            {r["id"]: r["priceCents"] for r in self.rows()["rows"]}, before
        )

        undone = self.post("/api/undo").get_json()
        self.assertIn("Adjusted", undone["summary"])
        self.assertEqual(
            {r["id"]: r["priceCents"] for r in self.rows()["rows"]}, before
        )

    def test_undo_reverses_an_import(self):
        self.commit()
        self.commit(SAMPLE2, "sample2.csv")
        self.assertEqual(self.rows()["totals"]["quantity"], 31)
        self.post("/api/undo")
        self.assertEqual(self.rows()["totals"]["quantity"], 17)

    def test_history_records_both_states(self):
        self.commit()
        self.post("/api/undo")
        history = self.client.get("/api/history").get_json()
        self.assertTrue(history[0]["reverted"])

    def test_nothing_to_undo(self):
        response = self.post("/api/undo")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.get_json()["code"], "nothing-to-undo")


class TestSpaShell(Base):
    def test_unknown_api_path_is_json_not_html(self):
        response = self.client.get("/api/nope")
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.get_json()["code"], "not-found")

    def test_a_client_route_falls_through_to_the_shell(self):
        """React Router owns /history and /imports in the browser."""
        for path in ("/", "/history", "/imports/1"):
            with self.subTest(path=path):
                self.assertIn(self.client.get(path).status_code, (200, 503))

    def test_a_missing_build_says_how_to_fix_it(self):
        """Deterministic rather than conditional on whether dist/ exists.

        An earlier version skipped when the front end happened to be built —
        and borrowed the sanctioned "exports not present" wording to get past
        the skip guard, which is precisely the erosion that guard exists to
        prevent. Pointing DIST at an empty directory tests the branch either way.
        """
        import tempfile

        from webapp import app as app_module

        original = app_module.DIST
        with tempfile.TemporaryDirectory() as empty:
            app_module.DIST = empty
            try:
                response = self.client.get("/")
                body = response.get_data(as_text=True)
            finally:
                app_module.DIST = original

        self.assertEqual(response.status_code, 503)
        self.assertIn("npm --prefix frontend", body)
        self.assertIn("run build", body)


class TestLoopbackOnly(unittest.TestCase):
    def test_serve_refuses_a_routable_bind(self):
        for host in ("0.0.0.0", "192.168.1.10", ""):
            with self.subTest(host=host):
                with self.assertRaises(ValueError):
                    serve(host=host)

    def test_loopback_is_the_default(self):
        import inspect

        self.assertEqual(
            inspect.signature(serve).parameters["host"].default, "127.0.0.1"
        )


class TestThreading(unittest.TestCase):
    """Kept from the fix for the bug that shipped: one connection per thread.

    A test client runs in the calling thread, so the original suite passed
    while the real server 500'd on every page. These drive the app from worker
    threads and against a file database.
    """

    def test_requests_from_other_threads_succeed(self):
        import threading

        app = create_app(":memory:", testing=True)
        results = []

        def hit():
            results.append(app.test_client().get("/api/collection").status_code)

        threads = [threading.Thread(target=hit) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(results, [200] * 4)

    def test_a_write_in_one_thread_is_visible_in_another(self):
        import threading

        app = create_app(":memory:", testing=True)
        client = app.test_client()
        token = client.get("/api/session").get_json()["csrfToken"]
        client.post(
            "/api/imports",
            data={"file": (io.BytesIO(read(SAMPLE)), "sample.csv")},
            content_type="multipart/form-data",
            headers={"X-CSRF-Token": token},
        )

        seen = []

        def look():
            seen.append(len(app.test_client().get("/api/imports").get_json()))

        thread = threading.Thread(target=look)
        thread.start()
        thread.join()
        self.assertEqual(seen, [1], "another thread saw a different database")

    def test_a_file_backed_database_works_end_to_end(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "collection.db")
            app = create_app(path, testing=True)
            client = app.test_client()
            token = client.get("/api/session").get_json()["csrfToken"]

            import_id = client.post(
                "/api/imports",
                data={"file": (io.BytesIO(read(SAMPLE)), "sample.csv")},
                content_type="multipart/form-data",
                headers={"X-CSRF-Token": token},
            ).get_json()["importId"]
            client.post(
                f"/api/imports/{import_id}/commit", headers={"X-CSRF-Token": token}
            )

            again = create_app(path, testing=True).test_client()
            self.assertEqual(
                again.get("/api/collection").get_json()["totals"]["value"], "$431.57"
            )


if __name__ == "__main__":
    unittest.main()


class TestInsights(Base):
    """Chart data. The invariants matter more than the shapes."""

    def setUp(self):
        super().setUp()
        self.commit()

    def test_tiers_sum_to_the_collection_total(self):
        body = self.client.get("/api/collection/insights").get_json()
        self.assertEqual(
            sum(t["marketCents"] for t in body["tiers"]),
            body["totals"]["valueCents"],
        )

    def test_tier_estimates_match_the_documented_rates(self):
        """Same arithmetic as `binders.aggregate.price_tiers`: band then rate."""
        for tier in self.client.get("/api/collection/insights").get_json()["tiers"]:
            with self.subTest(tier=tier["tier"]):
                self.assertEqual(
                    tier["cashCents"],
                    round(tier["marketCents"] * tier["cashPct"] / 100),
                )
                self.assertEqual(
                    tier["creditCents"],
                    round(tier["marketCents"] * tier["creditPct"] / 100),
                )

    def test_sets_sum_to_the_collection_total(self):
        body = self.client.get("/api/collection/insights").get_json()
        self.assertEqual(
            sum(s["cents"] for s in body["sets"]), body["totals"]["valueCents"]
        )

    def test_rarity_sums_to_the_collection_total(self):
        body = self.client.get("/api/collection/insights").get_json()
        self.assertEqual(
            sum(r["cents"] for r in body["rarity"]), body["totals"]["valueCents"]
        )

    def test_concentration_covers_priced_rows_and_ends_at_100(self):
        conc = self.client.get("/api/collection/insights").get_json()["concentration"]
        self.assertEqual(len(conc["points"]), conc["pricedRows"])
        self.assertAlmostEqual(conc["points"][-1]["valuePct"], 100.0, places=1)

    def test_insights_respect_the_filter(self):
        """A chart that ignored the filter would describe a different slice
        than the table under it."""
        everything = self.client.get("/api/collection/insights").get_json()
        filtered = self.client.get(
            "/api/collection/insights?price_min=10"
        ).get_json()
        self.assertLess(
            filtered["totals"]["valueCents"], everything["totals"]["valueCents"]
        )
        self.assertEqual(
            sum(t["marketCents"] for t in filtered["tiers"]),
            filtered["totals"]["valueCents"],
        )

    def test_insights_reject_an_unknown_filter_too(self):
        response = self.client.get("/api/collection/insights?prices_min=10")
        self.assertEqual(response.status_code, 400)

    def test_empty_collection_does_not_crash(self):
        empty = create_app(":memory:", testing=True).test_client()
        body = empty.get("/api/collection/insights").get_json()
        self.assertEqual(body["concentration"]["points"], [])
        self.assertEqual(sum(t["marketCents"] for t in body["tiers"]), 0)


class TestSalesAndExport(Base):
    """The sale lifecycle and the escape hatch."""

    def setUp(self):
        super().setUp()
        self.commit()
        self.ids = [r["id"] for r in self.rows()["rows"]]
        # Mark the three priciest to sell; the queue is verdict-driven.
        self.post("/api/bulk", {"action": "verdict", "value": "sell",
                                "ids": self.ids[:3]})

    # -- queue ------------------------------------------------------------

    def test_queue_is_driven_by_verdicts(self):
        queue = self.client.get("/api/sales/queue").get_json()
        self.assertEqual(len(queue), 3)
        self.assertEqual(queue[0]["name"], "Mox Amber")
        self.assertIsNone(queue[0]["sale"])

    def test_listing_then_selling(self):
        queue = self.client.get("/api/sales/queue").get_json()
        subject = queue[0]

        listed = self.post("/api/sales/list", {
            "kind": subject["kind"], "id": subject["id"], "channel": "ebay",
        })
        self.assertEqual(listed.status_code, 201)
        sale_id = listed.get_json()["saleId"]

        sold = self.post(f"/api/sales/{sale_id}/sold", {
            "sold": "200.00", "fees": "26.00", "shipping": "5.00",
        }).get_json()

        # 20000 - 2600 - 500
        self.assertEqual(sold["netCents"], 16900)
        self.assertEqual(sold["net"], "$169.00")
        self.assertTrue(sold["removedFromCollection"])

    def test_a_sold_card_leaves_the_collection(self):
        """Leaving it in would inflate every valuation after the fact."""
        before = self.rows()["totals"]["quantity"]
        queue = self.client.get("/api/sales/queue").get_json()
        sale_id = self.post("/api/sales/list", {
            "kind": queue[0]["kind"], "id": queue[0]["id"],
        }).get_json()["saleId"]
        self.post(f"/api/sales/{sale_id}/sold", {"sold": "200.00"})

        self.assertEqual(
            self.rows()["totals"]["quantity"], before - queue[0]["quantity"]
        )

    def test_partial_quantity_leaves_the_rest(self):
        queue = self.client.get("/api/sales/queue").get_json()
        mox = next(q for q in queue if q["name"] == "Mox Amber")
        self.assertEqual(mox["quantity"], 3)

        sale_id = self.post("/api/sales/list", {
            "kind": mox["kind"], "id": mox["id"], "quantity": 1,
        }).get_json()["saleId"]
        result = self.post(f"/api/sales/{sale_id}/sold", {"sold": "80.00"}).get_json()

        self.assertFalse(result["removedFromCollection"])
        row = next(r for r in self.rows()["rows"] if r["title"] == "Mox Amber")
        self.assertEqual(row["quantity"], 2)

    def test_realized_gain_is_null_without_a_cost_basis(self):
        """An unknown basis must not become a gain equal to the sale price —
        that number would land straight in a tax figure."""
        queue = self.client.get("/api/sales/queue").get_json()
        sale_id = self.post("/api/sales/list", {
            "kind": queue[0]["kind"], "id": queue[0]["id"],
        }).get_json()["saleId"]
        sold = self.post(f"/api/sales/{sale_id}/sold", {"sold": "200.00"}).get_json()

        self.assertIsNone(sold["realizedGainCents"])
        summary = self.client.get("/api/sales/summary").get_json()
        self.assertEqual(summary["gainKnownFor"], 0)

    def test_cannot_list_the_same_thing_twice(self):
        queue = self.client.get("/api/sales/queue").get_json()
        body = {"kind": queue[0]["kind"], "id": queue[0]["id"]}
        self.post("/api/sales/list", body)
        again = self.post("/api/sales/list", body)
        self.assertEqual(again.status_code, 400)
        self.assertIn("already listed", again.get_json()["error"])

    def test_cannot_list_more_than_you_own(self):
        queue = self.client.get("/api/sales/queue").get_json()
        response = self.post("/api/sales/list", {
            "kind": queue[0]["kind"], "id": queue[0]["id"], "quantity": 99,
        })
        self.assertEqual(response.status_code, 400)

    def test_negative_amounts_are_refused(self):
        queue = self.client.get("/api/sales/queue").get_json()
        sale_id = self.post("/api/sales/list", {
            "kind": queue[0]["kind"], "id": queue[0]["id"],
        }).get_json()["saleId"]
        response = self.post(f"/api/sales/{sale_id}/sold",
                             {"sold": "100.00", "fees": "-5"})
        self.assertEqual(response.status_code, 400)

    def test_summary_totals(self):
        queue = self.client.get("/api/sales/queue").get_json()
        sale_id = self.post("/api/sales/list", {
            "kind": queue[0]["kind"], "id": queue[0]["id"],
        }).get_json()["saleId"]
        self.post(f"/api/sales/{sale_id}/sold",
                  {"sold": "200.00", "fees": "26.00", "shipping": "5.00"})

        summary = self.client.get("/api/sales/summary").get_json()
        self.assertEqual(summary["soldCount"], 1)
        self.assertEqual(summary["grossCents"], 20000)
        self.assertEqual(summary["costsCents"], 3100)
        self.assertEqual(summary["netCents"], 16900)
        self.assertEqual(summary["net"], "$169.00")

    def test_a_sale_is_undoable(self):
        before = self.rows()["totals"]["quantity"]
        queue = self.client.get("/api/sales/queue").get_json()
        sale_id = self.post("/api/sales/list", {
            "kind": queue[0]["kind"], "id": queue[0]["id"],
        }).get_json()["saleId"]
        self.post(f"/api/sales/{sale_id}/sold", {"sold": "200.00"})
        self.assertLess(self.rows()["totals"]["quantity"], before)

        self.post("/api/undo")
        self.assertEqual(self.rows()["totals"]["quantity"], before)

    # -- export -----------------------------------------------------------

    def test_manifest_counts_the_tables(self):
        body = self.client.get("/api/export/manifest").get_json()
        self.assertIn("holdings", body["tables"])
        self.assertEqual(body["rowCounts"]["holdings"], 6)
        self.assertEqual(body["singles"]["value"], "$431.57")

    def test_table_export_writes_dollars_not_cents(self):
        """A spreadsheet should show 75.17, not 7517."""
        text = self.client.get("/api/export/table/holdings").get_data(as_text=True)
        self.assertIn("75.17", text)
        self.assertNotIn("7517", text)
        # …and the header says `price`, not `price_cents`.
        self.assertIn("price,", text.splitlines()[0])

    def test_unknown_table_is_refused(self):
        self.assertEqual(
            self.client.get("/api/export/table/sqlite_master").status_code, 404
        )

    def test_ledger_uses_the_vault_schema(self):
        import csv as _csv
        from binders.export import LEDGER_COLUMNS

        text = self.client.get("/api/export/ledger").get_data(as_text=True)
        rows = list(_csv.DictReader(io.StringIO(text)))
        self.assertEqual(list(rows[0].keys()), list(LEDGER_COLUMNS))
        self.assertEqual(len(rows), 6)

    def test_ledger_carries_sale_figures_once_sold(self):
        import csv as _csv

        queue = self.client.get("/api/sales/queue").get_json()
        mox = next(q for q in queue if q["name"] == "Mox Amber")
        sale_id = self.post("/api/sales/list", {
            "kind": mox["kind"], "id": mox["id"], "quantity": 1,
        }).get_json()["saleId"]
        self.post(f"/api/sales/{sale_id}/sold",
                  {"sold": "80.00", "fees": "10.40"})

        text = self.client.get("/api/export/ledger").get_data(as_text=True)
        row = next(
            r for r in _csv.DictReader(io.StringIO(text)) if r["Name"] == "Mox Amber"
        )
        self.assertEqual(row["Sold"], "80.00")
        self.assertEqual(row["Net Proceeds"], "69.60")

    def test_a_sold_and_gone_item_still_appears_in_the_ledger(self):
        """The bug live verification caught.

        A fully-sold item is deleted from holdings, so a ledger built only from
        the collection dropped it entirely — losing exactly the realized-gain
        record the ledger exists for. `subject_name` is captured at listing time
        so the row survives its subject.
        """
        import csv as _csv

        queue = self.client.get("/api/sales/queue").get_json()
        target = queue[0]
        sale_id = self.post("/api/sales/list", {
            "kind": target["kind"], "id": target["id"],
        }).get_json()["saleId"]
        self.post(f"/api/sales/{sale_id}/sold",
                  {"sold": "300.00", "fees": "39.00"})

        # Gone from the collection…
        self.assertNotIn(
            target["name"], [r["title"] for r in self.rows()["rows"]]
        )

        # …but present in the ledger, with its figures intact.
        text = self.client.get("/api/export/ledger").get_data(as_text=True)
        rows = list(_csv.DictReader(io.StringIO(text)))
        sold_row = next((r for r in rows if r["Name"] == target["name"]), None)
        self.assertIsNotNone(sold_row, "the sold item vanished from the ledger")
        self.assertEqual(sold_row["Sold"], "300.00")
        self.assertEqual(sold_row["Net Proceeds"], "261.00")
        self.assertEqual(sold_row["Market Value"], "")  # no longer owned
        self.assertTrue(sold_row["Source"].startswith("sold"))

    def test_a_partially_sold_item_is_not_duplicated_in_the_ledger(self):
        """It is still held, so it must appear once — as a holding."""
        import csv as _csv

        queue = self.client.get("/api/sales/queue").get_json()
        mox = next(q for q in queue if q["name"] == "Mox Amber")
        sale_id = self.post("/api/sales/list", {
            "kind": mox["kind"], "id": mox["id"], "quantity": 1,
        }).get_json()["saleId"]
        self.post(f"/api/sales/{sale_id}/sold", {"sold": "80.00"})

        text = self.client.get("/api/export/ledger").get_data(as_text=True)
        rows = [
            r for r in _csv.DictReader(io.StringIO(text)) if r["Name"] == "Mox Amber"
        ]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["Quantity"], "2")

    def test_bundle_contains_everything(self):
        import zipfile

        response = self.client.get("/api/export/bundle")
        self.assertEqual(response.status_code, 200)
        archive = zipfile.ZipFile(io.BytesIO(response.get_data()))
        names = archive.namelist()

        self.assertIn("manifest.json", names)
        self.assertIn("mtg_collection_tracker.csv", names)
        self.assertIn("csv/holdings.csv", names)
        # The zip must be readable — a corrupt archive is worse than none.
        self.assertIsNone(archive.testzip())

    def test_bundle_includes_the_database_for_a_file_backed_app(self):
        import sqlite3 as _sqlite3
        import tempfile
        import zipfile

        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "c.db")
            app = create_app(path, testing=True)
            client = app.test_client()
            token = client.get("/api/session").get_json()["csrfToken"]
            import_id = client.post(
                "/api/imports",
                data={"file": (io.BytesIO(read(SAMPLE)), "sample.csv")},
                content_type="multipart/form-data",
                headers={"X-CSRF-Token": token},
            ).get_json()["importId"]
            client.post(f"/api/imports/{import_id}/commit",
                        headers={"X-CSRF-Token": token})

            archive = zipfile.ZipFile(
                io.BytesIO(client.get("/api/export/bundle").get_data())
            )
            self.assertIn("collection.sqlite", archive.namelist())

            # The extracted copy must be a working database, not just bytes.
            out = os.path.join(tmp, "restored.sqlite")
            with open(out, "wb") as handle:
                handle.write(archive.read("collection.sqlite"))
            restored = _sqlite3.connect(out)
            count = restored.execute("SELECT COUNT(*) FROM holdings").fetchone()[0]
            restored.close()
            self.assertEqual(count, 6)


class TestSealedReachable(Base):
    """Sealed used to be a one-way door.

    The import screen advertised that it accepted sealed lists, rows landed in
    the table, and then nothing could query, show or edit them again — they were
    reachable only through a full export. These pin the round trip.
    """

    def setUp(self):
        super().setUp()
        import_id = self.upload(SEALED, "sealed.csv").get_json()["importId"]
        # Skip the rows that can't resolve, so the rest can commit.
        detail = self.client.get(f"/api/imports/{import_id}").get_json()
        for issue in detail["issues"]:
            if issue["blocking"]:
                for row in issue["rows"]:
                    self.post(
                        f"/api/imports/{import_id}/rows/{row['id']}", {"skip": True}
                    )
        self.post(f"/api/imports/{import_id}/commit")

    def sealed(self, query=""):
        return self.client.get(f"/api/sealed{query}").get_json()

    def test_imported_sealed_is_visible(self):
        body = self.sealed()
        self.assertGreater(body["totalRows"], 0)
        names = [r["name"] for r in body["rows"]]
        self.assertTrue(any("Sneak Attack" in n for n in names), names)

    def test_rows_carry_resolved_identity_not_just_the_typed_name(self):
        row = next(r for r in self.sealed()["rows"] if "Sneak Attack" in r["name"])
        self.assertTrue(row["resolved"])
        self.assertEqual(row["setCode"], "ZNC")
        self.assertTrue(row["purchaseUrl"].startswith("https://mtgjson.com/links/"))

    def test_money_is_integer_cents_here_too(self):
        row = next(r for r in self.sealed()["rows"] if "Sneak Attack" in r["name"])
        self.assertEqual(row["priceCents"], 4200)
        self.assertIsInstance(row["priceCents"], int)
        self.assertEqual(row["price"], "$42.00")

    def test_import_keeps_every_money_and_provenance_column(self):
        """The regression that hid behind the one-way door.

        `_stage_sealed` read only name, set, quantity and condition, so Price,
        Price date, Source and Cost basis were dropped on every sealed import
        ever run. Nothing caught it because nothing could read a sealed row
        back. One assertion per column, since a single lost column is the
        whole failure.
        """
        row = next(r for r in self.sealed()["rows"] if "Sneak Attack" in r["name"])
        self.assertEqual(row["priceCents"], 4200)
        self.assertEqual(row["priceDate"], "2026-07-27")
        self.assertEqual(row["priceSource"], "tcgplayer")
        self.assertEqual(row["costBasisCents"], 3500)
        # And the derived figure that depends on two of them.
        self.assertEqual(row["gainCents"], 4200 - 3500)

    def test_gain_is_null_without_a_cost_basis(self):
        unpriced = [r for r in self.sealed()["rows"] if r["costBasisCents"] is None]
        self.assertTrue(unpriced)
        self.assertIsNone(unpriced[0]["gainCents"])

    def test_totals_and_unpriced_count(self):
        totals = self.sealed()["totals"]
        self.assertGreater(totals["valueCents"], 0)
        self.assertGreater(totals["unpriced"], 0)

    def test_filters_work_and_typos_are_rejected(self):
        self.assertLess(
            self.sealed("?unpriced=1")["totalRows"], self.sealed()["totalRows"]
        )
        response = self.client.get("/api/sealed?prices_min=10")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()["code"], "bad-filter")

    def test_insights_carry_no_card_kingdom_rates(self):
        """Sealed isn't going to CK, so those bands would match no real offer."""
        body = self.client.get("/api/sealed/insights").get_json()
        self.assertIn("byYear", body)
        self.assertIn("coverage", body)
        blob = json.dumps(body)
        for token in ("cashCents", "creditCents", "cashPct", "tiers"):
            self.assertNotIn(token, blob, token)

    def test_coverage_splits_every_deck(self):
        body = self.client.get("/api/sealed/insights").get_json()
        cov = body["coverage"]
        self.assertEqual(
            cov["priced"] + cov["unpriced"], body["totals"]["quantity"]
        )

    # -- bulk over sealed --------------------------------------------------

    def test_actions_offered_differ_by_kind(self):
        sealed = {
            a["key"] for a in self.client.get("/api/bulk/actions?kind=sealed").get_json()
        }
        holding = {
            a["key"] for a in self.client.get("/api/bulk/actions?kind=holding").get_json()
        }
        # Sealed has a cost basis; singles have a language.
        self.assertIn("cost_basis", sealed)
        self.assertNotIn("cost_basis", holding)
        self.assertIn("language", holding)
        self.assertNotIn("language", sealed)

    def test_a_verdict_on_sealed_reaches_the_sell_queue(self):
        """The end of the one-way door: sealed can now be triaged and sold."""
        ids = [r["id"] for r in self.sealed()["rows"][:2]]
        self.post("/api/bulk", {
            "kind": "sealed", "action": "verdict", "value": "sell", "ids": ids,
        })

        queue = self.client.get("/api/sales/queue").get_json()
        sealed_in_queue = [q for q in queue if q["kind"] == "sealed"]
        self.assertEqual(len(sealed_in_queue), 2)

    def test_bulk_price_on_sealed_then_undo(self):
        before = {r["id"]: r["priceCents"] for r in self.sealed()["rows"]}
        ids = list(before)

        self.post("/api/bulk", {
            "kind": "sealed", "action": "price", "value": "10.00", "ids": ids,
        })
        after = {r["id"]: r["priceCents"] for r in self.sealed()["rows"]}
        self.assertTrue(all(v == 1000 for v in after.values()))

        self.post("/api/undo")
        self.assertEqual(
            {r["id"]: r["priceCents"] for r in self.sealed()["rows"]}, before
        )

    def test_cost_basis_turns_a_sale_into_a_realized_gain(self):
        row = next(r for r in self.sealed()["rows"] if r["priceCents"] is not None)
        self.post("/api/bulk", {
            "kind": "sealed", "action": "cost_basis", "value": "20.00",
            "ids": [row["id"]],
        })
        self.post("/api/bulk", {
            "kind": "sealed", "action": "verdict", "value": "sell", "ids": [row["id"]],
        })

        item = next(
            q for q in self.client.get("/api/sales/queue").get_json()
            if q["kind"] == "sealed" and q["id"] == row["id"]
        )
        sale_id = self.post("/api/sales/list", {
            "kind": "sealed", "id": item["id"],
        }).get_json()["saleId"]
        sold = self.post(f"/api/sales/{sale_id}/sold", {"sold": "60.00"}).get_json()

        # 6000 - (2000 * quantity)
        self.assertIsNotNone(sold["realizedGainCents"])
        self.assertEqual(sold["realizedGainCents"], 6000 - 2000 * item["quantity"])

    def test_select_all_matching_respects_the_sealed_filter(self):
        body = self.post("/api/bulk", {
            "kind": "sealed", "action": "verdict", "value": "keep",
            "selectAll": True, "filters": {"unpriced": "1"},
        }).get_json()
        unpriced = self.sealed("?unpriced=1")["totalRows"]
        self.assertEqual(body["affected"], unpriced)

    def test_an_action_that_does_not_apply_is_refused(self):
        ids = [r["id"] for r in self.sealed()["rows"][:1]]
        response = self.post("/api/bulk", {
            "kind": "sealed", "action": "language", "value": "en", "ids": ids,
        })
        self.assertEqual(response.status_code, 400)
        self.assertIn("does not apply", response.get_json()["error"])

    def test_bulk_delete_on_sealed_reverses(self):
        before = self.sealed()["totalRows"]
        ids = [r["id"] for r in self.sealed()["rows"][:2]]
        self.post("/api/bulk", {"kind": "sealed", "action": "delete", "ids": ids})
        self.assertEqual(self.sealed()["totalRows"], before - 2)

        self.post("/api/undo")
        self.assertEqual(self.sealed()["totalRows"], before)

    def test_sealed_appears_in_the_ledger(self):
        import csv as _csv

        text = self.client.get("/api/export/ledger").get_data(as_text=True)
        rows = list(_csv.DictReader(io.StringIO(text)))
        self.assertTrue(any(r["Source"] == "sealed" for r in rows))


class TestKindDetection(Base):
    """Which file is which.

    The two formats overlap: a legacy ManaBox export starts
    `Name,Set code,…,Quantity,…`, so it satisfies any sealed test loose enough
    to accept a hand-written deck list. The order of the checks is what keeps
    both honest, and these pin it from both sides.
    """

    def detect(self, text):
        return importer.detect_kind(text)

    def test_a_two_column_sealed_list_is_accepted(self):
        # What `sealed template` produces, and what the rejection message has
        # always promised was enough. It used to be rejected anyway.
        kind, dialect = self.detect("Name,Quantity\r\nSneak Attack,1\r\n")
        self.assertEqual(kind, "sealed")
        self.assertEqual(dialect, "sealed.csv")

    def test_a_legacy_manabox_export_is_never_read_as_sealed(self):
        """The expensive direction to get wrong.

        These headers carry Name *and* Quantity. Misfiling one would put every
        single in the sealed table, where the singles views cannot see them.
        """
        header = (
            "Name,Set code,Set name,Collector number,Foil,Rarity,Quantity,"
            "ManaBox ID,Scryfall ID,Purchase price,Misprint,Altered,Condition,"
            "Language,Purchase price currency,Added"
        )
        kind, dialect = self.detect(header + "\r\nBlack Lotus,LEA,Alpha,232,normal,rare,1,,,,,,near_mint,en,USD,\r\n")
        self.assertEqual(kind, "singles")
        self.assertIn("legacy", dialect)

    def test_the_current_manabox_dialect_still_wins_too(self):
        kind, _ = self.detect(read(SAMPLE).decode("utf-8"))
        self.assertEqual(kind, "singles")

    def test_a_file_that_is_neither_is_still_rejected(self):
        with self.assertRaises(importer.DetectionError):
            self.detect("Foo,Bar\r\n1,2\r\n")

    def test_a_minimal_sealed_list_survives_the_whole_round_trip(self):
        """Detection alone isn't the claim — the rows have to land and show up."""
        body = self.client.post(
            "/api/imports",
            data={"file": (io.BytesIO(b"Name,Quantity\r\nSneak Attack,2\r\n"), "decks.csv")},
            content_type="multipart/form-data",
            headers={"X-CSRF-Token": self.token},
        ).get_json()
        self.assertEqual(body["kind"], "sealed")

        self.post(f"/api/imports/{body['importId']}/commit")
        rows = self.client.get("/api/sealed").get_json()["rows"]
        self.assertEqual(len(rows), 1)
        # The nickname resolves to the full product, and what was typed is kept
        # alongside it rather than overwritten.
        self.assertEqual(rows[0]["rawName"], "Sneak Attack")
        self.assertEqual(rows[0]["name"], "Zendikar Rising Commander Deck Sneak Attack")
        self.assertTrue(rows[0]["resolved"])
        self.assertEqual(rows[0]["quantity"], 2)
        # No price column in the file, so no price is invented.
        self.assertIsNone(rows[0]["priceCents"])


class TestBuylistExport(Base):
    """The list you hand Card Kingdom.

    `to_buylist_csv` was CLI-only, so the app that owns the verdicts couldn't
    emit the shipment they imply.
    """

    def setUp(self):
        super().setUp()
        self.commit()
        self.all_rows = self.rows()["rows"]

    def mark(self, rows, verdict="sell"):
        self.post("/api/bulk", {
            "action": "verdict", "value": verdict,
            "ids": [r["id"] for r in rows],
        })

    def buylist(self, query=""):
        text = self.client.get(f"/api/export/buylist{query}").get_data(as_text=True)
        return list(csv.DictReader(io.StringIO(text)))

    def summary(self, query=""):
        return self.client.get(f"/api/export/buylist/summary{query}").get_json()

    def test_nothing_marked_means_an_empty_list_not_the_whole_collection(self):
        self.assertEqual(self.buylist(), [])
        self.assertEqual(self.summary()["rows"], 0)

    def test_only_rows_marked_sell_are_on_it(self):
        picked = [r for r in self.all_rows if r["priceCents"] and r["priceCents"] >= 100][:2]
        self.mark(picked)
        names = {r["Name"] for r in self.buylist()}
        self.assertEqual(names, {r["title"] for r in picked})

    def test_a_keep_verdict_is_not_a_sell_verdict(self):
        picked = [r for r in self.all_rows if r["priceCents"] and r["priceCents"] >= 100][:2]
        self.mark(picked, "keep")
        self.assertEqual(self.buylist(), [])

    def test_sub_dollar_cards_are_left_off_and_the_floor_moves(self):
        # Built here rather than filtered out of the fixture: the fixture has
        # no sub-$1 card, and a test that skips when it can't find one asserts
        # nothing on the machine where it matters.
        header = ",".join([
            "Title", "Edition", "Foil", "Quantity", "Set name", "Collector number",
            "Rarity", "ManaBox ID", "Scryfall ID", "Purchase price", "Misprint",
            "Altered", "Condition", "Language", "Purchase price currency", "Added",
        ])
        cheap = (
            f"{header}\r\n"
            "Llanowar Elves,M19,0,4,Core Set 2019,314,common,1,1a,0.35,"
            "false,false,near_mint,en,USD,2026-06-26T22:22:28.140Z\r\n"
        ).encode("utf-8")
        import_id = self.client.post(
            "/api/imports",
            data={"file": (io.BytesIO(cheap), "cheap.csv")},
            content_type="multipart/form-data",
            headers={"X-CSRF-Token": self.token},
        ).get_json()["importId"]
        self.post(f"/api/imports/{import_id}/commit")

        row = next(r for r in self.rows()["rows"] if r["priceCents"] == 35)
        self.mark([row])

        self.assertEqual(self.buylist(), [])
        kept = self.buylist("?min_price=0")
        self.assertEqual([r["Name"] for r in kept], ["Llanowar Elves"])
        self.assertEqual(kept[0]["Market total"], "1.40")

    def test_a_listed_card_is_not_shipped_twice(self):
        picked = [r for r in self.all_rows if r["priceCents"] and r["priceCents"] >= 100][:2]
        self.mark(picked)
        self.assertEqual(len(self.buylist()), 2)

        self.post("/api/sales/list", {"kind": "holding", "id": picked[0]["id"]})
        remaining = {r["Name"] for r in self.buylist()}
        self.assertEqual(remaining, {picked[1]["title"]})

    def test_estimates_match_the_tier_the_card_falls_in(self):
        prime = [r for r in self.all_rows if (r["priceCents"] or 0) >= 2000][:1]
        self.assertTrue(prime, "fixture should carry at least one $20+ card")
        self.mark(prime)
        row = self.buylist()[0]
        total = Decimal(row["Market total"])
        # $20+ band: 60% cash, 75% credit. Same CK_TIERS the CLI quotes.
        self.assertEqual(Decimal(row["Est. cash"]), (total * Decimal("0.60")).quantize(Decimal("0.01")))
        self.assertEqual(Decimal(row["Est. credit"]), (total * Decimal("0.75")).quantize(Decimal("0.01")))

    def test_the_summary_agrees_with_the_file(self):
        picked = [r for r in self.all_rows if r["priceCents"] and r["priceCents"] >= 100][:3]
        self.mark(picked)
        summary = self.summary()
        rows = self.buylist()
        self.assertEqual(summary["rows"], len(rows))
        self.assertEqual(
            summary["marketCents"],
            int(sum(Decimal(r["Market total"]) for r in rows) * 100),
        )

    def test_sealed_never_appears_on_a_card_kingdom_list(self):
        import_id = self.upload(SEALED, "sealed.csv").get_json()["importId"]
        detail = self.client.get(f"/api/imports/{import_id}").get_json()
        for issue in detail["issues"]:
            if issue["blocking"]:
                for row in issue["rows"]:
                    self.post(f"/api/imports/{import_id}/rows/{row['id']}", {"skip": True})
        self.post(f"/api/imports/{import_id}/commit")

        sealed = self.client.get("/api/sealed").get_json()["rows"]
        self.assertTrue(sealed)
        self.post("/api/bulk", {
            "kind": "sealed", "action": "verdict", "value": "sell",
            "ids": [r["id"] for r in sealed],
        })
        # Marked sell, priced, and still absent: CK's rates are singles rates.
        names = {r["Name"] for r in self.buylist()}
        self.assertFalse(names & {r["name"] for r in sealed})

    def test_a_bad_minimum_is_refused_rather_than_ignored(self):
        self.assertEqual(
            self.client.get("/api/export/buylist?min_price=cheap").status_code, 400
        )
        self.assertEqual(
            self.client.get("/api/export/buylist?min_price=-5").status_code, 400
        )

    # -- the Card Kingdom shape ------------------------------------------

    MANABOX_HEADER = ",".join([
        "Title", "Edition", "Foil", "Quantity", "Set name", "Collector number",
        "Rarity", "ManaBox ID", "Scryfall ID", "Purchase price", "Misprint",
        "Altered", "Condition", "Language", "Purchase price currency", "Added",
    ])

    def import_rows(self, *rows):
        blob = (self.MANABOX_HEADER + "\r\n" + "\r\n".join(rows) + "\r\n").encode("utf-8")
        import_id = self.client.post(
            "/api/imports",
            data={"file": (io.BytesIO(blob), "extra.csv")},
            content_type="multipart/form-data",
            headers={"X-CSRF-Token": self.token},
        ).get_json()["importId"]
        self.post(f"/api/imports/{import_id}/commit")

    def ck_text(self, query=""):
        return self.client.get(f"/api/export/buylist/ck{query}").get_data(as_text=True)

    def ck(self, query=""):
        return list(csv.DictReader(io.StringIO(self.ck_text(query))))

    def test_ck_file_carries_exactly_the_columns_ck_accepts(self):
        """CK's importer rejects a file with any column beyond these four."""
        self.assertEqual(
            self.ck_text().split("\r\n")[0], "Card Name,Edition,Foil,Quantity"
        )

    def test_ck_edition_is_the_set_name_not_the_code(self):
        """CK matches on the set name; the code would silently miss their catalog."""
        self.import_rows(
            "Grizzly Bears,M19,0,3,Core Set 2019,316,common,9931,cke1,2.00,"
            "false,false,near_mint,en,USD,2026-06-26T22:22:28.140Z",
        )
        row = next(r for r in self.rows()["rows"] if r["title"] == "Grizzly Bears")
        self.mark([row])
        exported = next(r for r in self.ck() if r["Card Name"] == "Grizzly Bears")
        self.assertEqual(exported["Edition"], "Core Set 2019")
        self.assertEqual(exported["Quantity"], "3")

    def test_ck_foil_is_one_or_zero(self):
        self.import_rows(
            "Shimmer Dragon,M19,1,2,Core Set 2019,315,rare,9932,cke2,5.00,"
            "false,false,near_mint,en,USD,2026-06-26T22:22:28.140Z",
            "Plain Bear,M19,0,1,Core Set 2019,317,common,9933,cke3,3.00,"
            "false,false,near_mint,en,USD,2026-06-26T22:22:28.140Z",
        )
        picked = [
            r for r in self.rows()["rows"]
            if r["title"] in ("Shimmer Dragon", "Plain Bear")
        ]
        self.mark(picked)
        foil = {r["Card Name"]: r["Foil"] for r in self.ck()}
        self.assertEqual(foil["Shimmer Dragon"], "1")
        self.assertEqual(foil["Plain Bear"], "0")

    def test_ck_ships_the_same_pile_as_the_detailed_file(self):
        """Two files, one pile: same rows, same floor, same listed-exclusion."""
        picked = [r for r in self.all_rows if r["priceCents"] and r["priceCents"] >= 100][:3]
        self.mark(picked)
        self.assertEqual(
            {(r["Card Name"], r["Quantity"]) for r in self.ck()},
            {(r["Name"], r["Quantity"]) for r in self.buylist()},
        )
        self.post("/api/sales/list", {"kind": "holding", "id": picked[0]["id"]})
        self.assertEqual(
            {r["Card Name"] for r in self.ck()},
            {r["Name"] for r in self.buylist()},
        )

    def test_ck_refuses_a_bad_minimum_too(self):
        self.assertEqual(
            self.client.get("/api/export/buylist/ck?min_price=cheap").status_code, 400
        )


class TestSealedTemplate(Base):
    """The starter file the Sealed screen hands out."""

    def test_it_is_served_as_a_download(self):
        response = self.client.get("/api/sealed/template")
        self.assertEqual(response.status_code, 200)
        self.assertIn("text/csv", response.headers["Content-Type"])
        self.assertIn("sealed.csv", response.headers["Content-Disposition"])

    def test_it_is_the_same_bytes_the_cli_writes(self):
        from binders.sealed import template_csv

        body = self.client.get("/api/sealed/template").get_data(as_text=True)
        self.assertEqual(body, template_csv())

    def test_what_it_hands_out_imports_cleanly(self):
        """The point of the whole feature.

        A template the importer rejected would walk someone straight into the
        error it exists to prevent — so download it and put it back in.
        """
        body = self.client.get("/api/sealed/template").get_data()
        upload = self.client.post(
            "/api/imports",
            data={"file": (io.BytesIO(body), "sealed.csv")},
            content_type="multipart/form-data",
            headers={"X-CSRF-Token": self.token},
        ).get_json()
        self.assertEqual(upload["kind"], "sealed")

        detail = self.client.get(f"/api/imports/{upload['importId']}").get_json()
        self.assertEqual(detail["blocking"], 0)

        self.post(f"/api/imports/{upload['importId']}/commit")
        rows = self.client.get("/api/sealed").get_json()["rows"]
        self.assertEqual(len(rows), 2)
        self.assertTrue(all(r["resolved"] for r in rows))
        # The example rows carry no prices, and none are invented for them.
        self.assertTrue(all(r["priceCents"] is None for r in rows))
