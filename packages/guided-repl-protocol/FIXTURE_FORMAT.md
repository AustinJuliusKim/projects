# Fixture Format

A **fixture** is a recorded lesson-branch run: a sequence of server frames
(plus optional client-await markers) with replay timing, enough to drive the
app's fixture player without a live agent.

## Envelope

```ts
{
  fixtureVersion: 1,
  claudeCodeVersion: string,   // e.g. "2.1.198"
  lessonId: string,
  branchId: string,
  recordedAt: string,          // ISO 8601
  seedSnapshotId: string,      // matches a SnapshotManifest.snapshotId
  permissionMode: string,      // e.g. "acceptEdits" | "plan"
  expectedPrompt: string,      // exact-match seam for the fixture transport
  events: FixtureEvent[],
  assertion: Assertion,        // see below; exactly one per fixture
}
```

## Events

Each entry in `events` is either a **frame event** or an **awaitClient
marker**:

- Frame event: `{ frame, delayMs, origDelayMs?, annotation? }` — `frame` must
  pass `isServerFrame` (see `frames.js`). `delayMs` is the (possibly
  compressed) replay delay before emitting the frame; `origDelayMs` is the
  original recorded delay, kept for future re-pacing. `annotation`, if
  present, is `{ title: string, body: string }` — a hand-authored callout
  shown alongside this frame (used by step-through lessons like L2; see
  `annotationMerge.js` in the seeder).
- `awaitClient` marker: `{ awaitClient: "permission", choices: ["approve", "deny"] }`
  — the player pauses here until the client sends a matching decision.

A lesson with `"playback": "step"` (see the `lessons.json` schema below)
pauses after each annotated frame instead of auto-advancing; the client
sends a `{ type: "next" }` message (see `clientMessages.js`) to resume.

## Snapshot manifest

Seed and output workspace state, referenced by `seedSnapshotId`:

```ts
{
  snapshotId: string,
  files: [{ path: string, content: string }],  // workspace-relative, no leading "/"
}
```

## Lesson manifest (`lessons.json`)

Not a protocol-package typedef (it's app-owned, loaded from
`public/fixtures/<version>/lessons.json`), but documented here since it's
the thing that ties fixtures, snapshots, and assertions together per lesson:

```ts
{
  lessons: [{
    lessonId: string,
    title: string,
    locked?: boolean,          // stubbed lessons with no content yet
    playback?: "step",         // pause-after-each-annotated-frame mode (see Events above)
    branches: string[],
    seedSnapshotId: string,    // default seed for every branch
    promptChoices: { task: string[], subject: string[], constraint: string[] },
    branchConfig: {
      [branchId]: {
        expectedPrompt: string,
        permissionMode: string,
        fixture: string,           // path under public/fixtures/<version>/
        seedSnapshotId?: string,   // per-branch override of the lesson default (e.g. L7's with/without CLAUDE.md)
        model?: string,            // per-branch model override, echoed onto usage.payload.model (e.g. L8's haiku branch)
      },
    },
    assertion: Assertion,      // exactly one per lesson, shared across its branches
  }],
}
```

## Assertions

Exactly one of five declarative types (see `assertions.js`):

- `{ type: "file-contains", path, match }`
- `{ type: "file-exists", path }`
- `{ type: "terminal-matches", match }`
- `{ type: "file-equals", path, content }`
- `{ type: "quiz", question, choices: string[], correctIndex }` — graded
  client-side against the learner's chosen index; `choices` needs at least
  2 entries and `correctIndex` must be in range.

## Example

```json
{
  "fixtureVersion": 1,
  "claudeCodeVersion": "2.1.198",
  "lessonId": "l1",
  "branchId": "plan-mode",
  "recordedAt": "2026-07-02T00:00:00Z",
  "seedSnapshotId": "l1-input",
  "permissionMode": "plan",
  "expectedPrompt": "make a personal landing page for my photography, single HTML file, inline CSS",
  "events": [
    { "frame": { "type": "session_ready" }, "delayMs": 0 },
    { "frame": { "type": "text", "payload": { "delta": "I'll create a landing page." } }, "delayMs": 120, "origDelayMs": 480 },
    { "awaitClient": "permission", "choices": ["approve", "deny"] },
    { "frame": { "type": "tool_use", "payload": { "id": "t1", "tool": "Write", "input": { "path": "index.html" } } }, "delayMs": 40 },
    { "frame": { "type": "done" }, "delayMs": 10 }
  ],
  "assertion": { "type": "file-contains", "path": "index.html", "match": "<h1>" }
}
```

Snapshot manifest referenced above:

```json
{
  "snapshotId": "l1-input",
  "files": [{ "path": "README.md", "content": "# Starter\n" }]
}
```

## Deviations from the architecture doc

The architecture doc's worked example (`Claude REPL Architecture.md` §3)
shows a flat frame shape: `{ "type": "text", "delta": "…" }`. The shipped
schema nests payload-bearing fields under `payload` instead: `{ "type":
"text", "payload": { "delta": "…" } }` (see `frames.js`). This is a
deliberate, self-consistent deviation — every payload-bearing frame type
(`text`, `tool_use`, `tool_result`, `permission_request`, `usage`,
`file_tree`, `file_content`, `error`) follows the same `{type, payload}`
shape, which keeps `isServerFrame`'s per-type payload validation and the
reducer's dispatch uniform. `session_ready` and `done` remain payload-less.

## v1.1 additive amendments

`fixtureVersion` is still `1` — these are backwards-compatible additions
made while building lessons L2-L8, all optional/additive (no existing
fixture needed to change shape):

- `assertions.js`: added the `quiz` assertion type.
- `frames.js`: added optional `model` to `UsagePayload`, stamped from the
  live `system/init` stream rather than hardcoded (see `modelStamp.js`).
- `fixtureFormat.js`: added optional `annotation` (`{title, body}`) to
  `FrameEvent`.
- `clientMessages.js`: added the `{ type: "next" }` client message for
  step-playback advance.
- `lessons.json` (app-owned, not a protocol typedef): added `playback` and
  per-branch `seedSnapshotId`/`model` overrides in `branchConfig`.

## v1.2 additive amendments (Lesson Engine Spec)

`fixtureVersion` is still `1` — additive changes made for the Lesson Engine
migration (YAML-authored lessons, TerminalDrill support):

- `fixtureFormat.js`: added optional envelope `kind`
  (`"claudeStream" | "shellTranscript"`; absent means `claudeStream`).
  `shellTranscript` fixtures replay scripted shell sessions (git/CLI drills)
  through the same player and terminal pane; for that kind,
  `permissionMode`, `expectedPrompt`, and `assertion` are optional (drills
  grade via a `drillPassed` lesson step instead).
- `fixtureFormat.js`: added optional per-event `skippable` boolean
  (pacing metadata; dormant in v1 playback).
- `frames.js`: added the `tty_chunk` frame (`{payload: {data}}`) — raw
  terminal output chunks for `shellTranscript` fixtures.
- `lessonSchema.js` (new): Zod schema for authored lesson documents
  (`Lesson`/`Step`/`AssertionRule`/`SemanticAnchor`) — the single source of
  truth for the compiled `lessons.json` manifest, which replaces the
  app-owned shape described above (see `@guided-repl/lessons`).
- `anchors.js` (new): `resolveAnchor(anchor, events)` — semantic-anchor
  resolution shared by the lessons compiler, CI checks, and the app.
- `cmdMatch.js` (new): `matchCommand(matcher, input)` for TerminalDrill
  expectations.
