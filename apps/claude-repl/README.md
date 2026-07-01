# claude-repl

An interactive browser playground that teaches people how to use **Claude Code**.
A 50/50 layout: a CLI-like terminal on the left where you type prompts and pick a
mode (Plan / Accept-edits / Auto), and a live workspace on the right showing the
resulting work — files being created and edited, diffs, and tool output.

Claude Code runs **headless inside an isolated sandbox** (orchestrated by
[`claude-repl-backend`](../../services/claude-repl-backend)); this app is the
React+Vite frontend.

## Bring your own key (BYOK)

You run the playground on your **own Anthropic API key**. It's held in the browser
tab only, sent over an encrypted connection to power your prompts, and never stored
server-side. (We never use Claude Pro/Max subscription logins — only standard API
keys, which is the ToS-compliant path for a hosted app.)

## Architecture

```
App.jsx ── useSession (WebSocket) ── reducer (server event stream → UI state)
  ├── Terminal + ModeSelector   (left: prompt log)
  ├── WorkspacePane             (right: FileTree + FileViewer/DiffView)
  ├── PermissionModal           (approve/deny gated actions)
  ├── TokenUsage                (live token + cost meter)
  └── ApiKeyModal               (first-run BYOK gate)
```

State is a single `useReducer` over the server→client message stream (no Redux).
The WS message contract is shared with the backend via
[`@me/claude-repl-protocol`](../../packages/claude-repl-protocol).

Libraries: React 18 + Vite 5, CodeMirror 6 (`@uiw/react-codemirror`) for read-only
file viewing, `react-diff-viewer-continued` for edit diffs.

## Develop

```bash
npm install
cp .env.example .env          # VITE_BACKEND_WS_URL (dev default proxies to :8787)
npm run dev
```

Run the backend ([`services/claude-repl-backend`](../../services/claude-repl-backend))
alongside it. In dev, Vite proxies `/ws` to `localhost:8787`.

```bash
npm run build                 # production bundle → dist/
npm run preview
```

## Status

MVP (open playground). Guided lessons are a planned Phase 2 layer on top of the same
event stream.
