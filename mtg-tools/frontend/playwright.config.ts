import { defineConfig, devices } from '@playwright/test'

/**
 * End-to-end tests against a real Flask server serving the real build.
 *
 * This suite exists because of a specific, repeated failure: **the unit suites
 * were green while the app was broken.** Twice.
 *
 * - 53 tests passed while the server 500'd on every page. A Flask test client
 *   runs in the *calling* thread, so it structurally could not hit the SQLite
 *   thread-affinity bug that a real request, handled off the main thread, hits
 *   immediately.
 * - 106 tests passed while a sold card vanished from the tax ledger.
 *
 * Both were found by starting the server and clicking. That is the gap this
 * fills, so the tests here are deliberately *journeys* — import a file, commit
 * it, look at the screen it landed on — rather than re-assertions of the API
 * contract, which `tests_webapp/test_api.py` already covers far more cheaply.
 */

const PORT = Number(process.env.E2E_PORT ?? 8790)

// Paths below are relative to the repo root, because that is the server's cwd.
const DB = process.env.E2E_DB ?? 'frontend/e2e/.tmp/e2e.db'

/**
 * The venv interpreter locally; a plain `python` in CI, which installs into the
 * job's own environment. Overridable so neither has to be special-cased.
 */
const PYTHON = process.env.E2E_PYTHON ?? '.venv/bin/python'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,

  // One server, one SQLite file, therefore one worker. Parallel workers would
  // race each other's mutations through a single database and the failures
  // would look like app bugs rather than test-harness bugs.
  workers: 1,

  // A test that only passes on the second try is a flaky test, and a flaky E2E
  // suite gets ignored, at which point it is worse than not having one. Retries
  // are for CI's noisier machines only, and the report says when one was used.
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,

  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: {
    // Three things this command has to get right:
    //
    // 1. `rm -f` first. The database persists between runs otherwise, and
    //    yesterday's rows would drift the assertions. Doing it in the launch
    //    command rather than a globalSetup hook keeps it independent of
    //    Playwright's hook ordering.
    // 2. A scratch path under `e2e/.tmp/`, never the default
    //    `~/.local/share/mtg-tools/collection.db`. These tests do destructive
    //    things — bulk deletes, undo — and they must not do them to a real
    //    collection.
    // 3. `python -m binders serve`, the actual entry point people run, so the
    //    loopback guard and the dist-serving path are both exercised as
    //    shipped.
    command: `mkdir -p frontend/e2e/.tmp && rm -f ${DB} && ${PYTHON} -m binders serve --db ${DB} --port ${PORT}`,
    cwd: '..',
    url: `http://127.0.0.1:${PORT}/api/session`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
