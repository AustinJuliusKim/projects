/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    // `npm run dev` serves the UI on 5173 and proxies the API to Flask, so the
    // browser sees one origin and the session cookie behaves as in production.
    proxy: { '/api': { target: 'http://127.0.0.1:8765', changeOrigin: true } },
    // The local backend imports `webapp/schema.sql?raw` from the repo root —
    // one schema, two runtimes, no copy to drift.
    fs: { allow: ['..'] },
  },
  build: { outDir: 'dist', emptyOutDir: true },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test-setup.ts',
    // Scoped to `src`, because Vitest's default glob also sweeps up
    // `e2e/*.spec.ts` — and Playwright specs loaded by Vitest fail with
    // "Playwright Test did not expect test.describe() to be called here."
    // The two runners share a filename convention and must not share files.
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
})
