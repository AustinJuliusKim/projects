[task 1] guided-repl-protocol: add {{userName}} interpolation + capture step schema — npm test 80/80 pass
[task 2] guided-repl: engine capture actions + mid-lesson assertion advance — npm test 94/94 pass
[task 3] guided-repl: thread render-time {{userName}} interpolation through the stage — npm test 95/95 pass, vite build ok
[task 4] guided-repl-lessons: l1 capture steps + {{userName}} tokenized fixtures — lessons 18/18, app 95/95 + check:lessons OK, seeder 68/68
[task 5] guided-repl: capture UI — identity store, CaptureCard, Rail + App wiring — npm test 100/100, e2e 30/30 pass
[task 6] guided-repl-api: accounts/progress backend (Fastify + pg + SAM) — npm test 16 pass (+1 gated skip), migrate --dry-run 4 migrations clean
[task 7] guided-repl: accounts wiring — api client, progress store, identity context — npm test 105/105, e2e 30/30 with NO backend
[task 8] guided-repl: CloudFront /api/* behavior + api CI job — YAML parses (3 files), api tests 16 pass, dry-run clean
[task 9] guided-repl-protocol: document capture step + {{userName}} interpolation — full matrix green (80/18/68/17/105 tests, lessons build+check, app build+check:lessons, e2e 30/30)
