import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

// Config lives in e2e/, but the app (package.json, vite) lives one level up.
const __dirname = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(__dirname, "..");

/**
 * House e2e config (first Playwright in this monorepo).
 * - Chromium only: deterministic replay is the goal, not cross-browser coverage.
 * - webServer builds + serves the real production bundle (vite preview, :4173).
 * - Tests drive instant replay via `/?speed=0`, so timeouts stay short.
 */
export default defineConfig({
  testDir: resolve(__dirname, "tests"),
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [["line"], ["html", { open: "never" }]],
  timeout: 15_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: "http://localhost:4173",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run build && npm run preview",
    cwd: appRoot,
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
