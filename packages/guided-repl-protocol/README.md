# @guided-repl/protocol

Shared frame vocabulary, client-message trust boundary, and fixture/assertion
schema for the Guided REPL app and seeder. Plain ESM JavaScript with JSDoc
typedefs — no TypeScript build.

## Modules

- `frames.js` — `ServerMsg` frame-type constants, `isServerFrame(x)`, `SERVER_TYPES`.
- `clientMessages.js` — `parseClientMessage(raw)` (trust boundary for client input), `Mode` enum.
- `fixtureFormat.js` — fixture envelope / event / snapshot typedefs, `validateFixture`, `validateSnapshot`.
- `assertions.js` — lesson-grading assertion typedefs, `validateAssertion`.

See `FIXTURE_FORMAT.md` for the recorded-fixture schema.

## Usage

```js
import { isServerFrame, parseClientMessage, validateFixture } from "@guided-repl/protocol";
```

## Test

```
npm install
npm test
```
