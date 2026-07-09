# @guided-repl/lessons

Authored lesson content for the Guided REPL, per the Lesson Engine Spec:
YAML sources compiled to a canonical JSON manifest validated against the
Zod schemas in `@guided-repl/protocol` (`lessonSchema.js`).

## Layout

- `lessons/*.yaml` — the source of truth. One file per lesson. `l1.yaml` is
  the hand-authored template; `l2–l8` were converted from the legacy
  `lessons.json` by `src/convertLegacy.js` (kept for provenance) and are
  hand-polishable here.
- `src/compile.js` — YAML → `dist/lessons.json`. Validates every lesson,
  resolves fixture/snapshot refs against
  `apps/guided-repl/public/fixtures/v1`, resolves annotation anchors
  (stamping `resolvedEventIndex`), and enforces suggestion↔branch coverage.
  Broken refs fail the build, not learners.
- `dist/` — build output (gitignored).

## Workflow

After editing any `lessons/*.yaml`:

```
npm run build
cp dist/lessons.json ../../apps/guided-repl/public/fixtures/v1/lessons.json
```

The committed app manifest is generated-but-committed; CI runs
`npm run check` (compile + byte-diff) and fails on drift.

## Invariants the compiler enforces

- Every fixture/snapshot referenced exists and validates.
- Fixture envelope fields (lessonId, branchId, expectedPrompt,
  permissionMode, seedSnapshotId) match the lesson's run-step branches.
- Every promptBuilder suggestion resolves to exactly one run branch
  (explicit `branchId` required when prompt text is shared across branches);
  every branch is reachable by at least one suggestion; slot cross-products
  resolve when slots are present.
- Annotation anchors resolve against the referenced fixture stream.
- `terminalDrill.transcript` references a `kind: shellTranscript` fixture;
  run branches reference `claudeStream` fixtures.
