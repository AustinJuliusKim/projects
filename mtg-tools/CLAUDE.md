# CLAUDE.md

Standalone repo (not part of the `personal/projects` monorepo). Tools for a
Magic: The Gathering collection: a stdlib-only Python library, a local web app
over it, and two self-contained HTML dashboards.

## Repo shape

```
binders/      the library — stdlib only, no dependencies, ever
webapp/       Flask JSON API + SQLite (the system of record)
frontend/     React 19 + Mantine SPA (Vite)
tests/        library suite            → python3 run_tests.py
tests_webapp/ API suite                → .venv/bin/python run_webapp_tests.py
```

Three suites, three runners, on purpose — see the dependency rule below.

## Non-negotiables

These exist because each was learned the hard way. Changing one is a decision to
write down, not a default.

- **`binders` imports nothing outside the standard library.** The web app imports
  the library; the library never imports back. `run_tests.py` must keep passing
  with nothing installed, and `tests_webapp/test_boundary.py` parses every
  `binders` module's AST to enforce it. That is also why the web suite is a
  separate runner: `run_tests.py` fails on any unsanctioned skip, and a
  "Flask missing" skip would erode that guard.
- **Money is never a float.** `Decimal` in the library, `INTEGER` cents in
  SQLite, integer cents on the wire, preformatted strings for display. The
  client does no money arithmetic. Exports write decimal dollars — the one place
  that is correct, since a spreadsheet no longer computes with it.
- **Unknown filters are rejected, never ignored.** A typo'd filter that quietly
  matches everything is how a bulk edit hits rows nobody meant to touch.
- **Bulk selection resolves server-side.** The client sends explicit ids or
  `{selectAll, filters}` — never a materialized id list standing in for
  "everything matching" — so a filter that changed since render cannot widen an
  edit.
- **Every mutation writes an inverse patch in the same transaction.** Undo is
  the backbone, not a feature; it was built before any mutation existed.
- **`serve()` binds `127.0.0.1` and raises on anything routable.** No auth means
  loopback only. Mutations require an `X-CSRF-Token` header.
- **Nothing is invented to fill a gap.** No cost basis means realized gain is
  `NULL`, not zero. No price means unpriced, not free. A partial valuation says
  so rather than reading as complete.

## Running it

```sh
make serve   # build the front end, then Flask on :8765 — never a stale dist
make dev     # hot-reload UI on :5173 + Flask API together
make test    # the three fast suites; `make e2e` for Playwright; `make check` for all
```

`make help` lists everything. The Makefile bootstraps `.venv` itself and fails
fast with a "run: nvm use" hint on a Node mismatch. The underlying commands
(`npm --prefix frontend run build`, `.venv/bin/python -m binders serve`, …)
still work directly — make only sequences them.

## Verify by running it, not only by testing it

Twice now the suite has been green while the app was broken:

- 53 tests passed while the server 500'd on **every** page — a test client runs
  in the calling thread, so it never hit the SQLite thread-affinity bug.
- 106 tests passed while a sold card vanished from the tax ledger entirely.

Both were found by starting the server and using it. Do that before claiming
something works.

## ObsidianVault

The vault at `/Users/aukim/personal/ObsidianVault/` holds the decisions behind
this repo — why prices are entered by hand, why the tier bands are what they
are, what the collection is actually for. `30-projects/MTG Collection Tooling.md`
is this repo's note; `20-notes/` holds the standards it follows.

Before starting work, grep the vault for the topic rather than reading it whole.
Those notes record locked decisions that override assumptions drawn from code
alone. **If the work would change something a note documents, say so rather than
quietly diverging** — as happened when this repo adopted Vitest against
`20-notes/Frontend Stack Standards.md`, which is now recorded as an explicit
exception rather than a silent fork.

Run `/vault-sync` before shipping work that changed `binders/`, `webapp/` or
`frontend/`, or whenever a decision was made that the code alone won't explain.
