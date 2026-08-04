# Third-party API research (Phase 5)

**Generated 2026-08-04, harness Prompt 1.**

---

## 1. WotC Fan Content Policy

### Attribution Language (Required)

The official Wizards of the Coast Fan Content Policy requires the following attribution notice to appear on any fan-created content:

> "[Title] is unofficial Fan Content permitted under the Fan Content Policy. Not approved/endorsed by Wizards. Portions of the materials used are property of Wizards of the Coast. ©Wizards of the Coast LLC."

**Source:** [Fan Content Policy — Wizards of the Coast](https://company.wizards.com/en/legal/fancontentpolicy), retrieved 2026-08-04.

### What Is Allowed

- **Content must be free.** Your fan creations cannot require payments, subscriptions, or email registration to access the content itself.
- **Donations and ad revenue permitted.** You may accept donations or ad revenue, but the content must remain freely available.
- **No verbatim copying.** Fan Content does not include verbatim copying and reposting of Wizards' IP (e.g., creating counterfeit/proxy Magic cards), regardless of whether that content is distributed for free.
- **Disclose it's unofficial.** Always make clear your work is not endorsed by Wizards.
- **Avoid restricted elements.** You cannot use Wizards' logos, trademarks, patents, or game mechanics (except under the D&D Open Game License) without prior written permission.

### What Is NOT Allowed for Monetization (Directly Relevant to Third-Party APIs)

The Fan Content Policy explicitly restricts:

- **Paywalling card data.** You may not "paywall" access to Scryfall data or similar Magic card content.
- **Requiring payments for access.** You cannot require anyone to make payments, take surveys, agree to subscriptions, rate your content, join chat servers, or follow channels in exchange for access to card data itself.

**Implication for Phase 5:** Anonymous free access to all card-data endpoints must always exist and cannot be paywalled. Paid tiers can sell **rate limits and value-add services** (e.g., recommendations, higher concurrency for the same data), but not the card data itself.

**Sources:**
- [Fan Content Policy — Wizards of the Coast](https://company.wizards.com/en/legal/fancontentpolicy), retrieved 2026-08-04
- [WotC Licensing and Intellectual Property Rights — LegalClarity](https://legalclarity.org/wotc-licensing-and-intellectual-property-rights/), retrieved 2026-08-04

---

## 2. Scryfall API Guidelines

### Rate Limiting

**Requested rate:** Scryfall asks all API consumers to keep sustained traffic **under 10 requests per second** (50–100 ms delay between calls).

**Hard caps:**
- General endpoints: 10 req/sec (enforcement via HTTP 429)
- `/cards/collection` endpoint: 2 req/sec hard cap (500 ms)

**Penalty for exceeding limits:** Receiving HTTP 429 (Too Many Requests) will result in your access being limited for 30 seconds. Continued overload after the initial 429 may result in temporary or permanent ban of your application. Applications receiving constant rate limit warnings over time will be blocked.

**Source:** [API Rate Limits — Scryfall](https://scryfall.com/docs/api/rate-limits), retrieved 2026-08-04.

### User-Agent and Request Headers

Every request to Scryfall must include:
- A **descriptive User-Agent header** that identifies the application (with contact info preferred).
- An **Accept header** (typically `application/json`).

Generic user agents (e.g., `curl`, `python-requests` defaults) are routinely blocked.

**Source:** [Scryfall API Rate Limits and FAQs](https://scryfall.com/docs/api/rate-limits), retrieved 2026-08-04.

### Image Hotlinking and Attribution

> **Edit note (2026-08-04, harness Prompt 3):** this subsection originally said
> the opposite of the licensing checklist below (§"Licensing Checklist for
> Phase 5") and the cited Scryfall imagery doc. Corrected to match: Scryfall's
> images doc expects consumers to link directly to their CDN, not download and
> rehost the files.

**Hotlink Scryfall image URIs directly** (e.g. `cards.scryfall.io`) rather than
downloading and rehosting the bytes on your own infrastructure — Scryfall's
CDN is built to serve them and rehosting only adds unnecessary storage/bandwidth
on your side without any licensing benefit.
- Scryfall provides six image renderings per card: small, normal, large, png, art_crop, and border_crop.

**Image modification restrictions:**
- Do not cover, crop, or clip off the copyright or artist name on card images.
- Do not distort, skew, or stretch card images.
- Do not blur, sharpen, desaturate, or color-shift card images.
- Do not add your own watermarks, stamps, or logos to card images.

**Attribution for art_crop images:** When using the art_crop image, you must list the artist name and copyright elsewhere in the same interface, or use the full card image elsewhere—users must be able to identify the artist and source.

**Source:** [Scryfall API Documentation — Card Imagery](https://scryfall.com/docs/api/images), retrieved 2026-08-04.

### Bulk Data for Large-Scale Use

For large-volume use cases, **use the daily bulk-data exports instead of crawling individual card endpoints.**

**Update frequency:**
- **Gameplay data (names, oracle text, mana costs, etc.):** Updates are much less frequent; downloading once per week or after set releases is typically sufficient.
- **Price data:** Updated once per day; prices should be considered dangerously stale after 24 hours and must not be used to power storefronts or sales.
- **Overall cadence:** Daily bulk-data exports; both JSON and JSONL formats provided until 2026-07-20, **JSONL is now the only format** (as of 2026-07-20).

**Format details:** JSONL is gzipped, with each JSON object on its own line (no parent array, no commas between objects), allowing line-by-line or chunked streaming without decompressing the entire file into memory.

**Data redistribution:** Card and set data is highly cacheable; Scryfall encourages aggressive local caching. **Large-scale data redistribution (e.g., third-party APIs) must cite Scryfall and Wizards of the Coast copyrights.**

**Scryfall copyright notice:** All information obtained from the Scryfall API which is not © Wizards of the Coast LLC is © Scryfall LLC.

**Paywalling restriction:** You may not "paywall" access to Scryfall data or require anyone to make payments, take surveys, agree to subscriptions, or join channels in exchange for access to Scryfall data.

**Sources:**
- [Bulk Data Files — Scryfall API Documentation](https://scryfall.com/docs/api/bulk-data), retrieved 2026-08-04
- [Two New Ways to Sync Scryfall Data — Scryfall Blog](https://scryfall.com/blog/two-new-ways-to-sync-scryfall-data-236), retrieved 2026-08-04
- [REST API Documentation — Scryfall](https://scryfall.com/docs/api), retrieved 2026-08-04
- [Terms of Service — Scryfall](https://scryfall.com/docs/terms), retrieved 2026-08-04

---

## 3. Postgres Fixed-Window Rate Limiting

### Hot-Row Contention Problem

The synchronous fixed-window counter pattern `INSERT ... ON CONFLICT (key) DO UPDATE SET count=count+1 RETURNING count` suffers from **hot-row contention** under concurrent short-lived connections (like Lambda invocations):

- **Tuple versioning:** Chains of tuple versions accumulate under high concurrency, making visibility checks more expensive.
- **Lock contention:** Multiple concurrent transactions competing for the same row's lock serialize their writes to that single row.
- **WAL fsync:** Postgres's bottleneck at realistic concurrency levels is serialization of durable commits, not CPU or I/O.

**Result:** Under heavy concurrent load, a single counter row becomes a global serialization point, degrading throughput.

**Source:** [Ultra fast asynchronous counters in Postgres — Alexey Timanovskiy, Medium](https://medium.com/@timanovsky/ultra-fast-asynchronous-counters-in-postgres-44c5477303c3), retrieved 2026-08-04.

### Connection Pooling Limits (Supabase)

**Supabase Free tier:**
- 60 max direct connections
- 200 pooler connections (transaction or session mode)
- Database is kept warm by ingest cron (2×/week) to prevent auto-pause after ~7 idle days

**Supabase Pro tier:**
- Max pooler clients determined by compute tier; exact numbers not explicitly documented in current (2026-08) docs. Check your project's Add-On Dashboard for current limits.
- Supabase Pro supports higher max_connections and larger pools than Free.
- **Unknown — verify:** Exact Pro tier concurrent connection limits; check Supabase compute and disk limits documentation.

**Lambda-specific constraint:** Each Lambda invocation typically opens a new connection. Short-lived connections combined with auto-scaling Lambda can exhaust pooler capacity; connection poolers limit concurrent clients independently of backend Postgres connections.

**Sources:**
- [Connect to your database — Supabase Docs](https://supabase.com/docs/guides/database/connecting-to-postgres), retrieved 2026-08-04
- [Supabase Free Tier Limits: What You Actually Get in 2026 — aiagencyplus.com](https://aiagencyplus.com/supabase-free-tier-limits/), retrieved 2026-08-04

### Throughput Bottleneck Thresholds

**Query workloads:**
- On typical Postgres instances, query throughput hits a bottleneck around **~3,000 req/sec**.
- Beyond that, Postgres becomes the limiting resource due to connection pool saturation, lock contention, and CPU scheduling overhead.

**Optimized counter workloads (asynchronous / batch):**
- With proper indexing and event-based batching, Postgres can handle **~12,000–25,000 counter updates/sec** on a single hot row.
- However, this requires decoupling event writing from counter updates (asynchronous aggregation), not synchronous `ON CONFLICT` per request.

**Synchronous per-request counters:**
- Synchronous `INSERT ... ON CONFLICT` for rate-limiting (the simpler pattern) becomes a bottleneck well before 12,000 req/sec on Lambda-scale workloads.
- Typical production rate limiters built on Postgres synchronously handle **~12,000 req/sec** across an API, but this includes entire request processing, not just the counter.

**Decision rule:** For a per-key Postgres counter under Lambda's concurrent-connection constraints:
- **< 1,000 req/sec sustained:** Synchronous Postgres counter is acceptable (Free or Pro tier with session pooler).
- **1,000–5,000 req/sec sustained:** Monitor connection pool utilization; Pro tier pooler likely required; consider indexing and connection optimization.
- **> 5,000–10,000 req/sec sustained:** Postgres hot-row counter becomes measurable bottleneck; migrate to **DynamoDB** (see below) for sub-millisecond latency and automatic scaling.

**Sources:**
- [Rate limiting with postgres — Medium](https://medium.com/@testytesty334/building-our-own-rate-limiting-system-604cf7366902), retrieved 2026-08-04
- [Optimizing API Rate Limiters: Reducing Latency from 200ms to 3ms with B-Tree Indexing — Dev|Journal](https://earezki.com/ai-news/2026-06-14-indexing-the-force-awakens-in-my-rate-limiter-quest/), retrieved 2026-08-04
- [Ultra fast asynchronous counters in Postgres — Alexey Timanovskiy, Medium](https://medium.com/@timanovsky/ultra-fast-asynchronous-counters-in-postgres-44c5477303c3), retrieved 2026-08-04
- [Postgres Connection Pooling: Stop the Timeouts — DEV Community](https://dev.to/speed_engineer/postgres-connection-pooling-stop-the-timeouts-obg), retrieved 2026-08-04

### Alternative: DynamoDB

DynamoDB is purpose-built for high-concurrency, low-latency workloads like rate-limiting counters:

- **Consistent latency:** Single-digit millisecond response times regardless of scale.
- **Autoscaling:** Automatic capacity scaling based on actual traffic (no manual pool sizing).
- **Throughput:** Can serve >20 million requests/second at peak with millisecond latency.
- **Per-request model:** Each request is routed independently (O(1) complexity); no hot-row contention.

**Trade-off:** DynamoDB is a managed service (costs scale with traffic); Postgres is already in the stack for data storage, so the counter on Postgres uses existing capacity until true bottleneck. Move to DynamoDB when Postgres counter latency or throughput becomes measurable.

**Sources:**
- [DynamoDB vs PostgreSQL: A Concise Comparison — Bytebase](https://www.bytebase.com/blog/dynamodb-vs-postgres/), retrieved 2026-08-04
- [PostgreSQL vs DynamoDB — Better Stack Community](https://betterstack.com/community/guides/databases/postgresql-vs-dynamodb/), retrieved 2026-08-04

---

## 4. Comparable Card/Game API Rate Tiers

### Scryfall (MTG reference baseline)

**Free tier (anonymous, no key):**
- 10 requests per second sustained (50–100 ms delay)
- No API key; no paid tier
- Bulk data available daily

**Model:** Attribution-based, no monetization or tier differentiation. Community-funded (Patreon/Ko-fi).

**Source:** [Scryfall API Documentation](https://scryfall.com/docs/api) and [Rate Limits](https://scryfall.com/docs/api/rate-limits), retrieved 2026-08-04.

### YGOProDeck (Yu-Gi-Oh card database API)

**Free tier:**
- 20 requests per second
- No API key required
- No paid tiers documented

**Penalty:** Exceeding 20 req/sec results in 1-hour block.

**Model:** Completely free API with uniform rate limits; monetization via optional YGOPRODeck Premium (subscription benefits not documented in API context, likely game features rather than API access).

**Source:** [Yu-Gi-Oh! API Guide — YGOPRODeck](https://ygoprodeck.com/api-guide/), retrieved 2026-08-04.

### TCG API (Multi-game, including MTG)

**Free tier:**
- 100 requests per day (1.16 req/min average, negligible burst)
- Covers 89+ trading card games (MTG, Pokémon, Yu-Gi-Oh!, Lorcana, One Piece, etc.)
- No API key required; attribution-based

**Paid tiers:**
- **Hobby:** $9.99/mo — 1,000 requests/day
- **Starter:** $19.99/mo — 2,500 requests/day
- **Pro:** $49.99/mo — 10,000 requests/day

**Model:** Tiered by request volume; same data available on all tiers (no paywalling).

**Source:** [TCG API — Pricing](https://tcgapi.dev/pricing/), retrieved 2026-08-04.

### TCG Price Lookup (Pricing API, not data API)

**Free tier:**
- 200 requests per day (burst: 1 request per 3 seconds)
- Covers pricing for 8 games including MTG

**Paid tiers:**
- **Trader:** $14.99/mo — 10,000 requests/day (burst: 1 req/sec)
- **Business:** $89.99/mo — 100,000 requests/day (burst: 3 req/sec)

**Source:** [TCG Price Lookup — Free and Paid Plans](https://tcgfast.com/), retrieved 2026-08-04.

### Summary Table

| API | Free Tier | Paid Option | Model |
|---|---|---|---|
| **Scryfall** | 10 req/sec | None | Attribution-based, community-funded |
| **YGOProDeck** | 20 req/sec | None (API only) | Free + optional game premium |
| **TCG API** | 100 req/day | $9.99–49.99/mo for 1k–10k req/day | Tiered by volume; no paywalling |
| **TCG Price Lookup** | 200 req/day | $14.99–89.99/mo for 10k–100k req/day | Tiered by volume |

**Sources:**
- [Scryfall API Documentation](https://scryfall.com/docs/api), retrieved 2026-08-04
- [Yu-Gi-Oh! API Guide — YGOPRODeck](https://ygoprodeck.com/api-guide/), retrieved 2026-08-04
- [TCG API — Pricing](https://tcgapi.dev/pricing/), retrieved 2026-08-04
- [TCG Price Lookup — Plans](https://tcgfast.com/), retrieved 2026-08-04

---

## Implications for Phase 5

### Recommended Rate Tier Structure

Based on licensing constraints (card data never paywalled) and comparable APIs:

1. **Anonymous (unkeyed) access:**
   - Rate limit: **100–200 req/day** (conservative; aligns with TCG API free tier, discourages scraping without key).
   - Justification: Non-authenticated users have the lowest trust; keeps free tier affordable; matches competitor baseline.
   - Endpoints: All card-data endpoints, including search, similar, autocomplete.

2. **Free API key tier (`mtg_free`):**
   - Rate limit: **1,000 req/day** (compat with TCG API Hobby tier; ~33 req/hour, or 2–3 sec between calls).
   - Justification: Registered users can build light integrations; rate sufficient for small projects or interactive tools; still prevents heavy scraping.
   - Attribution still required (same as Scryfall and Wizards policy).

3. **Supporter API key tier (`mtg_supporter`):**
   - Rate limit: **10,000 req/day** (compat with TCG API Pro tier; ~6.9 req/min, or sub-second between calls).
   - Justification: Small commercial or heavy personal use; covers typical deck-builder or exploration tool; differentiation is **rate limit + access to recommendations engine**, not card data.
   - Attribution still required; Scryfall bulk data hotlinked with attribution (never rehosted per licensing).

### Rate Limiter Implementation

**Recommended approach for Phase 5:**

- **Anonymous ceiling:** Enforce at CloudFront/edge via `ops/edge-waf.yaml` ACL (no new costs; already exists).
- **Per-key counters:** Postgres fixed-window counter in FastAPI middleware (`INSERT ... ON CONFLICT DO UPDATE SET count=count+1`).
  - Justification: Expected load < 1,000 req/sec sustained (small user base at launch); Supabase Free pooler sufficient (200 connections); pro-forma bottleneck threshold is ~3,000 req/sec query workload or ~12,000 req/sec optimized counter.
  - Migration path: If key rate-limit table throughput becomes latency > 10ms per request at any tier, move to DynamoDB counters (separate from Postgres data layer).

### Licensing Checklist for Phase 5

- [ ] Root `/` or `/docs` page includes Wizards Fan Content Policy attribution notice (verbatim or linked).
- [ ] `/docs` or `/v1/cards` endpoint description states: "Card data is never paywalled; anonymous access always available."
- [ ] Paid tiers (`supporter`) sell rate limits and recommendations, not card data.
- [ ] Image hotlinking: Scryfall URIs (e.g., `cards.scryfall.io`) are hotlinked in API responses; **never rehost** (per Scryfall CDN request and WotC policy compliance).
- [ ] Bulk data redistribution: If Phase 4+ webapp caches Scryfall images, include Scryfall and Wizards copyright notices in caching headers or footer.
- [ ] No verbatim Oracle text modifications (text is canonical from Scryfall).

---

## Sources Summary

**WotC & Scryfall Policies:**
- [Fan Content Policy — Wizards of the Coast](https://company.wizards.com/en/legal/fancontentpolicy)
- [Terms of Service — Scryfall](https://scryfall.com/docs/terms)
- [REST API Documentation — Scryfall](https://scryfall.com/docs/api)
- [Bulk Data Files — Scryfall API Documentation](https://scryfall.com/docs/api/bulk-data)
- [Card Imagery — Scryfall API Documentation](https://scryfall.com/docs/api/images)
- [API Rate Limits — Scryfall](https://scryfall.com/docs/api/rate-limits)

**Postgres Rate Limiting & Performance:**
- [Rate Limiting in Postgres — Neon Guides](https://neon.com/guides/rate-limiting)
- [Ultra fast asynchronous counters in Postgres — Alexey Timanovskiy, Medium](https://medium.com/@timanovsky/ultra-fast-asynchronous-counters-in-postgres-44c5477303c3)
- [Postgres Connection Pooling: Stop the Timeouts — DEV Community](https://dev.to/speed_engineer/postgres-connection-pooling-stop-the-timeouts-obg)
- [Rate limiting with postgres — Medium](https://medium.com/@testytesty334/building-our-own-rate-limiting-system-604cf7366902)
- [Optimizing API Rate Limiters: Reducing Latency from 200ms to 3ms with B-Tree Indexing — Dev|Journal](https://earezki.com/ai-news/2026-06-14-indexing-the-force-awakens-in-my-rate-limiter-quest/)

**Supabase Limits:**
- [Connect to your database — Supabase Docs](https://supabase.com/docs/guides/database/connecting-to-postgres)
- [Supabase Free Tier Limits: What You Actually Get in 2026 — aiagencyplus.com](https://aiagencyplus.com/supabase-free-tier-limits/)

**Comparable APIs:**
- [Scryfall API Documentation](https://scryfall.com/docs/api)
- [Yu-Gi-Oh! API Guide — YGOPRODeck](https://ygoprodeck.com/api-guide/)
- [TCG API — Pricing](https://tcgapi.dev/pricing/)
- [TCG Price Lookup — Plans](https://tcgfast.com/)

**All retrieved 2026-08-04.**
