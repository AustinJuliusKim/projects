# tcg-search

OpenSearch-backed card search for the TCG POS storefront (plan: "Per-store
TCG storefront with OpenSearch search", milestones M0–M3). A Python library +
CLI; no server of its own. tcg-pos-api imports it for the listings indexer
(M5) and the storefront routes (M6).

- **`catalog`** alias: one doc per oracle card (35k) with nested paper
  `printings`, rebuilt nightly from mtg_dev. Autocomplete fallback,
  did-you-mean, card data, "browse everything", the relevance eval.
- **`listings`** alias (created and filled by M5): one doc per store × card,
  `_id = <tenant_id>:<oracle_id>`, routed by tenant, nested `offers`.

Ops (install, read-only DB role, nightly reindex): [OPS.md](OPS.md).

## Quick start

```sh
make install                 # .venv with pinned deps (uv if present)
make health                  # cluster health
make catalog-build           # build from mtg_dev, swap `catalog` (~20 s)
.venv/bin/python -m tcg_search search 'bolt'
.venv/bin/python -m tcg_search search 't:dragon c:r mv<=4' --json
make eval                    # relevance report on the live alias
make test                    # unit tests (no network)
make test-os                 # + OpenSearch and extract-contract integration tests
```

## Search syntax (v1)

Free text, `"phrases"`, `-negation`, and Scryfall-style filters:
`t:` `o:` (`~` = this card) `c:` `id:` `s:`/`e:` (code, alias like
`alpha`, or set name) `r:` `mv:` `pow:` `tou:` `loy:` `f:` `banned:`
`restricted:` `kw:` `a:` `name:` `is:reserved|dfc|foil|nonfoil|etched|promo|digital`
`not:` `cond>=lp` (listings) `usd<5`, with `: = != < <= > >=`. Colors: `c:`
means "at least", `id:` means "within" (commander), `c:m` multicolor, `c:c`
colorless, guild/shard names work. Unknown keys and bad values become free
text plus a warning — the parser never fails a request. Full grammar:
`src/tcg_search/query/syntax.py`.

Ranking for free text: exact name (incl. any face, punctuation-insensitive)
> nickname (`data/nicknames.yaml`) > legendary short name ("kenrith") > name
words > fuzzy name > name prefix > cross-field text, plus EDHREC popularity
(and stock depth on listings). Name-like queries whose top hit is only a
fuzzy/text match get a did-you-mean; close or zero-hit cases are answered
for the suggestion (`corrected: true`, "Showing results for X").

## Public API (for tcg-pos-api M5/M6)

```python
from tcg_search.client import OpenSearch, OpenSearchError, OpenSearchUnavailable, BulkResult
OpenSearch(url=None, *, transport=None, auth=None, verify=None)  # env: OPENSEARCH_URL/_USER/_PASSWORD/_VERIFY
  .bulk(actions, *, index=None, refresh=False) -> BulkResult   # actions: (op, meta, source|None)
  .search(index, body, *, params=None) / .mget(index, ids) / .count(index)
  .create_index(name, body) / .delete_index(name, missing_ok=False) / .get_index(name)
  .get_alias(alias) / .swap_alias(alias, new_index) / .analyze(...) / .health()

from tcg_search.mappings import listings_index_body, catalog_index_body, NESTED_PATH
listings_index_body(meta=None) -> dict          # routing required, dynamic strict

from tcg_search.docs import card_fields, listing_doc, offer_doc, listing_id
card_fields(card_row) -> dict                   # card-level fields shared by both indices
listing_doc(card_row, tenant_id, offers, *, updated_at=None) -> dict | None
    # None => nothing sellable: DELETE listing_id(tenant, oracle_id) with routing=tenant_id.
    # offers: [{printing_id, set_code, set_name, collector_number, rarity, finish,
    #           condition, lang, price_cents, available, image_small?, ...}]
    # `available` must already have the store's holdback applied (web_available()).
    # Unpriced (null/0) or available <= 0 offers never list.
listing_id(tenant_id, oracle_id) -> "tenant:oracle"

from tcg_search.query import SearchRequest, build_search, search, autocomplete, search_params
SearchRequest(q="", mode="catalog"|"stock", tenant_id=None, facets={}, sort="relevance",
              page=1, page_size=24, include_digital=False)
search(os_, req, *, catalog_index=None, listings_index=None) -> dict
    # {total, took_ms, page, page_size, results[], facets{}, query{clauses[]},
    #  warnings[], did_you_mean, corrected}; raises OpenSearchUnavailable -> map to 503
build_search(req, *, index_kind="catalog"|"listings", tenant_id=None) -> dict  # pure
    # listings: ValueError without tenant_id; always tenant-filtered.
search_params(index_kind, tenant_id) -> {"routing": tenant_id} for listings
autocomplete(os_, prefix, *, tenant_id=None, size=8, catalog_index="catalog",
             listings_index="listings") -> [{oracle_id, name, image_small, price_cents, in_stock}]
```

Card rows (`card_row`) are mappings with the mtg `cards` columns listed in
`catalog/extract.py` (oracle_id, name, mana_cost, mana_value, type_line,
oracle_text, colors, color_identity, keywords, power, toughness, loyalty,
defense, produced_mana, layout, legalities, card_faces, reserved,
edhrec_rank), e.g. mtg-api's `/v1/cards/{id}`. Don't feed `card_fields` /
`listing_doc` catalog `_source` docs: those are already shaped (rules text
has the card's name replaced by `cardname`). For that there is

```python
listing_doc_from_catalog(catalog_src, tenant_id, offers, *, updated_at=None) -> dict | None
    # card fields copied verbatim from a catalog doc's _source; each offer gets
    # its printing's set/rarity/image from the doc's `printings`; offers for
    # other cards' printings are dropped. Same None => delete rule.
```

which is what tcg-pos-api's listings indexer (M5) uses, so it needs only the
catalog index, never the mtg DB.

Facets (`req.facets`, multi-select, OR within a facet, AND across):
`set`, `rarity`, `finish`, `condition` (listings), `price` (band keys
`0-100`, `100-500`, `500-2000`, `2000-5000`, `5000-10000`, `10000-`, in
cents), `colors`, `identity`, `types`, `keywords`, `format`. Counts are
cards, not printings/offers. Sorts: `relevance`, `popular`, `name`,
`price_asc`, `price_desc` (nested, honouring copy filters), `newest`, `mv`.
Paging: `page_size` ≤ 100, `page × page_size` ≤ 2400.

## Relevance (eval/golden_search.yaml, 80 graded queries)

`scripts/eval_search.py` (`make eval`, `--baseline-postgres`, `--compare`,
`--json`, `--gate`). Measured 2026-10-10 on mtg_dev (35,382 cards):

| category (n) | Postgres today¹ nDCG@10 / S@1 / zero | Postgres by EDHREC² | OpenSearch v0 (first build)³ | OpenSearch final |
|---|---|---|---|---|
| nav (25) | 0.746 / 0.480 / 0% | 0.988 / 0.960 / 0% | 0.977 / 0.952 / 0% | 1.000 / 1.000 / 0% |
| typo (17) | 0.108 / 0.059 / 82% | 0.176 / 0.176 / 82% | 0.933 / 0.933 / 0% | 1.000 / 1.000 / 0% |
| accent (14) | 0.376 / 0.286 / 57% | 0.357 / 0.286 / 57% | 0.992 / 1.000 / 0% | 0.992 / 1.000 / 0% |
| nickname (15) | 0.039 / 0.000 / 60% | 0.075 / 0.067 / 60% | 0.972 / 0.923 / 0% | 1.000 / 1.000 / 0% |
| syntax (9) | 0.000 / 0.000 / 89% | 0.054 / 0.111 / 89% | 0.997 / 1.000 / 0% | 0.997 / 1.000 / 0% |
| **all (80)** | **0.329 / 0.212 / 49%** | 0.429 / 0.412 / 49% | 0.972 / 0.958 / 0% | **0.998 / 1.000 / 0%** |
| gate | FAIL (name S@1 0.239) | FAIL (0.451) | PASS (0.952) | **PASS (1.000)** |

¹ mtg-api `search_cards` as served (`websearch_to_tsquery`, default
`order=name`). ² Same SQL ordered by EDHREC rank. ³ v0 was measured on the
first 72 queries; the 8 added afterwards (to make the set harder) all pass.
Median OpenSearch `took` 7–10 ms; autocomplete 12–22 ms end to end.

What moved v0 → final: a legendary short-name field ("kenrith" →
Kenrith, the Returned King over Kenrith's Transformation), raising the
nickname weight above incidental name matches ("goyf" → Tarmogoyf over
Chimney Goyf), name analyzers that split *and* catenate apostrophes
("lim dul" now also matches Lim-Dûl's …), and did-you-mean on weak
(non-name) top hits with a similarity threshold ("llanowar elfs").

Caveat: the golden set was written alongside the ranking, so treat 1.000 as
"no known regressions", not a general accuracy number. Add real storefront
queries (UBI is installed) as they arrive.
