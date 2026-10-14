"""Per-IP fixed-window rate limits for the public storefront's writes
(POST /cart/quote, POST /orders). A trimmed-down version of
services/mtg-api's ratelimit.py: no API keys or tiers, and a route
dependency instead of middleware because only two routes are metered.

Counts live in Postgres (storefront_rate_counter, migrations/0009) rather
than process memory: on Lambda every concurrent instance would otherwise
keep its own counts and a cold start would reset them. One
storefront_rate_hit() call per request, on its own short autocommit
connection so the hit counts even when the request's own transaction rolls
back (a 409 order attempt is still an attempt).

Buckets are `<kind>:ip:<address>`, across all stores. Not fail-open (unlike
mtg-api): these routes need the database anyway, so a counter failure is
the same 500 the route would have returned.

Limits (requests per minute per IP), read from the environment on every
request: STOREFRONT_QUOTE_LIMIT (default 60),
STOREFRONT_ORDER_LIMIT (default 10). STOREFRONT_RATELIMIT_ENABLED=0 turns
the check off (local dev only)."""

import ipaddress
import os
import time

import psycopg
from fastapi import HTTPException, Request

from tcg_pos_api.config import connect_kwargs, database_url

WINDOW_SECONDS = 60
LIMITS = {
    "quote": ("STOREFRONT_QUOTE_LIMIT", 60),
    "order": ("STOREFRONT_ORDER_LIMIT", 10),
}


def _enabled() -> bool:
    return os.environ.get("STOREFRONT_RATELIMIT_ENABLED", "1").strip().lower() not in ("0", "false")


def limit_for(kind: str) -> int:
    env, default = LIMITS[kind]
    return int(os.environ.get(env, default))


def _validated_ip(value: str) -> str | None:
    """`value` as a bare IP address (port and IPv6 zone stripped), or None.
    Unvalidated header text never becomes a bucket name."""
    host = value.strip()
    if host.startswith("["):
        host = host.split("]")[0].lstrip("[")
    elif host.count(":") == 1:
        host = host.rsplit(":", 1)[0]
    host = host.split("%")[0]
    try:
        return str(ipaddress.ip_address(host))
    except ValueError:
        return None


def client_ip(request: Request) -> str:
    """The LAST X-Forwarded-For hop (API Gateway appends the real client IP
    there; earlier entries are client-controlled), else the socket peer,
    else "unknown". Behind CloudFront this is the edge IP — a coarse shared
    bucket; see mtg-api's ratelimit.client_ip for the trade-off."""
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        ip = _validated_ip(forwarded.split(",")[-1])
        if ip:
            return ip
    if request.client:
        ip = _validated_ip(request.client.host)
        if ip:
            return ip
    return "unknown"


def check(request: Request, kind: str) -> None:
    if not _enabled():
        return
    bucket = f"{kind}:ip:{client_ip(request)}"
    with psycopg.connect(database_url(), autocommit=True, **connect_kwargs()) as conn:
        with conn.transaction():
            conn.execute("SET LOCAL ROLE tcg_pos_app")
            hits = conn.execute(
                "SELECT storefront_rate_hit(%s, %s)", (bucket, WINDOW_SECONDS)
            ).fetchone()[0]
    if hits > limit_for(kind):
        retry = WINDOW_SECONDS - int(time.time()) % WINDOW_SECONDS
        raise HTTPException(
            429, "too many requests; try again shortly", headers={"Retry-After": str(retry)}
        )


def quote_limit(request: Request) -> None:
    check(request, "quote")


def order_limit(request: Request) -> None:
    check(request, "order")
