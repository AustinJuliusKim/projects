from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.routing import iter_route_contexts

from tcg_pos_api.auth import dev as dev_auth
from tcg_pos_api.auth import tokens
from tcg_pos_api.config import env_name
from tcg_pos_api.routes import (
    account,
    api_keys,
    credit,
    dev,
    health,
    imports,
    inventory,
    pricing,
    registers,
    staff,
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


def check_auth_config() -> tokens.AuthSettings:
    """Refuse to start without an issuer, or with the dev issuer anywhere
    but ENV=local/test (its private key sits on disk and /v1/dev/login mints
    tokens for any email)."""
    auth = tokens.settings()
    if auth.is_dev and env_name() not in dev_auth.DEV_ENVS:
        raise RuntimeError(
            f"AUTH_ISSUER is the dev issuer but ENV={env_name()!r}; "
            "the dev issuer is only allowed with ENV=local or ENV=test"
        )
    return auth


def create_app() -> FastAPI:
    auth = check_auth_config()
    app = FastAPI(
        title="tcg-pos-api",
        version="0.1.0",
        description=(
            "Card-shop POS: multi-tenant inventory with an append-only ledger, "
            "store credit, and an audit log. Money is integer cents. Staff "
            "routes take `Authorization: Bearer <access token>` plus "
            "`X-Tenant-Id` to pick one of the caller's stores, or a register's "
            "`Authorization: Device <secret>` + `X-Register-Session`, or "
            "`Authorization: ApiKey <key>`."
        ),
    )
    # TODO(auth): origins open while there is no deployed app; pin to the POS
    # app's origin once it has one (see Ops tasks). Credentials are bearer
    # tokens, never cookies, so an open origin can't ride a session.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["*"],
    )
    app.add_middleware(StripApiPrefix)
    app.include_router(account.router, prefix="/v1")
    app.include_router(staff.router, prefix="/v1")
    app.include_router(registers.router, prefix="/v1")
    app.include_router(api_keys.router, prefix="/v1")
    app.include_router(inventory.router, prefix="/v1")
    app.include_router(imports.router, prefix="/v1")
    app.include_router(pricing.router, prefix="/v1")
    app.include_router(credit.router, prefix="/v1")
    app.include_router(storefront_settings.router, prefix="/v1")
    app.include_router(web_orders.router, prefix="/v1")
    app.include_router(storefront.router, prefix="/v1")
    app.include_router(health.router, prefix="/v1")
    if auth.is_dev:
        app.include_router(dev.router, prefix="/v1")

    @app.get("/", include_in_schema=False)
    def root() -> dict:
        return {
            "name": "tcg-pos-api",
            "docs": "/docs",
            "openapi": "/openapi.json",
            "endpoints": sorted(
                {
                    r.path
                    for r in iter_route_contexts(app.routes)
                    if r.path and r.path.startswith("/v1/")
                }
            ),
        }

    return app
