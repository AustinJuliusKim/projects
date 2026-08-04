import { defineConfig } from '@playwright/test'

/**
 * The local-backend e2e config: the app served as static files, the database
 * living in the browser's OPFS. `npm run build` with VITE_BACKEND=local must
 * run first — this serves whatever is in dist, exactly like production.
 *
 * The journey spec runs as one test in one context on purpose: OPFS is
 * per-browser-context, so unlike the Flask suite (where state lives in the
 * server), spreading a flow across tests would give each step a blank
 * database.
 */
export default defineConfig({
  testDir: 'e2e-local',
  timeout: 30_000,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4317',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npx vite preview --port 4317 --strictPort --host 127.0.0.1',
    url: 'http://127.0.0.1:4317',
    reuseExistingServer: false,
  },
})
