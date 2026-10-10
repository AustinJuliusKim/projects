# services/tcg-search Makefile — shortcuts for the commands in README.md and
# OPS.md. Self-contained to this directory per the repo's per-area convention
# (root CLAUDE.md: no workspace root) — no targets reach outside it.
#
# Everything here is local-only: the WSL OpenSearch on :9200 and the local
# mtg_dev Postgres (read-only). Nothing touches AWS or Supabase.

.DEFAULT_GOAL := help

VENV   := .venv
PY     := $(VENV)/bin/python
RUFF   := $(VENV)/bin/ruff
PYTEST := $(VENV)/bin/pytest

OPENSEARCH_URL ?= http://localhost:9200
export OPENSEARCH_URL
# Read-only role on mtg_dev (OPS.md "Read-only catalog role").
CATALOG_DATABASE_URL ?= postgres://mtg_search_reader:mtg_search_reader@localhost:54329/mtg_dev
export CATALOG_DATABASE_URL
# Scratch DB for the extract contract test (OPS.md "Test databases").
TEST_CATALOG_DATABASE_URL ?= postgres://postgres:postgres@localhost:54329/search_contract_test

.PHONY: help install lint test test-os health catalog-build catalog-status catalog-rollback eval eval-baseline

install: ## Create .venv (uv if present, else venv+pip) and install pinned dev deps
	@if command -v uv >/dev/null; then uv venv --python 3.12 $(VENV) && \
	  uv pip install -p $(PY) -r requirements-dev.txt; \
	else python3 -m venv $(VENV) && $(VENV)/bin/pip install -r requirements-dev.txt; fi

lint: ## ruff check .
	$(RUFF) check .

test: ## Unit tests (no network); integration suites skip
	$(PYTEST)

test-os: ## Full suite incl. OpenSearch + extract-contract integration tests (itest_* indices only)
	TEST_OPENSEARCH_URL=$(OPENSEARCH_URL) TEST_CATALOG_DATABASE_URL=$(TEST_CATALOG_DATABASE_URL) $(PYTEST)

health: ## Cluster health
	$(PY) -m tcg_search health

catalog-build: ## Build a new catalog index from mtg_dev and swap the `catalog` alias to it
	$(PY) -m tcg_search catalog build --swap

catalog-status: ## Alias target, versions kept, doc counts
	$(PY) -m tcg_search catalog status

catalog-rollback: ## Point `catalog` back at the previous index
	$(PY) -m tcg_search catalog rollback

eval: ## Relevance eval of the live `catalog` alias (eval/golden_search.yaml)
	$(PY) scripts/eval_search.py

eval-baseline: ## Same queries scored against mtg_dev's Postgres websearch search
	$(PY) scripts/eval_search.py --baseline-postgres

help: ## Show this help
	@grep -E '^[a-zA-Z0-9_-]+:.*## ' Makefile | awk -F ':.*## ' '{printf "  %-18s %s\n", $$1, $$2}'
