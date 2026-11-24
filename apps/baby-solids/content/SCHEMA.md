# Food canon — relational mapping

The canon is Markdown-with-frontmatter in `content/foods/`, compiled to
`src/generated/foods.json`. There is no database, and v1 does not need one.

This file exists so that "importable into DB records later" is a property the
compiler **enforces** rather than something we hope stayed true. `scripts/emit-sql.js
--dry-run` walks the compiled JSON and fails if any record can't be expressed
in the tables below — so the claim is re-checked on every run as the canon
grows, instead of being discovered false in January.

## Design rules the compiler enforces

1. **Stable slug primary keys.** `id` is the filename, the JSON key, and the
   future primary key. Immutable once published — renaming a food changes
   `name`, never `id`. Duplicate ids fail the build.
2. **Scalar or flat-object fields only.** Every field maps to a column or to a
   row in a named child table. No anonymous nesting, no arrays whose element
   shape varies.
3. **Relations are id arrays**, never inline objects — each becomes a
   join-table row mechanically.
4. **Closed enums**, declared once in `enums.yaml` → CHECK constraints or
   lookup tables.
5. **Prose is addressable.** Markdown sections compile to keyed fields, so the
   body is structured data too, not an opaque blob.

## Tables

### `foods`
| column | type | notes |
|---|---|---|
| `id` | `text` PK | slug; immutable |
| `name` | `text NOT NULL` | |
| `category` | `text NOT NULL` | FK → `enums.categories` |
| `first_ok_months` | `int NOT NULL` | earliest generally-appropriate age |
| `choking_level` | `text NOT NULL` | FK → `enums.chokingLevels` |
| `choking_note` | `text` | required when level is `avoid` |
| `iron_type` | `text NOT NULL` | FK → `enums.ironTypes` |
| `iron_mg_per_100g` | `numeric` | |
| `protein_g_per_100g` | `numeric` | |
| `fdc_id` | `int` | USDA FoodData Central provenance |
| `prep_minutes` | `int` | |
| `background_md` | `text` | prose section |
| `safety_note_md` | `text` | prose section |
| `hard_age_restriction_months` | `int` | e.g. 48 for whole nuts |
| `prohibited_before_months` | `int` | e.g. 12 for honey |
| `prohibition_reason` | `text` | |
| `max_per_week` | `numeric` | serving-frequency ceiling — see below |
| `frequency_limit_reason` | `text` | required when `max_per_week` is set |

> **Why a frequency cap is its own thing.** Every other limit here is "not
> before N months". Liver is the case that doesn't fit: it's excellent from six
> months and still shouldn't be served daily, because preformed vitamin A
> accumulates. Without a field for it, that caution would live only in prose,
> where the app can't act on it.

### `food_age_bands`
| column | type | notes |
|---|---|---|
| `food_id` | `text` FK → `foods.id` | |
| `band` | `text` | FK → `enums.ageBands` |
| `geometry` | `text NOT NULL` | FK → `enums.geometries` |
| `prep_md` | `text NOT NULL` | prose for this band |
| `serving_note` | `text` | |
| PK | (`food_id`, `band`) | |

### `food_allergens`
| column | type | notes |
|---|---|---|
| `food_id` | `text` FK | |
| `allergen` | `text` | FK → `enums.allergens` |
| `region_scope` | `text` | FK → `enums.allergenRegions`, default `US` |
| PK | (`food_id`, `allergen`) | |

### `food_allergen_protocol`
Zero or one row per food. Present only for foods used to introduce a major
allergen.

| column | type | notes |
|---|---|---|
| `food_id` | `text` PK FK | |
| `allergen` | `text NOT NULL` | |
| `first_dose` | `text NOT NULL` | |
| `protein_g_per_tsp` | `numeric` | |
| `maintenance_protein_g_per_week` | `numeric` | |
| `maintenance_min_sessions_per_week` | `int` | |
| `medical_gate` | `text NOT NULL` | **hard invariant — see below** |

> **The one non-negotiable.** A row here without `medical_gate` fails the
> build. That string carries the NIAID severe-eczema / egg-allergy carve-out:
> most infants can be introduced to peanut at home, but that specific group
> needs clinician contact first. A missing gate is not a formatting problem,
> it's the omission of the only medical warning in the dataset.

### `food_sources`
| column | type | notes |
|---|---|---|
| `food_id` | `text` FK | |
| `url` | `text NOT NULL` | |
| `body` | `text NOT NULL` | issuing organization |
| `tier` | `text NOT NULL` | FK → `enums.evidenceTiers` |
| `retrieved` | `date NOT NULL` | |
| PK | (`food_id`, `url`) | |

Every food needs at least one row here. A claim without a source doesn't ship.

### `food_relations`
| column | type | notes |
|---|---|---|
| `food_id` | `text` FK | |
| `related_id` | `text` FK → `foods.id` | from `[[wikilinks]]` in the body |
| PK | (`food_id`, `related_id`) | |

### `food_nutrient_tags` / `food_cultural_tags`
Simple (`food_id`, `tag`) join tables.

## Migration path

When a server appears, `migrations/0002_core.sql` mirrors these tables and a
seed script upserts from `src/generated/foods.json` by `id`, following the
`services/mtg-api` ingest pattern (batched, hash-guarded, soft-delete). No
content file changes.

Note that the compiled JSON is *also* closer to a search-engine document than
to a SQL row — denormalized, flat, id arrays. If full-text search is ever
needed server-side, Postgres `tsvector` handles this corpus without noticing;
a dedicated search cluster is not on the path.
