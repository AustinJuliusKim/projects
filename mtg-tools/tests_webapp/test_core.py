"""Database, undo log, importer and bulk actions."""

from __future__ import annotations

import os
import unittest
from decimal import Decimal

from webapp import bulk, importer
from webapp import operations as ops
from webapp import repo
from webapp.db import connect, format_cents, init_db, money_columns, to_cents, transaction

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
        self.conn = connect(":memory:")
        init_db(self.conn)
        self.addCleanup(self.conn.close)

    def stage_and_commit(self, path, name=None):
        with transaction(self.conn):
            import_id, _ = importer.stage_import(
                self.conn, name or os.path.basename(path), read(path)
            )
        with transaction(self.conn):
            return importer.commit_import(self.conn, import_id)

    def holdings(self):
        return [dict(r) for r in self.conn.execute("SELECT * FROM holdings ORDER BY id")]


class TestMoney(Base):
    def test_no_money_column_is_ever_real(self):
        """SQLite has no decimal type; REAL would undo the Decimal discipline."""
        offenders = [c for c in money_columns(self.conn) if "REAL" in c[2]]
        self.assertEqual(offenders, [])
        self.assertGreater(len(money_columns(self.conn)), 5)

    def test_cents_round_trip_exactly(self):
        for text in ("9737.83", "75.17", "1.10", "0.01", "0"):
            self.assertEqual(
                to_cents(Decimal(text)), int(Decimal(text) * 100), text
            )

    def test_none_price_is_unknown_not_zero(self):
        self.assertIsNone(to_cents(None))
        self.assertIsNone(to_cents(""))
        self.assertEqual(format_cents(None), "—")
        self.assertEqual(format_cents(0), "$0.00")

    def test_price_survives_csv_to_db(self):
        self.stage_and_commit(SAMPLE)
        row = self.conn.execute(
            "SELECT price_cents FROM holdings WHERE title = 'Mox Amber'"
        ).fetchone()
        self.assertEqual(row["price_cents"], 7517)
        self.assertEqual(format_cents(row["price_cents"]), "$75.17")


class TestImporter(Base):
    def test_detects_both_manabox_dialects_and_sealed(self):
        current = read(SAMPLE).decode("utf-8-sig")
        legacy = current.replace("Title,Edition", "Name,Set code", 1)
        self.assertEqual(importer.detect_kind(current)[0], "singles")
        self.assertEqual(importer.detect_kind(legacy)[0], "singles")
        self.assertIn("legacy", importer.detect_kind(legacy)[1])
        self.assertEqual(
            importer.detect_kind(read(SEALED).decode("utf-8-sig"))[0], "sealed"
        )

    def test_unrecognized_file_is_rejected_with_the_header(self):
        with self.assertRaises(importer.DetectionError) as caught:
            importer.detect_kind("Alpha,Beta,Gamma\n1,2,3\n")
        self.assertIn("Alpha", str(caught.exception))

    def test_empty_file_is_rejected(self):
        with self.assertRaises(importer.DetectionError):
            importer.detect_kind("")

    def test_staging_does_not_touch_holdings(self):
        with transaction(self.conn):
            importer.stage_import(self.conn, "sample.csv", read(SAMPLE))
        self.assertEqual(self.holdings(), [])

    def test_discard_leaves_holdings_untouched(self):
        with transaction(self.conn):
            import_id, _ = importer.stage_import(self.conn, "s.csv", read(SAMPLE))
        with transaction(self.conn):
            importer.discard_import(self.conn, import_id)
        self.assertEqual(self.holdings(), [])
        self.assertEqual(
            self.conn.execute(
                "SELECT status FROM imports WHERE id = ?", (import_id,)
            ).fetchone()["status"],
            "discarded",
        )

    def test_commit_adds_rows(self):
        result = self.stage_and_commit(SAMPLE)
        self.assertEqual(result["added"], 6)
        self.assertEqual(repo.totals(self.conn)["quantity"], 17)

    def test_second_import_merges_quantities(self):
        self.stage_and_commit(SAMPLE)
        result = self.stage_and_commit(SAMPLE2)
        self.assertEqual(result["updated"], 1)
        mox = self.conn.execute(
            "SELECT quantity, price_cents FROM holdings WHERE title = 'Mox Amber'"
        ).fetchone()
        self.assertEqual(mox["quantity"], 13)     # 3 + 10
        self.assertEqual(mox["price_cents"], 7400)  # the later scan's price

    def test_the_same_file_cannot_be_imported_twice(self):
        """Re-importing an export would double every quantity."""
        self.stage_and_commit(SAMPLE)
        with self.assertRaises(FileExistsError) as caught:
            with transaction(self.conn):
                importer.stage_import(self.conn, "sample.csv", read(SAMPLE))
        self.assertIn("double", str(caught.exception))

    def test_blocking_rows_prevent_commit(self):
        with transaction(self.conn):
            import_id, _ = importer.stage_import(self.conn, "sealed.csv", read(SEALED))
        self.assertGreater(importer.blocking_count(self.conn, import_id), 0)
        with self.assertRaises(ValueError) as caught:
            with transaction(self.conn):
                importer.commit_import(self.conn, import_id)
        self.assertIn("need a decision", str(caught.exception))
        self.assertEqual(
            self.conn.execute("SELECT COUNT(*) c FROM sealed").fetchone()["c"], 0
        )

    def test_skipping_the_blocking_rows_allows_commit(self):
        with transaction(self.conn):
            import_id, _ = importer.stage_import(self.conn, "sealed.csv", read(SEALED))
        with transaction(self.conn):
            self.conn.execute(
                "UPDATE staged_rows SET state='skipped' "
                "WHERE import_id=? AND state='pending'",
                (import_id,),
            )
        with transaction(self.conn):
            result = importer.commit_import(self.conn, import_id)
        self.assertGreater(result["added"], 0)

    def test_advisory_issues_do_not_block(self):
        """A non-English card or a missing price is worth knowing, not blocking."""
        with transaction(self.conn):
            import_id, _ = importer.stage_import(self.conn, "sample.csv", read(SAMPLE))
        codes = set(importer.issues_for(self.conn, import_id))
        self.assertIn("language", codes)
        self.assertEqual(importer.blocking_count(self.conn, import_id), 0)


class TestUndo(Base):
    def test_import_commit_reverses_exactly(self):
        """The bug this caught: snapshotting after the mutation, not before."""
        self.stage_and_commit(SAMPLE)
        before = self.holdings()
        self.stage_and_commit(SAMPLE2)
        self.assertNotEqual(self.holdings(), before)

        with transaction(self.conn):
            ops.undo(self.conn)
        self.assertEqual(self.holdings(), before)

    def test_bulk_update_reverses_exactly(self):
        self.stage_and_commit(SAMPLE)
        before = self.holdings()
        ids = repo.matching_ids(self.conn, {})
        with transaction(self.conn):
            bulk.apply_action(self.conn, "adjust_price", ids, "10")
        self.assertNotEqual(self.holdings(), before)
        with transaction(self.conn):
            ops.undo(self.conn)
        self.assertEqual(self.holdings(), before)

    def test_bulk_delete_reverses_exactly(self):
        self.stage_and_commit(SAMPLE)
        before = self.holdings()
        ids = repo.matching_ids(self.conn, {"price_min": 10})
        with transaction(self.conn):
            bulk.apply_action(self.conn, "delete", ids)
        self.assertEqual(len(self.holdings()), len(before) - len(ids))
        with transaction(self.conn):
            ops.undo(self.conn)
        self.assertEqual(self.holdings(), before)

    def test_verdict_insert_reverses_into_deletion(self):
        self.stage_and_commit(SAMPLE)
        ids = repo.matching_ids(self.conn, {})
        with transaction(self.conn):
            bulk.apply_action(self.conn, "verdict", ids, "sell")
        self.assertEqual(
            self.conn.execute("SELECT COUNT(*) c FROM verdicts").fetchone()["c"], len(ids)
        )
        with transaction(self.conn):
            ops.undo(self.conn)
        self.assertEqual(
            self.conn.execute("SELECT COUNT(*) c FROM verdicts").fetchone()["c"], 0
        )

    def test_undo_is_newest_first(self):
        self.stage_and_commit(SAMPLE)
        ids = repo.matching_ids(self.conn, {})
        with transaction(self.conn):
            bulk.apply_action(self.conn, "verdict", ids, "sell")
        with transaction(self.conn):
            bulk.apply_action(self.conn, "condition", ids, "played")

        older = [o for o in ops.recent(self.conn) if o.kind == "bulk_verdict"][0]
        with self.assertRaises(LookupError) as caught:
            with transaction(self.conn):
                ops.undo(self.conn, older.id)
        self.assertIn("not the most recent", str(caught.exception))

    def test_undoing_twice_walks_back_two_steps(self):
        self.stage_and_commit(SAMPLE)
        baseline = self.holdings()
        ids = repo.matching_ids(self.conn, {})
        with transaction(self.conn):
            bulk.apply_action(self.conn, "adjust_price", ids, "10")
        with transaction(self.conn):
            bulk.apply_action(self.conn, "condition", ids, "played")
        for _ in range(2):
            with transaction(self.conn):
                ops.undo(self.conn)
        self.assertEqual(self.holdings(), baseline)

    def test_nothing_to_undo(self):
        with self.assertRaises(LookupError):
            with transaction(self.conn):
                ops.undo(self.conn)

    def test_a_failed_action_leaves_no_operation_behind(self):
        """The undo entry and the mutation commit together or not at all."""
        self.stage_and_commit(SAMPLE)
        count = lambda: self.conn.execute(
            "SELECT COUNT(*) c FROM operations"
        ).fetchone()["c"]
        before = count()
        with self.assertRaises(bulk.BulkError):
            with transaction(self.conn):
                bulk.apply_action(self.conn, "price", repo.matching_ids(self.conn, {}), "")
        self.assertEqual(count(), before)


class TestBulkSelection(Base):
    def setUp(self):
        super().setUp()
        self.stage_and_commit(SAMPLE)

    def test_select_all_matching_uses_the_filter_not_the_page(self):
        everything = bulk.resolve_selection(self.conn, select_all=True, filters={})
        expensive = bulk.resolve_selection(
            self.conn, select_all=True, filters={"price_min": 10}
        )
        self.assertEqual(len(everything), 6)
        self.assertEqual(len(expensive), 3)
        self.assertTrue(set(expensive) < set(everything))

    def test_explicit_ids_are_verified_against_the_database(self):
        real = repo.matching_ids(self.conn, {})
        resolved = bulk.resolve_selection(self.conn, ids=real + [99999])
        self.assertNotIn(99999, resolved)

    def test_empty_selection_is_refused(self):
        with self.assertRaises(bulk.BulkError):
            bulk.resolve_selection(self.conn, ids=[])

    def test_preview_reports_the_real_count_and_a_sample(self):
        ids = repo.matching_ids(self.conn, {"price_min": 10})
        preview = bulk.preview(self.conn, ids)
        self.assertEqual(preview["count"], len(ids))
        self.assertTrue(preview["sample"])
        self.assertEqual(preview["sample"][0]["title"], "Mox Amber")

    def test_percentage_adjust_is_exact_integer_arithmetic(self):
        row = self.conn.execute(
            "SELECT id FROM holdings WHERE price_cents = 684"
        ).fetchone()
        with transaction(self.conn):
            bulk.apply_action(self.conn, "adjust_price", [row["id"]], "5")
        # 684 * 1.05 = 718.2 -> 718 half-up, with no float involved.
        self.assertEqual(
            self.conn.execute(
                "SELECT price_cents FROM holdings WHERE id = ?", (row["id"],)
            ).fetchone()["price_cents"],
            718,
        )

    def test_adjust_never_produces_a_negative_price(self):
        ids = repo.matching_ids(self.conn, {})
        with self.assertRaises(bulk.BulkError):
            with transaction(self.conn):
                bulk.apply_action(self.conn, "adjust_price", ids, "-200")

    def test_unknown_action_is_refused(self):
        with self.assertRaises(bulk.BulkError):
            with transaction(self.conn):
                bulk.apply_action(self.conn, "drop_table", [1])


class TestRepo(Base):
    def setUp(self):
        super().setUp()
        self.stage_and_commit(SAMPLE)

    def test_unknown_filter_raises_rather_than_matching_everything(self):
        with self.assertRaises(ValueError):
            repo.query_holdings(self.conn, {"prices_min": 10})

    def test_filter_fragments_are_table_qualified(self):
        """A join is in play, so an unqualified column would be ambiguous.

        Qualification has to hold wherever the column appears, not just at the
        start — `LOWER(h.title) LIKE ?` is correct and does not begin with `h.`.
        """
        import re as _re

        for name, (fragment, _) in repo.FILTERS.items():
            with self.subTest(filter=name):
                self.assertRegex(fragment, r"\b[hv]\.", fragment)
                # No bare column reference: every identifier before a comparison
                # or inside a function must carry its table alias.
                bare = _re.findall(r"(?<![.\w])([a-z_]+)\s*(?:=|>=|<=|IS\b|LIKE\b)",
                                   fragment)
                self.assertEqual(bare, [], f"{fragment} has unqualified {bare}")

    def test_totals_track_the_filter(self):
        everything = repo.totals(self.conn, {})
        filtered = repo.totals(self.conn, {"price_min": 10})
        self.assertLess(filtered["value_cents"], everything["value_cents"])
        self.assertEqual(everything["rows"], 6)

    def test_pagination(self):
        page = repo.query_holdings(self.conn, {}, per_page=2, page=1)
        self.assertEqual(len(page.rows), 2)
        self.assertEqual(page.pages, 3)
        self.assertTrue(page.has_next)
        self.assertFalse(page.has_prev)


if __name__ == "__main__":
    unittest.main()
