# @guided-repl/protocol

Shared frame vocabulary, client-message trust boundary, and fixture/assertion
schema for the Guided REPL app and seeder. Plain ESM JavaScript with JSDoc
typedefs — no TypeScript build.

## Modules

- `frames.js` — `ServerMsg` frame-type constants, `isServerFrame(x)`, `SERVER_TYPES`.
- `clientMessages.js` — `parseClientMessage(raw)` (trust boundary for client input), `Mode` enum.
- `fixtureFormat.js` — fixture envelope / event / snapshot typedefs, `validateFixture`, `validateSnapshot`.
- `assertions.js` — lesson-grading assertion typedefs, `validateAssertion`.
- `lessonSchema.js` — Zod lesson/step/manifest schemas (incl. the `capture`
  step: `fields: ["name"|"email"]`, `purposeMd`, `optional`, `consent`).
- `interpolate.js` — `{{userName}}` interpolation + name sanitization (below).

See `FIXTURE_FORMAT.md` for the recorded-fixture schema.

## `{{userName}}` interpolation

Fixtures/snapshots carry the literal `{{userName}}` token (the seeder's
normalizer emits it in place of the recording author's name). The app
substitutes at render time only — reducer, virtualFs, grading, and prompt
matching all operate on the raw token, so display changes but branching
never does.

Hard security rules (the value renders into a live HTML preview):

- `sanitizeUserName(raw)` — trim, collapse whitespace, truncate to
  `MAX_USER_NAME_LENGTH` (30), then a charset allowlist (`USER_NAME_RE`:
  letters/marks/digits, spaces, `. ' -`); returns the sanitized string or
  null. Runs at capture in the app AND server-side on `/api/leads` — the
  same function in both places.
- `interpolateUserName(text, name, {html})` — replaces every token with the
  name or `DEFAULT_USER_NAME` ("Demo User", the skip-path default).
  `html: true` routes the value through `escapeHtml` first; use it for every
  markup sink (preview `srcDoc`, files inlined by `rewriteRefs`). Text sinks
  rendered through React use the default text mode.

## Usage

```js
import { isServerFrame, parseClientMessage, validateFixture } from "@guided-repl/protocol";
```

## Test

```
npm install
npm test
```
