"""The JSON API.

Everything the front end can do goes through here. The domain modules —
`repo`, `bulk`, `importer`, `operations` — are unchanged; the Jinja templates
were only ever one presentation of them, and this is another.

Two rules carried over from the server-rendered version, because neither is a
view concern:

**Money crosses as integer cents.** JSON numbers are IEEE doubles. Cents are
exact integers far inside 2^53; dollars-as-float are not. Every row carries
`priceCents` plus a preformatted display string, so the client never does
money arithmetic.

**Bulk selection is resolved server-side.** The client sends explicit ids, or
`{"selectAll": true}` plus filters — never a materialized id list standing in
for "everything matching". A filter that changed since the page rendered
therefore cannot silently widen an edit.
"""

from __future__ import annotations

import os
import sqlite3
from decimal import Decimal
from typing import Any, Dict, Optional

from flask import Blueprint, Response, current_app, jsonify, request

from binders import sealed as sealed_lib

from . import bulk, exporter, importer
from . import operations as ops
from . import sales
from . import repo
from .db import format_cents, transaction

__all__ = ["api", "ApiError"]

api = Blueprint("api", __name__, url_prefix="/api")


class ApiError(Exception):
    """A failure with a status code and a message meant for a person."""

    def __init__(self, message: str, status: int = 400, code: str = "error"):
        super().__init__(message)
        self.message = message
        self.status = status
        self.code = code


@api.errorhandler(ApiError)
def _handle(exc: ApiError):
    return jsonify({"error": exc.message, "code": exc.code}), exc.status


def db() -> sqlite3.Connection:
    from .app import db as _db

    return _db()


def _payload() -> Dict[str, Any]:
    return request.get_json(silent=True) or {}


#: Query parameters that are not filters. Anything else must be a known filter.
NON_FILTER_PARAMS = frozenset({"sort", "dir", "page", "perPage"})


def _filters(source, *, strict: bool = True) -> Dict[str, Any]:
    """Pull filters out of a query string or a JSON body.

    Strict on purpose. Picking out only the *known* keys would silently drop a
    typo — `prices_min=10` would return the whole collection while looking
    filtered, which is exactly how a bulk edit hits rows nobody meant to touch.
    """
    if strict:
        unknown = [
            key
            for key in source.keys()
            if key not in repo.FILTERS and key not in NON_FILTER_PARAMS
        ]
        if unknown:
            known = ", ".join(sorted(repo.FILTERS))
            raise ApiError(
                f"Unknown filter(s): {', '.join(sorted(unknown))}. Available: {known}",
                400,
                "bad-filter",
            )

    out: Dict[str, Any] = {}
    for key in repo.FILTERS:
        value = source.get(key)
        if value not in (None, "", []):
            out[key] = value
    return out


# --- session -----------------------------------------------------------------


@api.get("/session")
def session_info():
    from .app import csrf_token

    undoable = ops.latest_undoable(db())
    return jsonify({
        "csrfToken": csrf_token(),
        "database": current_app.config["DATABASE"],
        "undoable": _operation(undoable) if undoable else None,
    })


# --- collection ---------------------------------------------------------------


def _holding(row) -> dict:
    price = row["price_cents"]
    total = price * row["quantity"] if price is not None else None
    return {
        "id": row["id"],
        "title": row["title"],
        "edition": row["edition"],
        "setName": row["set_name"],
        "collectorNumber": row["collector_number"],
        "rarity": row["rarity"],
        "foil": bool(row["foil"]),
        "quantity": row["quantity"],
        "priceCents": price,
        "totalCents": total,
        "price": format_cents(price),
        "total": format_cents(total),
        "condition": row["condition"],
        "language": row["language"],
        "verdict": row["verdict"],
    }


@api.get("/collection")
def collection():
    filters = _filters(request.args)
    try:
        page = repo.query_holdings(
            db(),
            filters,
            sort=request.args.get("sort", repo.DEFAULT_SORT),
            direction=request.args.get("dir", "desc"),
            page=int(request.args.get("page", 1) or 1),
            per_page=int(request.args.get("perPage", 50) or 50),
        )
    except ValueError as exc:
        raise ApiError(str(exc), 400, "bad-filter")

    scoped = repo.totals(db(), filters)
    grand = repo.totals(db(), {})

    return jsonify({
        "rows": [_holding(r) for r in page.rows],
        "page": page.page,
        "perPage": page.per_page,
        "pages": page.pages,
        "totalRows": page.total_rows,
        "sort": page.sort,
        "direction": page.direction,
        "totals": _totals(scoped),
        "grandTotals": _totals(grand),
        "facets": {
            "editions": repo.distinct_values(db(), "edition"),
            "rarities": repo.distinct_values(db(), "rarity"),
            "conditions": repo.distinct_values(db(), "condition"),
        },
    })


def _totals(t: dict) -> dict:
    return {
        "rows": t["rows"],
        "quantity": t["quantity"],
        "valueCents": t["value_cents"],
        "value": format_cents(t["value_cents"]),
        "unpriced": t["unpriced"],
    }


@api.get("/collection/insights")
def insights():
    """Chart data for the current slice.

    Same filters as `/collection`, so the charts always describe exactly what
    the table below them shows — a chart that silently ignored the filter would
    be worse than no chart.
    """
    filters = _filters(request.args)
    tiers = repo.tier_breakdown(db(), filters)

    return jsonify({
        "concentration": repo.concentration(db(), filters),
        "tiers": [
            {
                **t,
                "market": format_cents(t["marketCents"]),
                "cash": format_cents(t["cashCents"]),
                "credit": format_cents(t["creditCents"]),
            }
            for t in tiers
        ],
        "sets": [
            {**s, "value": format_cents(s["cents"])}
            for s in repo.top_sets(db(), filters)
        ],
        "rarity": [
            {**r, "value": format_cents(r["cents"])}
            for r in repo.rarity_split(db(), filters)
        ],
        "totals": _totals(repo.totals(db(), filters)),
    })


# --- sealed -------------------------------------------------------------------
#
# Sealed rows were importable but unreachable: they landed in the table and
# nothing could query, show or edit them again. The import screen even
# advertised that it accepted sealed lists. These give sealed the same surface
# singles have.


def _sealed_filters(source) -> Dict[str, Any]:
    unknown = [
        key
        for key in source.keys()
        if key not in repo.SEALED_FILTERS and key not in NON_FILTER_PARAMS
    ]
    if unknown:
        known = ", ".join(sorted(repo.SEALED_FILTERS))
        raise ApiError(
            f"Unknown filter(s): {', '.join(sorted(unknown))}. Available: {known}",
            400,
            "bad-filter",
        )
    return {
        key: source.get(key)
        for key in repo.SEALED_FILTERS
        if source.get(key) not in (None, "", [])
    }


def _sealed_row(row) -> dict:
    price = row["price_cents"]
    total = price * row["quantity"] if price is not None else None
    basis = row["cost_basis_cents"]
    cost = basis * row["quantity"] if basis is not None else None
    # Gain stays null without a basis — never zero. A fabricated basis lands
    # straight in a tax figure.
    gain = None if (cost is None or total is None) else total - cost
    return {
        "id": row["id"],
        "name": row["product_name"] or row["raw_name"],
        "rawName": row["raw_name"],
        "setCode": row["set_code"],
        "setName": row["set_name"],
        "year": row["release_year"],
        "quantity": row["quantity"],
        "priceCents": price,
        "totalCents": total,
        "price": format_cents(price),
        "total": format_cents(total),
        "costBasisCents": cost,
        "costBasis": format_cents(cost),
        "gainCents": gain,
        "gain": format_cents(gain),
        "priceDate": row["price_date"],
        "priceSource": row["price_source"],
        "condition": row["condition"],
        "resolved": bool(row["resolved"]),
        "purchaseUrl": row["purchase_url"],
        "notes": row["notes"],
        "verdict": row["verdict"],
    }


def _sealed_totals(t: dict) -> dict:
    return {
        "rows": t["rows"],
        "quantity": t["quantity"],
        "valueCents": t["value_cents"],
        "value": format_cents(t["value_cents"]),
        "unpriced": t["unpriced"],
        "unresolved": t["unresolved"],
        "costCents": t["cost_cents"],
        "cost": format_cents(t["cost_cents"]),
    }


@api.get("/sealed")
def sealed_collection():
    filters = _sealed_filters(request.args)
    try:
        page = repo.query_sealed(
            db(),
            filters,
            sort=request.args.get("sort", "total"),
            direction=request.args.get("dir", "desc"),
            page=int(request.args.get("page", 1) or 1),
            per_page=int(request.args.get("perPage", 50) or 50),
        )
    except ValueError as exc:
        raise ApiError(str(exc), 400, "bad-filter")

    return jsonify({
        "rows": [_sealed_row(r) for r in page.rows],
        "page": page.page,
        "perPage": page.per_page,
        "pages": page.pages,
        "totalRows": page.total_rows,
        "sort": page.sort,
        "direction": page.direction,
        "totals": _sealed_totals(repo.sealed_totals(db(), filters)),
        "grandTotals": _sealed_totals(repo.sealed_totals(db(), {})),
        "facets": {
            "sets": repo.sealed_distinct(db(), "set_code"),
            "years": repo.sealed_distinct(db(), "release_year"),
            "conditions": repo.sealed_distinct(db(), "condition"),
        },
    })


@api.get("/sealed/insights")
def sealed_insights():
    """Deliberately not the singles chart set.

    No Card Kingdom rate bands: those are CK *singles* buylist rates and sealed
    isn't going to CK, so applying them would print a figure matching no real
    offer. Price coverage takes their place, because with hand-entered prices a
    partial valuation is the normal state rather than an error.
    """
    filters = _sealed_filters(request.args)
    totals = repo.sealed_totals(db(), filters)
    years = repo.sealed_by_year(db(), filters)

    return jsonify({
        "byYear": [
            {
                "year": y["year"],
                "quantity": y["qty"],
                "cents": y["cents"],
                "value": format_cents(y["cents"]),
                "unpriced": y["unpriced"],
            }
            for y in years
        ],
        "coverage": {
            "priced": totals["quantity"] - totals["unpriced"],
            "unpriced": totals["unpriced"],
            "pricedCents": totals["value_cents"],
        },
        "totals": _sealed_totals(totals),
    })


# --- bulk ---------------------------------------------------------------------


@api.get("/bulk/actions")
def bulk_actions():
    kind = request.args.get("kind", "holding")
    if kind not in repo.SUBJECTS:
        raise ApiError(f"{kind!r} is not a bulk subject", 400, "bad-kind")
    return jsonify([
        {
            "key": key,
            "label": spec["label"],
            "needsValue": spec["needs_value"],
            "destructive": bool(spec.get("destructive")),
        }
        for key, spec in bulk.actions_for(kind).items()
    ])


@api.post("/bulk/preview")
def bulk_preview():
    """What the confirmation dialog shows: the real count and a real sample."""
    body = _payload()
    kind = body.get("kind", "holding")
    try:
        target = bulk.resolve_selection(
            db(),
            ids=body.get("ids"),
            filters=_selection_filters(kind, body.get("filters") or {}),
            select_all=bool(body.get("selectAll")),
            kind=kind,
        )
    except (bulk.BulkError, ValueError) as exc:
        raise ApiError(str(exc), 400, "bad-selection")

    preview = bulk.preview(db(), target, kind=kind)
    return jsonify({
        "count": preview["count"],
        "quantity": preview["quantity"],
        "valueCents": preview["value_cents"],
        "value": format_cents(preview["value_cents"]),
        "more": preview["more"],
        "sample": [
            {
                "title": r["title"],
                "edition": r["edition"],
                "quantity": r["quantity"],
                "price": format_cents(r["price_cents"]),
            }
            for r in preview["sample"]
        ],
    })


@api.post("/bulk")
def bulk_apply():
    body = _payload()
    kind = body.get("kind", "holding")
    try:
        # Resolved here, from ids or filters — never from a count the client
        # sent. This is the guarantee that a stale filter cannot widen an edit.
        target = bulk.resolve_selection(
            db(),
            ids=body.get("ids"),
            filters=_selection_filters(kind, body.get("filters") or {}),
            select_all=bool(body.get("selectAll")),
            kind=kind,
        )
        with transaction(db()):
            result = bulk.apply_action(
                db(), body.get("action", ""), target, body.get("value"), kind=kind
            )
    except (bulk.BulkError, ValueError) as exc:
        raise ApiError(str(exc), 400, "bulk-failed")

    return jsonify({"affected": result["affected"], "summary": result["summary"]})


# --- imports ------------------------------------------------------------------


def _import(row) -> dict:
    return {
        "id": row["id"],
        "filename": row["filename"],
        "kind": row["kind"],
        "dialect": row["dialect"],
        "rowCount": row["row_count"],
        "status": row["status"],
        "createdAt": row["created_at"],
        "committedAt": row["committed_at"],
    }


@api.get("/imports")
def imports_list():
    rows = db().execute("SELECT * FROM imports ORDER BY id DESC LIMIT 50").fetchall()
    return jsonify([_import(r) for r in rows])


@api.post("/imports")
def imports_upload():
    upload = request.files.get("file")
    if upload is None or not upload.filename:
        raise ApiError("Choose a CSV first.", 400, "no-file")

    data = upload.read()
    try:
        with transaction(db()):
            import_id, kind = importer.stage_import(
                db(), os.path.basename(upload.filename), data
            )
    except importer.DetectionError as exc:
        raise ApiError(str(exc), 400, "unrecognized")
    except FileExistsError as exc:
        raise ApiError(str(exc), 409, "duplicate")

    return jsonify({"importId": import_id, "kind": kind}), 201


@api.get("/imports/<int:import_id>")
def imports_detail(import_id: int):
    record = db().execute("SELECT * FROM imports WHERE id = ?", (import_id,)).fetchone()
    if record is None:
        raise ApiError(f"No import {import_id}.", 404, "not-found")

    grouped = importer.issues_for(db(), import_id)
    return jsonify({
        "record": _import(record),
        "blocking": importer.blocking_count(db(), import_id),
        "blockingCodes": sorted(importer.BLOCKING),
        "issues": [
            {
                "code": code,
                "blocking": code in importer.BLOCKING,
                "rows": [
                    {
                        "id": item["id"],
                        "lineNo": item["line_no"],
                        "name": item["parsed"].get("title")
                        or item["parsed"].get("raw_name")
                        or "",
                        "candidates": item["parsed"].get("candidates") or [],
                        "state": item["state"],
                    }
                    for item in items
                ],
            }
            for code, items in grouped.items()
        ],
    })


@api.post("/imports/<int:import_id>/rows/<int:row_id>")
def imports_resolve_row(import_id: int, row_id: int):
    import json as _json

    body = _payload()
    row = db().execute(
        "SELECT * FROM staged_rows WHERE id = ? AND import_id = ?", (row_id, import_id)
    ).fetchone()
    if row is None:
        raise ApiError("No such staged row.", 404, "not-found")

    with transaction(db()):
        if body.get("skip"):
            db().execute(
                "UPDATE staged_rows SET state = 'skipped' WHERE id = ?", (row_id,)
            )
        else:
            resolution = _json.loads(row["resolution"] or "{}")
            for key in ("set_code", "identity", "mtgjson_uuid", "product_name"):
                if body.get(key):
                    resolution[key] = body[key]
            db().execute(
                "UPDATE staged_rows SET resolution = ?, state = 'resolved' WHERE id = ?",
                (_json.dumps(resolution), row_id),
            )

    return jsonify({"blocking": importer.blocking_count(db(), import_id)})


@api.post("/imports/<int:import_id>/commit")
def imports_commit(import_id: int):
    try:
        with transaction(db()):
            result = importer.commit_import(db(), import_id)
    except LookupError as exc:
        raise ApiError(str(exc), 404, "not-found")
    except ValueError as exc:
        raise ApiError(str(exc), 409, "blocked")
    return jsonify(result)


@api.post("/imports/<int:import_id>/discard")
def imports_discard(import_id: int):
    with transaction(db()):
        importer.discard_import(db(), import_id)
    return jsonify({"discarded": import_id})


# --- history ------------------------------------------------------------------


def _operation(op) -> dict:
    return {
        "id": op.id,
        "kind": op.kind,
        "summary": op.summary,
        "affected": op.affected,
        "createdAt": op.created_at,
        "revertedAt": op.reverted_at,
        "reverted": op.reverted,
    }


@api.get("/history")
def history():
    return jsonify([_operation(o) for o in ops.recent(db(), 50)])


@api.post("/undo")
def undo():
    try:
        with transaction(db()):
            operation = ops.undo(db())
    except LookupError as exc:
        raise ApiError(str(exc), 409, "nothing-to-undo")
    return jsonify(_operation(operation))


# --- sales --------------------------------------------------------------------


@api.get("/sales/queue")
def sales_queue():
    """Everything marked sell. Driven by verdicts, so triage feeds this."""
    return jsonify(sales.list_for_sale(db()))


@api.get("/sales")
def sales_list():
    status = request.args.get("status")
    try:
        return jsonify(sales.sale_rows(db(), status))
    except sales.SaleError as exc:
        raise ApiError(str(exc), 400, "bad-status")


@api.get("/sales/summary")
def sales_summary():
    body = sales.summary(db())
    return jsonify({
        **body,
        "gross": format_cents(body["grossCents"]),
        "costs": format_cents(body["costsCents"]),
        "net": format_cents(body["netCents"]),
        "realizedGain": format_cents(body["realizedGainCents"]),
        "listed": format_cents(body["listedCents"]),
    })


@api.post("/sales/list")
def sales_list_item():
    body = _payload()
    try:
        with transaction(db()):
            sale_id = sales.record_listing(
                db(),
                body.get("kind", ""),
                int(body.get("id", 0)),
                channel=body.get("channel", ""),
                listed_cents=_cents_or_none(body.get("listed")),
                quantity=body.get("quantity"),
                notes=body.get("notes", ""),
            )
    except sales.SaleError as exc:
        raise ApiError(str(exc), 400, "bad-listing")
    return jsonify({"saleId": sale_id}), 201


@api.post("/sales/<int:sale_id>/sold")
def sales_record(sale_id: int):
    body = _payload()
    sold = _cents_or_none(body.get("sold"))
    if sold is None:
        raise ApiError("Enter what it sold for.", 400, "no-price")
    try:
        with transaction(db()):
            result = sales.record_sale(
                db(),
                sale_id,
                sold_cents=sold,
                fees_cents=_cents_or_none(body.get("fees")) or 0,
                shipping_cents=_cents_or_none(body.get("shipping")) or 0,
                sold_at=body.get("soldAt"),
                notes=body.get("notes"),
            )
    except sales.SaleError as exc:
        raise ApiError(str(exc), 400, "bad-sale")
    return jsonify({
        **result,
        "net": format_cents(result["netCents"]),
        "realizedGain": format_cents(result["realizedGainCents"]),
    })


@api.post("/sales/<int:sale_id>/cancel")
def sales_cancel(sale_id: int):
    try:
        with transaction(db()):
            sales.cancel(db(), sale_id)
    except sales.SaleError as exc:
        raise ApiError(str(exc), 400, "bad-cancel")
    return jsonify({"cancelled": sale_id})


def _selection_filters(kind: str, source) -> Dict[str, Any]:
    """Filters for whichever subject the selection is over."""
    if kind == "sealed":
        return _sealed_filters(source)
    return _filters(source)


def _cents_or_none(value):
    """Dollars in, integer cents out. Rejects nonsense rather than coercing."""
    if value in (None, ""):
        return None
    try:
        from .db import to_cents

        return to_cents(str(value))
    except Exception:
        raise ApiError(f"{value!r} is not an amount.", 400, "bad-amount")


# --- export -------------------------------------------------------------------
#
# The database is the system of record now, which created a lock-in the CSV
# workflow never had. Getting everything back out is a feature, not a nicety.


@api.get("/export/manifest")
def export_manifest():
    import json as _json

    return jsonify({
        "tables": exporter.table_names(db()),
        **_json.loads(exporter.manifest(db())),
    })


@api.get("/export/table/<name>")
def export_table(name: str):
    try:
        body = exporter.table_csv(db(), name)
    except ValueError as exc:
        raise ApiError(str(exc), 404, "not-exportable")
    return Response(
        body,
        mimetype="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{name}.csv"'},
    )


@api.get("/export/ledger")
def export_ledger():
    return Response(
        exporter.ledger_csv(db()),
        mimetype="text/csv",
        headers={
            "Content-Disposition": 'attachment; filename="mtg_collection_tracker.csv"'
        },
    )


@api.get("/sealed/template")
def sealed_template():
    """A starter `sealed.csv`.

    The same bytes `binders sealed template` writes — one function, imported —
    because a starter file that disagreed with the parser would send people
    straight into the import error it exists to avoid.
    """
    return Response(
        sealed_lib.template_csv(),
        mimetype="text/csv",
        headers={"Content-Disposition": 'attachment; filename="sealed.csv"'},
    )


def _min_price_cents() -> int:
    """`?min_price=` in dollars, defaulting to the CLI's $1 floor."""
    raw = request.args.get("min_price")
    if raw in (None, ""):
        return 100
    try:
        value = Decimal(str(raw))
    except (ArithmeticError, ValueError):
        raise ApiError(f"{raw!r} isn't a price.", 400, "bad-min-price")
    if value < 0:
        raise ApiError("A minimum price can't be negative.", 400, "bad-min-price")
    return int(value * 100)


@api.get("/export/buylist/summary")
def export_buylist_summary():
    """What the buylist would contain, so the UI can say so before downloading."""
    return jsonify(exporter.buylist_summary(db(), min_price_cents=_min_price_cents()))


@api.get("/export/buylist")
def export_buylist():
    """The detailed CSV — every column, for destinations other than CK."""
    return Response(
        exporter.buylist_csv(db(), min_price_cents=_min_price_cents()),
        mimetype="text/csv",
        headers={"Content-Disposition": 'attachment; filename="buylist.csv"'},
    )


@api.get("/export/buylist/ck")
def export_buylist_ck():
    """The same rows in Card Kingdom's four-column import shape."""
    return Response(
        exporter.ck_submission_csv(db(), min_price_cents=_min_price_cents()),
        mimetype="text/csv",
        headers={
            "Content-Disposition": 'attachment; filename="card_kingdom_submission.csv"'
        },
    )


@api.get("/export/bundle")
def export_bundle():
    """Every table, the ledger, a manifest and the database itself."""
    path = current_app.config["DATABASE"]
    filename, blob = exporter.bundle(db(), None if path.startswith("file:") else path)
    return Response(
        blob,
        mimetype="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
