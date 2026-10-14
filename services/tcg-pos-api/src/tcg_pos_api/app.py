from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from tcg_pos_api.routes import (
    credit,
    health,
    imports,
    inventory,
    pricing,
    storefront,
    storefront_settings,
    web_orders,
)


class StripApiPrefix:
    """Serve /api/v1/... as /v1/...: the apps call same-origin `/api` (in
    prod CloudFront forwards /api/* and Mangum strips it). Their Vite dev
    servers already rewrite the prefix away when proxying to :8001; this
    makes a proxy that doesn't (or a direct call) work too."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        path = scope.get("path", "")
        if scope["type"] == "http" and (path == "/api" or path.startswith("/api/")):
            scope = {**scope, "path": path[4:] or "/"}
            if "raw_path" in scope and scope["raw_path"]:
                scope["raw_path"] = scope["raw_path"][4:] or b"/"
        await self.app(scope, receive, send)


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
    app.add_middleware(StripApiPrefix)
    app.include_router(inventory.router, prefix="/v1")
    app.include_router(imports.router, prefix="/v1")
    app.include_router(pricing.router, prefix="/v1")
    app.include_router(credit.router, prefix="/v1")
    app.include_router(storefront_settings.router, prefix="/v1")
    app.include_router(web_orders.router, prefix="/v1")
    app.include_router(storefront.router, prefix="/v1")
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
                "/v1/web-orders",
                "/v1/web-orders/{order_id}/picked-up",
                "/v1/web-orders/{order_id}/cancel",
                "/v1/storefront/{slug}",
                "/v1/storefront/{slug}/search",
                "/v1/storefront/{slug}/autocomplete",
                "/v1/storefront/{slug}/cards/{oracle_id}",
                "/v1/storefront/{slug}/offers",
                "/v1/storefront/{slug}/cart/quote",
                "/v1/storefront/{slug}/orders",
                "/v1/storefront/{slug}/orders/{order_id}",
                "/v1/health",
            ],
        }

    return app
