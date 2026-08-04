# ⚠ Vault staging draft — transpose, then delete this file

Transpose this content to `ObsidianVault/30-projects/MTG Card Database.md`
from a machine with vault access, then **delete this file** — per CLAUDE.md,
project decisions live in the vault and a lingering copy here would drift.

---

# MTG Card Database

Scryfall-class card database + API with a differentiator: card similarity
driven by mechanics and card text (not decklist co-occurrence — deliberately
avoiding the EDHREC precon/staple bias). Code: `projects/services/mtg-api/`.
Full plan + costs: `projects/services/mtg-api/docs/PLAN.md`.

## Locked decisions

- **Stack**: FastAPI (Python) on Lambda via Mangum — the monorepo's first
  Python service. SAM + HttpApi mirroring guided-repl-api.
- **Database**: Supabase Free → Pro when it outgrows 500MB. Postgres +
  pgvector (`halfvec(512)` embeddings, HNSW). Measured: 193MB with all cards
  + printings + rulings; ~90–115MB more with embeddings — fits Free.
- **Data scope**: full oracle cards (~35k) + slim printings (~110k),
  streamed from Scryfall JSONL bulk (gzip; JSONL-only since 2026-07-20).
- **Budget**: ~$0–5/mo until it has users (measured ~$0–2). One-time full
  embed via Bedrock Titan V2 ≈ $0.50. First paid step: Supabase Pro $25/mo —
  raise the $35 billing alarm then.
- **Licensing (product constraint)**: WotC Fan Content Policy / Scryfall
  terms — card data is never paywalled. Paid tiers may only sell rate limits
  and recommendation value-add. Attribution required.
- **Recommendations**: hybrid scoring (0.55 embedding cosine + 0.25
  keyword/mechanic jaccard + 0.10 type overlap + 0.10 resource signals),
  calibrated confidence bands, human-readable reasons. Golden-synergy eval
  gate: recall@10 ≥ 0.5 before public. No trained model before ~10k user
  feedback events; webapp logs suggestion feedback from day one.

## Status (2026-08-04)

- Merged: phase 1 schema+ingest (PR #74), phase 2 FastAPI service (PR #75),
  phase 3 similarity engine (PR #76). Phase 4 webapp
  (`apps/mtg-webapp`: search, card pages with similar-panel above the fold,
  localStorage deck builder with deck-level suggestions, suggestion-feedback
  logging) in review.
- Ingest cron Mon+Thu (also keeps Supabase Free from pausing).
- Nothing deployed to AWS yet: deploys gated on `MTG_DEPLOY_ENABLED` /
  `MTG_WEBAPP_DEPLOY_ENABLED` repo variables.

## Pending ops (blocking go-live)

Full ordered checklist with commands:
`projects/services/mtg-api/docs/OPS.md`. Summary: (1) Supabase project +
`mtg_ingest` role + `MTG_DATABASE_URL` secret + first ingest; (2) IAM
deploy role + first manual `sam deploy` + `MTG_DEPLOY_ENABLED=true`;
(3) `MTG_EMBED_ENABLED=true` → first real embed (~$0.50) → refit confidence
calibration; (4) webapp stack + `MTG_WEBAPP_DEPLOY_ENABLED=true`.

## Roadmap

Phase 5: third-party API keys/tiers (hashed keys in Postgres, per-key rate
limiting, licensing-compliant free tier). Later: offline LLM re-rank batch
(~$10–30) when heuristic recall plateaus; no trained model before ~10k
suggestion-feedback events (logging live since phase 4).
