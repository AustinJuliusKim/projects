# Third-party API access

Consumer-facing reference for using `mtg-api` from another application.
Background research and the licensing/rate-limit sourcing behind this
document lives in [`third-party-api-research.md`](third-party-api-research.md).

## Getting a key

Keys are issued manually by the maintainer for now — there's no self-serve
signup yet (email `austinjuliuskim@gmail.com` or open an issue). Send a key
on either header:

```
Authorization: Bearer mtg_live_<32 hex chars>
X-Api-Key: mtg_live_<32 hex chars>
```

A key is optional. Every card-data endpoint works without one — see
[Licensing](#licensing--attribution) below. A key only buys a higher rate
limit.

## Tiers and limits

| Tier | How | Requests/minute |
| --- | --- | --- |
| Anonymous | no key | 60 |
| Free | API key, tier `free` | 300 |
| Supporter | API key, tier `supporter` | 1200 |

These are **launch values**, not a permanent commitment — they'll be
revisited against the comparable-API research in
[`third-party-api-research.md` §4](third-party-api-research.md#4-comparable-cardgame-api-rate-tiers)
once real traffic exists. That research leans toward daily budgets rather
than a per-minute window; if the limiter's window shape changes later, this
table is the source of truth for what's actually deployed, not the research
doc's recommendation.

`/v1/prices/*` counts against a **separate** per-caller bucket at the same
per-tier numbers, so bulk repricing never eats into card-lookup budget (and
vice versa).

### The 429 contract

Every response carries:

```
X-RateLimit-Limit: 300
X-RateLimit-Remaining: 299
X-RateLimit-Reset: 43
```

`X-RateLimit-Reset` is seconds until the current one-minute window ends.
Once a caller is over its limit, the API returns:

```
HTTP/1.1 429 Too Many Requests
Retry-After: 43
X-RateLimit-Limit: 300
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 43

{"detail": "rate limit exceeded, try again later"}
```

`Retry-After` and `X-RateLimit-Reset` are the same value; back off until
then rather than retrying immediately. Only `/`, `/docs`, and
`/openapi.json` are exempt from rate limiting — every other endpoint,
including `/v1/healthz`, counts against the caller's limit.

## Licensing & attribution

Card data comes from [Scryfall](https://scryfall.com), sourced from
Wizards of the Coast. Using this API means agreeing to the same
constraints Scryfall and Wizards place on that data:

> "mtg-api is unofficial Fan Content permitted under the Fan Content
> Policy. Not approved/endorsed by Wizards. Portions of the materials used
> are property of Wizards of the Coast. ©Wizards of the Coast LLC."

(Verbatim from the [Fan Content Policy](https://company.wizards.com/en/legal/fancontentpolicy),
quoted in [`third-party-api-research.md` §1](third-party-api-research.md#1-wotc-fan-content-policy).)

All information from this API that isn't © Wizards of the Coast LLC is
© Scryfall LLC.

Standing rules for anything built on this API:

- **Card data is never paywalled.** Anonymous access to every card-data
  endpoint always exists at the limit above, including `/similar` — today,
  API keys buy **higher rate limits only**. Gating `/similar` or other
  recommendation value-add behind a key is a possible *future* direction,
  not something this API does now; if that changes, it'll be called out
  here and in the [changelog](#changelog) first, and anonymous access to
  raw card data will still never be paywalled (Fan Content Policy).
- **Hotlink card images, don't rehost them.** Every `image_*` field in a
  response is a direct Scryfall CDN URI (`cards.scryfall.io`). Link to it
  directly; don't download and re-serve the image bytes from your own
  infrastructure — see the [Scryfall imagery
  docs](https://scryfall.com/docs/api/images) and the licensing checklist
  in `third-party-api-research.md`. Don't crop, cover, or remove the
  copyright/artist name baked into the image, and don't add your own
  watermark.
- **No verbatim reposting as physical/proxy cards.** Oracle text and card
  data may be displayed and queried, but not repackaged as printable or
  counterfeit Magic cards.
- **Don't gate access behind payment, surveys, or "follow to unlock."**
  Consistent with the Fan Content Policy — see the research doc for the
  full list of what counts as an illegal paywall.

If your own product caches or redistributes data from this API at scale,
carry the same Scryfall + Wizards of the Coast copyright notices forward.

## Prices

Daily price snapshots under `/v1/prices`, taken once a day at **21:00 UTC**.
Every snapshot is immutable and named `YYYY-MM-DD.n`; a correction is a new
revision (`.2`, `.3`, ...) with a changelog line, never an edit.

| Endpoint | What it returns |
| --- | --- |
| `GET /v1/prices/{game}/{sku_id}` | Current price object for one SKU |
| `POST /v1/prices/batch` | Up to 200 lookups by `sku_id`, `tcgplayer_id`, `scryfall_id`, or `set` + `number` (optional `finish`) |
| `GET /v1/prices/{game}/{sku_id}/history?from=&to=&series=&snapshot=` | Daily points per source, at most 366 days per page (`next_from` continues) |
| `GET /v1/prices/{game}/movers?window=1d\|7d\|30d&direction=up\|down&min_price=&min_change=&snapshot=` | Biggest movers, computed once per snapshot |
| `GET /v1/prices/{game}/sets/{set_code}` | Every priced SKU in a set, for bulk repricing |
| `GET /v1/prices/snapshots`, `/v1/prices/snapshots/{snapshot_id}` | Snapshot manifests: sources that succeeded or failed, row counts, frozen ECB EUR/USD rate, changelog |
| `GET /v1/prices/status` | Per-source last success, lag in hours, `stale` flag |

`game` is `mtg` today. A **SKU** is one sellable thing: (printing, finish,
condition, language). Foil and etched are separate SKUs, never multipliers.

Price object rules:

- **Money is integer cents** in the source's own currency, named in the key
  (`mtgjson_tcgplayer_retail_usd: 1410`, `cardmarket_guide_trend_eur: 1190`).
  Currencies are never converted or blended; the snapshot manifest carries
  the ECB rate if you want to convert yourself.
- **No price means absent, not zero.** A SKU without data has an empty
  `open` object and `null` change values.
- **Provenance on every source**: `provenance[]` gives each source's
  `lane`, `method`, `as_of`, `observed_at` and `stale`. `stale` is true when
  the source's feed is more than 36 hours past its last success; the
  top-level `stale` is true if any contributing source is.
- `own` (a listing-based index) is `null` until that index ships. Listing-
  and sales-based series are separate objects and are never averaged.
- `change` (1d/7d/30d) and movers are computed from `change_source`
  (`mtgjson_tcgplayer`, USD).

Caching: responses carry `X-Price-Snapshot`, an `ETag` (send it back as
`If-None-Match` for a `304`), and `Cache-Control: max-age` until the next
21:00 UTC snapshot. Requests pinned with `?snapshot=` (history, movers) and
snapshot manifests are cacheable forever: a pinned response never changes.

### Price attribution

Prices come from open sources, credited in every response's `attribution`
array; carry those credits forward wherever you show the numbers:

- [MTGJSON](https://mtgjson.com) (MIT): TCGplayer, Card Kingdom, Cardsphere,
  Mana Pool and Cardmarket price points.
- [Cardmarket](https://www.cardmarket.com)'s public price guide (EUR), shown
  with attribution and not to be re-sold as a price feed.
- [Scryfall](https://scryfall.com) (trend only), not to be paywalled.

Price data is never paywalled either: a key only buys rate limit.

## Versioning & changes

Every endpoint lives under `/v1`. That prefix is a stability promise:

- **Breaking changes** (removing/renaming a field or endpoint, changing a
  status code's meaning, tightening a limit) are announced in the
  [Changelog](#changelog) below ahead of the change, not after.
- **Additive changes** (a new optional field, a new endpoint, a new query
  param) ship without announcement — don't assume a response object is
  closed to new keys.

A breaking change that can't be done additively gets a new prefix
(`/v2`) rather than changing `/v1` out from under existing callers.

## Changelog

- 2026-10-09 — Additive: `/v1/prices` (daily immutable price snapshots,
  batch lookup, history, movers, per-set prices, snapshot manifests and
  status) with its own rate-limit bucket. See [Prices](#prices).
- 2026-08-05 — Additive: `/similar` results carry a new `combo` object
  (`{produces, count, popularity}`, `null` when the pair has no known-combo
  relationship) — structured version of the "known combo: ..." text that
  already appeared in `reasons`.
- 2026-08-04 — Phase 5: API keys + rate limiting shipped (this document).
