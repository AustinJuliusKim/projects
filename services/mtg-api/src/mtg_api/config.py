import os

# Scryfall requires a descriptive User-Agent on every request, including bulk
# file downloads: https://scryfall.com/docs/api
SCRYFALL_USER_AGENT = os.environ.get(
    "SCRYFALL_USER_AGENT", "mtg-api/0.1 (austinjuliuskim@gmail.com)"
)

SCRYFALL_BULK_INDEX_URL = "https://api.scryfall.com/bulk-data"


def database_url() -> str:
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError("DATABASE_URL is required")
    return url
