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

- Phase 1 (schema + ingest) merged — PR #74. Phase 2 (FastAPI service)
  merged — PR #75. Phase 3 (similarity engine) in review.
- Ingest cron Mon+Thu (also keeps Supabase Free from pausing).
- Nothing deployed to AWS yet: deploy job gated on `MTG_DEPLOY_ENABLED`.

## Pending ops (blocking go-live)

1. Supabase project + `mtg_ingest` role (owns the mtg tables — run first
   migrate as that role); `MTG_DATABASE_URL` repo secret (session pooler
   :5432); dispatch first ingest.
2. IAM role `mtg-api-github-deploy` from `services/mtg-api/docs/iam-policy.json`
   (includes Bedrock Titan invoke); first manual `sam deploy` with
   `DatabaseUrl=<transaction pooler :6543>`; set `MTG_DEPLOY_ENABLED=true`.
3. Set `MTG_EMBED_ENABLED=true` → next ingest runs the first real embed;
   then `scripts/eval_similar.py --fit-calibration` and commit refreshed
   confidence constants.

## Roadmap

Phase 4: `apps/mtg-webapp` (Vite/React 19, S3+CloudFront, search + card
pages + deck builder skeleton; similar-cards panel above the fold; log
suggestion feedback). Phase 5: third-party API keys/tiers (hashed keys in
Postgres, per-key rate limiting, licensing-compliant free tier). Later:
offline LLM re-rank batch (~$10–30) when heuristic recall plateaus.
