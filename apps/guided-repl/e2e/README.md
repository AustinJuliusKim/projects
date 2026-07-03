# e2e (Playwright)

First Playwright suite in this monorepo — the choices here are the house pattern.

## Run

```bash
npm run e2e                 # build + preview + run all specs (Chromium)
npm run e2e -- --ui         # interactive UI mode
npm run e2e -- --headed     # watch a real browser
npx playwright show-report  # open the HTML report after a failure
```

`npm run e2e` runs `playwright test --config e2e/playwright.config.js`. The
`webServer` block does `npm run build && npm run preview` (vite preview on
:4173) and, locally, reuses an already-running preview (`reuseExistingServer`).

## The `speed=0` convention

Specs open the lesson at `/?speed=0` (via `gotoLesson`). The fixture player
multiplies every frame delay by `speedMultiplier`, so `0` replays the whole
recording synchronously — no real-time pacing, no flake. Never assert on
wall-clock timing; rely on Playwright auto-waiting for the resulting DOM.

## Helpers (`e2e/helpers.js`)

Page-object-ish functions keyed off `data-testid`s: `gotoLesson`,
`pickChoices(page, {task, subject, constraint})`, `promptPreview`,
`runPrompt`, `waitForDone` (grade-banner), `fileTreeEntry` / `openFile`.
Compose these; keep raw selectors out of specs.

## Config rationale (5 lines)

1. Chromium-only — replay determinism is the goal, not cross-browser matrix.
2. `webServer` builds + serves the real prod bundle, so specs test what ships.
3. Short timeouts (test 15s / expect 5s) because `speed=0` makes replay instant.
4. `retries` 0 local / 1 CI, `trace: on-first-retry` — cheap locally, debuggable in CI.
5. `reporter` line + html (html opened only on failure).
