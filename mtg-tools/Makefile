# Every command the README asks you to remember, as one word each.
# `make help` (or bare `make`) lists them.
#
# The reason `serve` depends on `build`: the two halves reload differently.
# Flask reads frontend/dist per request but loads webapp/*.py once, so a stale
# build or a stale process shows yesterday's app with no error. Starting
# through `make serve` rebuilds (~0.5s) and boots fresh, so neither half can
# be stale.

PY  := .venv/bin/python
NPM := npm --prefix frontend

.DEFAULT_GOAL := help
.PHONY: help serve dev build test test-py test-webapp test-fe e2e check node-check

help: ## list these targets
	@grep -E '^[a-z0-9-]+:.*##' Makefile | awk -F':.*## ' '{printf "  make %-12s %s\n", $$1, $$2}'

# Extra flags pass through: make serve SERVE_ARGS="--port 9000 --db /tmp/x.db"
SERVE_ARGS ?=

serve: .venv build ## build the front end, then run the app on :8765
	$(PY) -m binders serve $(SERVE_ARGS)

dev: .venv frontend/node_modules node-check ## hot-reload UI on :5173 + Flask API, one terminal
	@# `exec` makes $$! vite's own PID — killing the npm wrapper instead would
	@# depend on npm forwarding the signal to its child.
	@(cd frontend && exec node_modules/.bin/vite) & VITE=$$!; \
	trap 'kill $$VITE 2>/dev/null' EXIT INT TERM; \
	$(PY) -m binders serve $(SERVE_ARGS)

build: frontend/node_modules node-check ## build the front end into frontend/dist
	$(NPM) run build

test: test-py test-webapp test-fe ## the three fast suites

test-py: ## library suite, bare interpreter — stdlib-only stays provable
	python3 -W error::ResourceWarning run_tests.py

test-webapp: .venv ## API suite
	$(PY) -W error::ResourceWarning run_webapp_tests.py

test-fe: frontend/node_modules node-check ## vitest
	$(NPM) test

e2e: .venv build ## Playwright against a real server and the real build
	cd frontend && E2E_PYTHON=$(abspath $(PY)) npx playwright test

check: test e2e ## everything CI runs, plus lint
	$(NPM) run lint

# --- bootstrap ---------------------------------------------------------------

.venv:
	python3 -m venv .venv && .venv/bin/pip install -r requirements.txt

# npm ci only when the lockfile is newer than the last install.
frontend/node_modules: frontend/package-lock.json
	$(NPM) ci
	@touch frontend/node_modules

# Fail with the fix, instead of a vite engine error three commands later.
node-check:
	@test "$$(node -v 2>/dev/null | cut -d. -f1)" = "v$$(cat .nvmrc)" || \
	{ echo "node is $$(node -v 2>/dev/null || echo missing), .nvmrc wants $$(cat .nvmrc) — run: nvm use"; exit 1; }
