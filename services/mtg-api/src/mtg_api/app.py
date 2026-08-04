from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from mtg_api.routes import cards, health, sets

ATTRIBUTION = (
    "Card data © Wizards of the Coast, provided by Scryfall. Unofficial Fan "
    "Content permitted under the Wizards of the Coast Fan Content Policy; not "
    "endorsed by Scryfall or Wizards of the Coast."
)


def create_app() -> FastAPI:
    app = FastAPI(
        title="mtg-api",
        version="0.1.0",
        description=(
            "Read-only MTG card database: search, card lookup, printings, "
            f"rulings, and sets. {ATTRIBUTION}"
        ),
    )
    # Public, read-only, cookie-less API — nothing to protect from cross-origin
    # reads.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["GET", "OPTIONS"],
        allow_headers=["*"],
    )
    app.include_router(cards.router, prefix="/v1")
    app.include_router(sets.router, prefix="/v1")
    app.include_router(health.router, prefix="/v1")

    @app.get("/", include_in_schema=False)
    def root() -> dict:
        return {
            "name": "mtg-api",
            "docs": "/docs",
            "openapi": "/openapi.json",
            "endpoints": [
                "/v1/cards/search",
                "/v1/cards/named",
                "/v1/cards/autocomplete",
                "/v1/cards/random",
                "/v1/cards/{oracle_id}",
                "/v1/cards/{oracle_id}/rulings",
                "/v1/cards/{oracle_id}/printings",
                "/v1/sets",
                "/v1/sets/{code}",
                "/v1/healthz",
            ],
            "attribution": ATTRIBUTION,
        }

    return app
