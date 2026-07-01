# @me/claude-repl-protocol

Shared WebSocket message contract for the `claude-repl` playground. Both the
frontend (`apps/claude-repl`) and the backend (`services/claude-repl-backend`)
depend on this so the two sides can't drift apart.

Consume it via a `file:` dependency (per the monorepo conventions):

```json
{ "dependencies": { "@me/claude-repl-protocol": "file:../../packages/claude-repl-protocol" } }
```

## Exports

- `ClientMsg` — message types the browser sends (`setKey`, `prompt`, `setMode`, `approve`, `deny`, `interrupt`).
- `ServerMsg` — message types the backend sends (`session_ready`, `text`, `tool_use`, `tool_result`, `permission_request`, `usage`, `file_tree`, `file_content`, `done`, `error`).
- `Mode` — permission modes mapped to Claude Code's `--permission-mode` (`plan`, `acceptEdits`, `bypassPermissions`).
- `parseClientMessage(raw)` — strict parse/validate for inbound browser frames (the backend's trust boundary).
- `serverMessage(type, payload)` — build a validated server→client JSON frame.
- `isMode(value)` — guard for permission modes.

## Test

```bash
npm test
```
