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

- 2026-08-05 — Additive: `/similar` results carry a new `combo` object
  (`{produces, count, popularity}`, `null` when the pair has no known-combo
  relationship) — structured version of the "known combo: ..." text that
  already appeared in `reasons`.
- 2026-08-04 — Phase 5: API keys + rate limiting shipped (this document).
