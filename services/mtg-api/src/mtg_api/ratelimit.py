"""Fixed-window per-caller rate limiting (docs/PLAN.md Phase 5). Counts live
in Postgres (`rate_counters`), one row per (identifier, minute) bumped by a
single INSERT ... ON CONFLICT DO UPDATE.

Identifiers are namespaced so keyed and anonymous traffic can never collide:
`key:<sha256>` for a valid, non-revoked API key; `ip:<address>` otherwise
(no/invalid/revoked key all fall back to the IP bucket).

Fails open: any exception while checking the counter (DB down, table
missing, pool exhausted) lets the request through untouched — availability
over strict enforcement at this traffic level. Set RATELIMIT_ENABLED=0 to
skip the check entirely (local dev / DB-less tests).

This middleware opens its own short-lived connection, separate from the
request's own mtg_api.deps.get_conn connection — accepted for now (two
connections per request instead of one); revisit if p50 latency or pooler
connection pressure shows up once there's real traffic to measure.
"""

import ipaddress
import logging
import math
import os
from datetime import UTC, datetime, timedelta

import psycopg
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from mtg_api.apikeys import hash_key
from mtg_api.config import database_url

logger = logging.getLogger(__name__)

# Requests/minute per tier — placeholders pending the Phase-5 usage research
# doc mentioned in docs/PLAN.md; revisit these once real numbers exist.
ANONYMOUS_LIMIT = 60
FREE_LIMIT = 300
SUPPORTER_LIMIT = 1200

WINDOW_SECONDS = 60

# No rate check (and no DB touch) on these — public, static, no DB. Deliberately
# NOT including /v1/healthz: it already opens a DB connection per call, and
# metering it keeps that path's traffic bounded too (uptime monitors polling
# at ~1/min cost 1/60th of the anonymous budget, which is fine).
EXEMPT_PATHS = frozenset({"/", "/docs", "/openapi.json"})


def _enabled() -> bool:
    return os.environ.get("RATELIMIT_ENABLED", "1").strip().lower() not in ("0", "false")


def _validated_ip(value: str) -> str | None:
    """Strip an optional :port and confirm `value` parses as an IP address.
    Returns None for anything else — unvalidated header input must never
    reach rate_counters (arbitrary length/content, injection, cache-busting
    via unbounded cardinality)."""
    host = value.strip()
    if host.startswith("["):  # bracketed IPv6, optionally with a port: [::1]:8000
        host = host.split("]")[0].lstrip("[")
    elif host.count(":") == 1:  # IPv4:port — bare IPv6 has more than one colon
        host = host.rsplit(":", 1)[0]
    # ipaddress accepts an arbitrary-length IPv6 zone id (fe80::1%<anything>),
    # which would smuggle unbounded input past the parse; a scope id is
    # meaningless for a public client IP, so drop it before validating.
    host = host.split("%")[0]
    try:
        ipaddress.ip_address(host)
    except ValueError:
        return None
    return host


def client_ip(request: Request) -> str:
    """The rate-limit identifier's IP component.

    Behind API Gateway, AWS itself appends the real client IP as the LAST
    entry of X-Forwarded-For — that hop is unspoofable, unlike any earlier
    entries a client can freely set. Direct execute-api callers are
    therefore limited on their real IP.

    Traffic proxied through CloudFront (the webapp's /api/* behavior) is
    limited per CloudFront edge IP instead, since that's the hop API
    Gateway actually sees — a coarser bucket shared by everyone hitting
    that edge location. Accepted at current scale: keyed tiers are the
    enforced lane, and anonymous webapp traffic riding CloudFront's IP
    together is a soft ceiling, not a security boundary. Revisit with a
    CloudFront-origin-verify header (shared secret from CloudFront to the
    origin) if webapp-driven anonymous 429s ever show up in logs.

    Falls back to request.client.host, then "unknown" if neither hop
    parses as a real IP address.
    """
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        last_hop = forwarded.split(",")[-1]
        candidate = _validated_ip(last_hop)
        if candidate:
            return candidate
    if request.client:
        candidate = _validated_ip(request.client.host)
        if candidate:
            return candidate
    return "unknown"


def _extract_key(request: Request) -> str | None:
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[len("bearer ") :].strip() or None
    return request.headers.get("x-api-key") or None


def identify(conn: psycopg.Connection, request: Request) -> tuple[str, int]:
    """(identifier, requests/min limit) for this request."""
    key = _extract_key(request)
    if key:
        key_sha256 = hash_key(key)
        row = conn.execute(
            "SELECT tier FROM api_keys WHERE key_sha256 = %s AND revoked_at IS NULL",
            (key_sha256,),
        ).fetchone()
        if row is not None:
            tier = row[0]
            limit = SUPPORTER_LIMIT if tier == "supporter" else FREE_LIMIT
            return f"key:{key_sha256}", limit
    return f"ip:{client_ip(request)}", ANONYMOUS_LIMIT


def _window_start(now: datetime) -> datetime:
    return now.replace(second=0, microsecond=0)


def increment(conn: psycopg.Connection, identifier: str, window_start: datetime) -> int:
    row = conn.execute(
        "INSERT INTO rate_counters (identifier, window_start, count) VALUES (%s, %s, 1) "
        "ON CONFLICT (identifier, window_start) "
        "DO UPDATE SET count = rate_counters.count + 1 "
        "RETURNING count",
        (identifier, window_start),
    ).fetchone()
    count = row[0]
    if count == 1:
        # Opportunistic pruning, piggybacked on the (rare — once per
        # identifier per window) first hit of a brand-new window row,
        # rather than a separate cron/scheduled job. See
        # migrations/0006_api_keys.sql.
        conn.execute("DELETE FROM rate_counters WHERE window_start < now() - interval '1 hour'")
    return count


class RateLimitMiddleware(BaseHTTPMiddleware):
    async def dispatch(
        self, request: Request, call_next: RequestResponseEndpoint
    ) -> Response:
        if not _enabled() or request.url.path in EXEMPT_PATHS:
            return await call_next(request)

        now = datetime.now(UTC)
        window_start = _window_start(now)
        try:
            # Short-lived, autocommit, 2s connect timeout — a hung pooler
            # fails open instead of burning the Lambda's own timeout
            # (mtg_api.deps.get_conn pattern, minus the shared budget).
            with psycopg.connect(database_url(), autocommit=True, connect_timeout=2) as conn:
                identifier, limit = identify(conn, request)
                count = increment(conn, identifier, window_start)
        except Exception as exc:
            # One line, no traceback — an outage shouldn't spam a stack
            # dump per request.
            logger.warning("rate limit check failed; failing open: %r", exc)
            return await call_next(request)

        window_end = window_start + timedelta(seconds=WINDOW_SECONDS)
        reset = max(1, math.ceil((window_end - now).total_seconds()))
        remaining = max(0, limit - count)

        if count > limit:
            return JSONResponse(
                {"detail": "rate limit exceeded, try again later"},
                status_code=429,
                headers={
                    "Retry-After": str(reset),
                    "X-RateLimit-Limit": str(limit),
                    "X-RateLimit-Remaining": "0",
                    "X-RateLimit-Reset": str(reset),
                },
            )

        response = await call_next(request)
        response.headers["X-RateLimit-Limit"] = str(limit)
        response.headers["X-RateLimit-Remaining"] = str(remaining)
        response.headers["X-RateLimit-Reset"] = str(reset)
        return response
