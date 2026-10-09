# services/tcg-pos-api Makefile — shortcuts for the commands documented in
# README.md and OPS.md. Self-contained to this directory per the repo's
# per-area convention (see root CLAUDE.md: "no workspace root" / "no build
# tooling at the root") — do not promote this to a root-level Makefile and
# do not add targets that reach outside services/tcg-pos-api/.
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
# bootstrap/admin operations against Supabase. Never hardcode a real Supabase
# URI here — this file is committed.
DATABASE_URL ?= postgres://postgres:postgres@localhost:54330/postgres
export DATABASE_URL

# Card catalog + prices (services/mtg-api). Local default: mtg-api served on :8000.
MTG_API_BASE ?= http://localhost:8000
export MTG_API_BASE

STACK_NAME ?= TcgPosApi
AWS_REGION ?= us-west-2

# sam build defaults to --use-container: the Lambda runtime is python3.12
# and dev machines may not have that interpreter locally. Override with
# `SAM_BUILD_FLAGS= make build` if you do.
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

.PHONY: help install up down migrate migrate-dry-run lint test test-db ci serve build

# ============================================================================
# SAFE — local dev only, no external mutations.
# ============================================================================

install: ## Create .venv (if needed) and install pinned dev deps
	python3 -m venv $(VENV)
	$(VENV)/bin/pip install -r requirements-dev.txt

up: ## Start local Postgres via docker compose (localhost:54330)
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

test-db: up ## Start the local db, then run the full suite incl. DB-backed tests (DROPS the db's public schema)
	TEST_DATABASE_URL=$(DATABASE_URL) $(PYTEST)

ci: lint migrate-dry-run test-db ## Everything CI's "api" job runs, locally

serve: ## Run the API locally against DATABASE_URL + MTG_API_BASE — http://127.0.0.1:8001/docs
	$(PY) scripts/serve-local.py

# ============================================================================
# ADMIN / DEPLOY — run manually only; never invoke automatically (root
# CLAUDE.md's "Don't run deploy scripts" applies equally here, and to
# `migrate`/`test-db` above when DATABASE_URL is overridden to a Supabase URI).
# There is deliberately no deploy target yet: no stack, no CI deploy job.
# ============================================================================

build: ## ADMIN: sam build (local-only, no AWS calls — see SAM_BUILD_FLAGS/DOCKER_HOST above)
	sam build $(SAM_BUILD_FLAGS)

help: ## Show this help
	@echo "Safe — local dev, no external mutations:"
	@grep -E '^[a-zA-Z0-9_-]+:.*## ' Makefile | grep -v '## ADMIN' \
	  | awk -F ':.*## ' '{printf "  %-18s %s\n", $$1, $$2}'
	@echo ""
	@echo "Admin / deploy — mutate real AWS/Supabase, run manually only:"
	@grep -E '^[a-zA-Z0-9_-]+:.*## ADMIN' Makefile \
	  | awk -F ':.*## ADMIN: ' '{printf "  %-18s %s\n", $$1, $$2}'
