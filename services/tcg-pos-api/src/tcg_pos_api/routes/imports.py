"""POST /v1/inventory/import/tcgplayer — load a TCGplayer seller inventory
export into one location. Parsing and the column mapping live in
tcg_pos_api/tcgplayer.py.

Semantics: the CSV is the source of truth for the grains it lists. Applying
*sets* each grain's quantity to the CSV's Total Quantity (the ledger records
the difference as one `tcgplayer` / "tcgplayer import" row) and, when TCG
Marketplace Price is present, sets the shelf price (audit only). So
re-applying the same file is a no-op, never a doubling. Grains not in the
file are left alone. Rows at the same grain (e.g. two TCGplayer SKUs that
map to one printing) are summed.

dry_run=true (the default) resolves everything and reports what would
change without writing; dry_run=false applies it all in one transaction —
every change lands, or none does."""

import uuid
from collections import defaultdict
from typing import Annotated, Any

from fastapi import APIRouter, Body, Depends, HTTPException

from tcg_pos_api import queries, tcgplayer
from tcg_pos_api.catalog import Catalog, get_catalog
from tcg_pos_api.deps import Perm, TenantConn, require
from tcg_pos_api.routes.models import INT32_MAX, ImportChange, ImportResult, ImportRow, ImportTotals

router = APIRouter(prefix="/inventory/import", tags=["inventory"])

CHANNEL = "tcgplayer"
REASON = "tcgplayer import"


def _resolve(rows: list[dict[str, Any]], catalog: Catalog) -> str | None:
    """Fill set_code / printing_id on parsed rows (status -> matched or
    unmatched) via mtg-api. Returns the price snapshot id used."""
    candidates = [r for r in rows if r["status"] == "parsed"]
    if not candidates:
        return None

    codes_by_name: dict[str, set[str]] = defaultdict(set)
    for s in catalog.sets():
        if s.get("name") and s.get("code"):
            codes_by_name[s["name"].strip().lower()].add(s["code"].lower())
    lookups: dict[tuple[str, str, str], None] = {}
    for r in candidates:
        codes = codes_by_name.get(r["set_name"].lower(), set())
        if len(codes) != 1:
            why = "no set named" if not codes else "more than one set named"
            r.update(status="unmatched", reason=f"{why} {r['set_name']!r} in mtg-api")
            continue
        r["set_code"] = next(iter(codes))
        lookups[(r["set_code"], r["number"], r["finish"])] = None

    keys = list(lookups)
    snapshot_id, results = catalog.price_batch(
        [{"set": s, "number": n, "finish": f} for s, n, f in keys]
    )
    printing_by_key = {}
    for key, result in zip(keys, results, strict=True):
        ids = {p.get("printing_id") for p in result.get("prices") or [] if p.get("printing_id")}
        printing_by_key[key] = ids

    for r in candidates:
        if r["status"] != "parsed":
            continue
        ids = printing_by_key[(r["set_code"], r["number"], r["finish"])]
        if len(ids) != 1:
            why = "no" if not ids else "more than one"
            r.update(
                status="unmatched",
                reason=f"{why} {r['finish']} printing for {r['set_code']} #{r['number']} "
                "in mtg-api",
            )
            continue
        r.update(status="matched", printing_id=uuid.UUID(next(iter(ids))))
    return snapshot_id


@router.post("/tcgplayer", response_model=ImportResult, dependencies=[require(Perm.IMPORTS_RUN)])
def import_tcgplayer(
    conn: TenantConn,
    catalog: Annotated[Catalog, Depends(get_catalog)],
    location_id: uuid.UUID,
    body: Annotated[bytes, Body(media_type="text/csv")],
    dry_run: bool = True,
) -> ImportResult:
    try:
        rows = tcgplayer.parse_csv(body)
    except tcgplayer.CsvError as err:
        status = 413 if "larger than" in str(err) or "more than" in str(err) else 422
        raise HTTPException(status, str(err)) from None
    if not queries.location_exists(conn, location_id):
        raise HTTPException(404, "no location with that id")
    snapshot_id = _resolve(rows, catalog)

    grains: dict[tuple, dict[str, Any]] = {}
    for r in rows:
        if r["status"] != "matched":
            continue
        key = (r["printing_id"], r["condition"], r["finish"], r["lang"])
        g = grains.setdefault(key, {"rows": [], "target_qty": 0, "price_cents": None})
        g["rows"].append(r["row"])
        g["target_qty"] += r["qty"]
        if g["price_cents"] is None:
            g["price_cents"] = r["price_cents"]

    changes = []
    for (printing_id, condition, finish, lang), g in grains.items():
        if g["target_qty"] > INT32_MAX:
            raise HTTPException(422, f"rows {g['rows']}: total quantity overflows")
        grain = {
            "location_id": location_id,
            "printing_id": printing_id,
            "game": "mtg",
            "condition": condition,
            "finish": finish,
            "lang": lang,
        }
        current = queries.find_item(conn, grain)
        change = {
            "printing_id": printing_id,
            "condition": condition,
            "finish": finish,
            "lang": lang,
            "rows": g["rows"],
            "current_qty": current["qty"] if current else 0,
            "target_qty": g["target_qty"],
            "current_price_cents": current["price_cents"] if current else None,
            "price_cents": g["price_cents"],
            "item_id": current["id"] if current else None,
        }
        change["delta"] = change["target_qty"] - change["current_qty"]
        if not dry_run:
            change.update(_apply(conn, grain, current, g))
        changes.append(change)

    def changed(c: dict) -> bool:
        price_change = c["price_cents"] is not None and c["price_cents"] != c["current_price_cents"]
        return c["delta"] != 0 or price_change

    statuses = [r["status"] for r in rows]
    return ImportResult(
        dry_run=dry_run,
        location_id=location_id,
        snapshot_id=snapshot_id,
        totals=ImportTotals(
            rows=len(rows),
            matched=statuses.count("matched"),
            unmatched=statuses.count("unmatched"),
            skipped=statuses.count("skipped"),
            grains=len(changes),
            changed=sum(1 for c in changes if changed(c)),
            qty_delta=sum(c["delta"] for c in changes),
        ),
        changes=[ImportChange(**c) for c in changes],
        rows=[ImportRow(**r) for r in rows],
    )


def _apply(conn, grain: dict, current: dict | None, g: dict) -> dict:
    """Set one grain to the CSV's qty/price under a row lock. Returns the
    fields of the change that the locked re-read may have updated."""
    if current is None and g["target_qty"] == 0:
        return {}  # nothing on hand and nothing to add: don't create an empty row
    before, created = queries.lock_or_create_item(conn, grain)
    after = before
    delta = g["target_qty"] - before["qty"]
    if delta != 0:
        after = queries.set_item_qty(conn, before["id"], g["target_qty"])
        queries.insert_inventory_ledger(
            conn, item_id=after["id"], delta=delta, reason=REASON, channel=CHANNEL
        )
    if g["price_cents"] is not None and g["price_cents"] != after["price_cents"]:
        after = queries.set_item_price(conn, after["id"], g["price_cents"])
    if after is not before:
        queries.write_audit(
            conn,
            action="inventory.import",
            entity="inventory_item",
            entity_id=after["id"],
            before=None if created else before,
            after=after,
        )
    return {
        "item_id": after["id"],
        "current_qty": before["qty"],
        "current_price_cents": before["price_cents"],
        "delta": delta,
    }
