# claude-repl-backend

Long-lived WebSocket server for the [`claude-repl`](../../apps/claude-repl)
playground. It runs **Claude Code headless inside a per-session
[E2B](https://e2b.dev) sandbox** and streams the events (assistant text, tool
use, file writes, bash output, token usage, permission prompts) to the browser.

This is a `services/` project (not an `apps/` Lambda) because it is **stateful
and long-lived**: it holds open WebSocket connections, live sandbox handles, and
child processes per session, and deploys to a persistent container/VM.

## Authentication — BYOK only

Users supply their **own Anthropic API key**. The key:

- lives in the browser's `sessionStorage`, is sent over WSS, and is held **in
  memory only** on the server (never disk/DB),
- is passed to the sandbox as `ANTHROPIC_API_KEY` for the duration of a run only,
- is **dropped** on disconnect / idle timeout, and never written to logs
  (pino redaction + `scrub()` in `src/log.mjs`).

> The backend must **never** use a Claude Pro/Max subscription OAuth token to
> power the service — that violates Anthropic's commercial terms. BYOK = standard
> API billing = compliant.

## Architecture

```
browser ──WSS──> server.mjs ──> sessionManager ──> claudeRunner ──> sandbox (E2B)
                                      │                                 │
                          usage cap / idle timeout            Claude Code headless
                          permissionBridge <── approve/deny    (stream-json stdout)
```

Key modules (`src/`):

| File | Responsibility |
|------|----------------|
| `server.mjs` | fastify + ws bootstrap, `/healthz`, `/readyz`, `/ws` |
| `sessionManager.mjs` | one Session per WS; lifecycle, idle timeout, token cap, cleanup |
| `sandbox.mjs` | E2B wrapper (create/run/list/read/kill) — the only file that imports the provider |
| `claudeRunner.mjs` | builds the `claude -p … --output-format stream-json` command, splits NDJSON stdout |
| `streamMapper.mjs` | pure: stream-json event → protocol message |
| `permissionBridge.mjs` | parks permission prompts until the browser approves/denies |
| `usage.mjs` | per-session token/cost accounting + hard cap |
| `log.mjs` | pino logger with API-key redaction |

The WS message contract is shared with the frontend via
[`@me/claude-repl-protocol`](../../packages/claude-repl-protocol).

## Setup

```bash
npm install
cp .env.example .env        # set E2B_API_KEY (and E2B_TEMPLATE after building it)
```

Build the sandbox template once (Claude Code preinstalled → fast cold starts):

```bash
cd sandbox-template
e2b template build          # copy the printed template id into .env as E2B_TEMPLATE
```

## Run

```bash
npm run dev    # node --watch
npm start      # production
npm test       # node --test (streamMapper + usage)
```

Health check: `curl localhost:8787/healthz`.

## Notes

- Modes map to Claude Code permission modes: Plan→`plan`, Accept-edits→`acceptEdits`,
  Auto→`bypassPermissions` (safe only because it's inside the disposable microVM).
- A per-session token cap (`SESSION_TOKEN_CAP`) stops runaway agent loops even
  under BYOK.
- stream-json event shapes vary by Claude Code version — verify against live
  output before relying on `streamMapper.mjs` fields.
