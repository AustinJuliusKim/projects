import uuid
from typing import Annotated

import psycopg
from fastapi import APIRouter, Depends

from tcg_pos_api import pricing, queries
from tcg_pos_api.catalog import Catalog, get_catalog
from tcg_pos_api.deps import Perm, TenantSession, require
from tcg_pos_api.routes.models import (
    Condition,
    Finish,
    Lang,
    PriceRule,
    PriceRuleOut,
    PriceSuggestion,
)

router = APIRouter(prefix="/pricing", tags=["pricing"])

CatalogDep = Annotated[Catalog, Depends(get_catalog)]


def _rule_values(row: dict | None) -> dict[str, int]:
    if row is None:
        return dict(pricing.DEFAULT_RULE)
    return {k: row[k] for k in pricing.RULE_FIELDS}


def current_rule(conn: psycopg.Connection) -> dict[str, int]:
    return _rule_values(queries.get_price_rule(conn))


@router.get("/rule", response_model=PriceRuleOut)
def get_rule(
    session: Annotated[TenantSession, require(Perm.INVENTORY_READ)],
) -> PriceRuleOut:
    row = queries.get_price_rule(session.conn)
    return PriceRuleOut(
        **_rule_values(row),
        is_default=row is None,
        updated_at=row["updated_at"] if row else None,
    )


@router.put("/rule", response_model=PriceRuleOut)
def put_rule(
    session: Annotated[TenantSession, require(Perm.PRICING_RULES_MANAGE)],
    body: PriceRule,
) -> PriceRuleOut:
    """Replace the tenant's price rule. Audit-logged with before (null while
    the defaults were in use) and after."""
    conn = session.conn
    before = queries.get_price_rule(conn, lock=True)
    after = queries.upsert_price_rule(conn, body.model_dump())
    queries.write_audit(
        conn,
        action="price_rule.update",
        entity="price_rule",
        entity_id=session.principal.tenant_id,
        before=_rule_values(before) if before else None,
        after=_rule_values(after),
    )
    return PriceRuleOut(**_rule_values(after), is_default=False, updated_at=after["updated_at"])


@router.get("/suggest", response_model=PriceSuggestion)
def suggest(
    session: Annotated[TenantSession, require(Perm.INVENTORY_READ)],
    catalog: CatalogDep,
    printing_id: uuid.UUID,
    finish: Finish,
    condition: Condition,
    lang: Lang = "en",
) -> PriceSuggestion:
    """Suggested shelf price for a printing/finish/condition: mtg-api's
    open-lane USD reference (TCGplayer retail via MTGJSON, else Scryfall's
    USD trend) through the tenant's price rule. suggested_cents is null —
    never 0 — when there is no USD reference."""
    rule = current_rule(session.conn)
    snapshot_id, results = catalog.price_batch(
        [{"scryfall_id": str(printing_id), "finish": finish}]
    )
    prices = results[0].get("prices") or []
    chosen = pricing.pick_price(prices, lang)
    base = {
        "printing_id": printing_id,
        "finish": finish,
        "condition": condition,
        "multiplier_bp": pricing.condition_bp(rule, condition),
        "rule": rule,
        "snapshot_id": snapshot_id,
    }
    if chosen is None:
        note = "no USD price for this printing/finish" if prices else "printing/finish not found"
        return PriceSuggestion(
            **base, suggested_cents=None, reference_cents=None, reference_source=None, note=note
        )
    source, reference = pricing.usd_reference(chosen)
    base["snapshot_id"] = chosen.get("snapshot_id") or snapshot_id
    return PriceSuggestion(
        **base,
        suggested_cents=pricing.apply_rule(reference, condition, rule),
        reference_cents=reference,
        reference_source=source,
        sku_id=chosen.get("sku_id"),
        sku_condition=chosen.get("condition"),
        sku_lang=chosen.get("lang"),
        stale=chosen.get("stale"),
        attribution=chosen.get("attribution") or [],
    )
