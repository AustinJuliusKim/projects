# services/mtg-api Makefile — shortcuts for the commands documented in
# README.md and OPS.md. Self-contained to this directory per the repo's
# per-area convention (see root CLAUDE.md: "no workspace root" / "no build
# tooling at the root") — do not promote this to a root-level Makefile and
# do not add targets that reach outside services/mtg-api/.
#
# `make help` (also the default target) lists everything, split into safe
# local-dev targets and admin/deploy targets that mutate real AWS/Supabase
# resources.

.DEFAULT_GOAL := help

VENV       := .venv
PY         := $(VENV)/bin/python
RUFF       := $(VENV)/bin/ruff
PYTEST     := $(VENV)/bin/pytest

# --- Configuration ----------------------------------------------------------
# Local dev default, matching docker-compose.yml's port mapping. Override for
# bootstrap/admin operations against Supabase, e.g.:
#   DATABASE_URL='postgresql://mtg_ingest:...@<project>.pooler.supabase.com:5432/postgres' make migrate
# Never hardcode a real Supabase URI here — this file is committed.
DATABASE_URL ?= postgres://postgres:postgres@localhost:54329/postgres
export DATABASE_URL

# `make ingest` options
SOURCES ?= oracle,default,rulings
FORCE   ?=

# `make embed`/`make embed-fake` options
LIMIT ?=

STACK_NAME ?= MtgApi
AWS_REGION ?= us-west-2

# sam build defaults to --use-container: the Lambda runtime is python3.12
# and dev machines (e.g. Apple Silicon Macs) may not have that interpreter
# locally. Override with `SAM_BUILD_FLAGS= make build` if you do.
SAM_BUILD_FLAGS ?= --use-container

# Docker Desktop on macOS doesn't use the default docker.sock path that SAM
# CLI's --use-container expects. Auto-export DOCKER_HOST only when the
# active docker context is desktop-linux; override on other machines with
# `DOCKER_HOST=... make build`. `?=` never clobbers an already-set env var.
DOCKER_CONTEXT := $(shell docker context show 2>/dev/null)
ifeq ($(DOCKER_CONTEXT),desktop-linux)
DOCKER_HOST ?= unix://$(HOME)/.docker/run/docker.sock
export DOCKER_HOST
endif

.PHONY: help install up down migrate migrate-dry-run lint test test-db ci \
        serve ingest embed-fake \
        build deploy deploy-bootstrap embed eval-similar eval-calibration sync-combos

# ============================================================================
# SAFE — local dev only, no external mutations.
# ============================================================================

install: ## Create .venv (if needed) and install pinned dev+ingest deps
	python3 -m venv $(VENV)
	$(VENV)/bin/pip install -r requirements-dev.txt

up: ## Start local pgvector Postgres via docker compose (localhost:54329)
	docker compose up -d

down: ## Stop the local docker compose Postgres
	docker compose down

migrate: ## Apply migrations to DATABASE_URL (default: local db; override for Supabase)
	$(PY) scripts/migrate.py

migrate-dry-run: ## Validate migrations, no DB connection (mirrors CI's api job)
	$(PY) scripts/migrate.py --dry-run

lint: ## ruff check .
	$(RUFF) check .

test: ## pytest — DB-backed suites skip without TEST_DATABASE_URL
	$(PYTEST)

test-db: up ## Start the local db, then run the full suite incl. DB-backed tests
	TEST_DATABASE_URL=$(DATABASE_URL) $(PYTEST)

ci: lint migrate-dry-run test-db ## Everything CI's "api" job runs, locally

serve: ## Run the API locally against DATABASE_URL — http://127.0.0.1:8000/docs
	$(PY) scripts/serve-local.py

ingest: ## Full ingest of real Scryfall data into DATABASE_URL (default: local db)
	$(PY) -m mtg_api.ingest.run --sources $(SOURCES) $(if $(FORCE),--force,)

embed-fake: ## Deterministic offline embedder — safe, no AWS calls
	$(PY) scripts/embed.py --fake $(if $(LIMIT),--limit $(LIMIT),)

# ============================================================================
# ADMIN / DEPLOY — mutate real AWS and/or Supabase resources. Run manually
# only; never invoke automatically (root CLAUDE.md: "Don't run deploy
# scripts or bootstrap-infra.sh" applies equally to these targets, and to
# `migrate`/`test-db` above when DATABASE_URL is overridden to a Supabase URI).
# ============================================================================

build: ## ADMIN: sam build (local-only, no AWS calls — see SAM_BUILD_FLAGS/DOCKER_HOST above)
	sam build $(SAM_BUILD_FLAGS)

deploy: build ## ADMIN: sam deploy — routine update, mirrors mtg.yml's deploy job (reuses existing DatabaseUrl)
	sam deploy \
	  --stack-name $(STACK_NAME) \
	  --region $(AWS_REGION) \
	  --resolve-s3 \
	  --capabilities CAPABILITY_IAM \
	  --no-confirm-changeset \
	  --no-fail-on-empty-changeset

deploy-bootstrap: build ## ADMIN: first-ever stack creation. Requires DatabaseUrl=<transaction pooler URI, :6543>
	@if [ -z "$(DatabaseUrl)" ]; then \
	  echo "Usage: make deploy-bootstrap DatabaseUrl='postgresql://mtg_ingest:...@<project>.pooler.supabase.com:6543/postgres'" >&2; \
	  exit 1; \
	fi
	sam deploy \
	  --stack-name $(STACK_NAME) \
	  --region $(AWS_REGION) \
	  --resolve-s3 \
	  --capabilities CAPABILITY_IAM \
	  --parameter-overrides "DatabaseUrl=$(DatabaseUrl)"

embed: ## ADMIN: real Bedrock Titan V2 embed (needs bedrock:InvokeModel creds + DATABASE_URL override) — real cost, real writes
	$(PY) scripts/embed.py $(if $(LIMIT),--limit $(LIMIT),)

eval-similar: ## ADMIN: score the similarity engine against eval/golden_synergies.yaml (needs DATABASE_URL override, real embeddings)
	$(PY) scripts/eval_similar.py

eval-calibration: ## ADMIN: refit confidence calibration — paste printed CALIBRATION into src/mtg_api/similar/scoring.py by hand
	$(PY) scripts/eval_similar.py --fit-calibration

sync-combos: ## ADMIN: pull Commander Spellbook's combo export into card_combo_pairs (needs DATABASE_URL override) — one HTTP GET, idempotent
	$(PY) scripts/sync_combos.py

help: ## Show this help
	@echo "Safe — local dev, no external mutations:"
	@grep -E '^[a-zA-Z0-9_-]+:.*## ' Makefile | grep -v '## ADMIN' \
	  | awk -F ':.*## ' '{printf "  %-18s %s\n", $$1, $$2}'
	@echo ""
	@echo "Admin / deploy — mutate real AWS/Supabase, run manually only:"
	@grep -E '^[a-zA-Z0-9_-]+:.*## ADMIN' Makefile \
	  | awk -F ':.*## ADMIN: ' '{printf "  %-18s %s\n", $$1, $$2}'
