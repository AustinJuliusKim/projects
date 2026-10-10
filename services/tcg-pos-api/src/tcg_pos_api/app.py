from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from tcg_pos_api.routes import (
    credit,
    health,
    imports,
    inventory,
    pricing,
    storefront_settings,
)


def create_app() -> FastAPI:
    app = FastAPI(
        title="tcg-pos-api",
        version="0.1.0",
        description=(
            "Card-shop POS: multi-tenant inventory with an append-only ledger, "
            "store credit, and an audit log. Money is integer cents."
        ),
    )
    # TODO(auth): origins open while there is no auth and no deployed app;
    # pin to the POS app's origin once it has one (see Ops tasks).
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["GET", "POST", "PUT", "PATCH", "OPTIONS"],
        allow_headers=["*"],
    )
    app.include_router(inventory.router, prefix="/v1")
    app.include_router(imports.router, prefix="/v1")
    app.include_router(pricing.router, prefix="/v1")
    app.include_router(credit.router, prefix="/v1")
    app.include_router(storefront_settings.router, prefix="/v1")
    app.include_router(health.router, prefix="/v1")

    @app.get("/", include_in_schema=False)
    def root() -> dict:
        return {
            "name": "tcg-pos-api",
            "docs": "/docs",
            "openapi": "/openapi.json",
            "endpoints": [
                "/v1/inventory",
                "/v1/inventory/adjust",
                "/v1/inventory/{item_id}",
                "/v1/inventory/import/tcgplayer",
                "/v1/pricing/rule",
                "/v1/pricing/suggest",
                "/v1/customers/{customer_id}/credit",
                "/v1/customers/{customer_id}/credit/issue",
                "/v1/customers/{customer_id}/credit/redeem",
                "/v1/storefront-settings",
                "/v1/health",
            ],
        }

    return app
