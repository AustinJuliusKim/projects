# PROGRESS

- Task 1: scaffold package + foundry config dir + Zod config loader — 9/9 tests green, committed 3d9a2de
- Task 2: AgentClient (lazy SDK, injectable queryImpl) + pricing — 5/5 tests green, committed c054b4d
- Task 3: lesson index + overlap gate (real l1-l8 corpus) — 6/6 tests green, committed 2db8575
- Task 4: fetchers + scout + cursors (recorded fixtures, per-source isolation, bench cards) — 12/12 tests green, committed 7cd7736
- Task 5: author stage (prompt pack byte-stable, l1 exemplar verbatim, retry-on-invalid) — 9/9 tests green, committed 1aa8a1d
- Task 6: lint stage (caps, draft constraints, llm advisory) — 7/7 tests green, committed 9a51c18
- Task 7: seeder seedLib extraction + docRecipe (fake-runner NDJSON round-trip) — seeder suite green (76 tests at commit time; 81 after Task 8 added e2bRunner tests), committed 03a68dc
- Task 8: E2B runner (lazy e2b import, fake sandbox tests, in-sandbox getVersion) — 81/81 seeder tests green, committed 35a9939
- Task 9: compile --lessons-dir + checkLessons chain generalization (roots = self-contained <id>-input) — lessons 18/18 + build + check + app check:lessons green, committed f70cff4
- Task 10: validateDraft (Zod→lint→seed→staging compile→redaction) + draft/radar bundles + queue — 10/10 tests green, committed 211c3aa
- Task 11: CLI wiring + e2e dry run (both modes, budget abort, gate rejection in radar) — full foundry suite 67/67 green, committed f33a1b0
- Task 12: bench harness (3 author briefs + 1 labeled scout snapshot, pairwise judge, scorecards) — foundry suite 73/73 green, committed 436fe17
- Task 13: foundry.yml (cron==settings, keyless guard, draft PRs only) + guided-repl.yml foundry job + workflowGuard — 82/82 foundry tests green, committed 6beaed7
- Task 14: README/runbook + final sweep — full matrix green (protocol 80, lessons 18+build+check, seeder 81, foundry 82, app check:lessons OK), committed ed56acb
- Supervisor cycle 4 fix: radar spend breakdown (scout vs author vs total) — 82/82 green, committed 66944a2
- Acceptance fixes: bench-results porcelain check + workflowGuard uses-allowlist & gh-api-merge rejection — workflowGuard 10/10, foundry suite 83/83, committed 9995668
