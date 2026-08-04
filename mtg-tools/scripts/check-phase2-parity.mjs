// Phase 2 gate: the local backend, fed the same SQLite file as Flask, must
// return deep-equal JSON for every read endpoint ported so far.
//
// Usage (run_check below wires it):
//   LOCAL_DB=/path/copy.db EXPECTED_DIR=/path node scripts/check-phase2-parity.mjs
// where EXPECTED_DIR holds collection.json / sealed.json / insights.json /
// sealed-insights.json captured from Flask serving the same file. The dist
// must be a VITE_BACKEND=local build.

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deepStrictEqual } from 'node:assert'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DB_FILE = process.env.LOCAL_DB
const EXPECTED_DIR = process.env.EXPECTED_DIR
if (!DB_FILE || !EXPECTED_DIR) throw new Error('LOCAL_DB and EXPECTED_DIR are required')

const PW_CANDIDATES = [
  join(REPO, 'frontend', 'node_modules', 'playwright-core', 'index.mjs'),
  resolve(REPO, '..', '..', '..', 'frontend', 'node_modules', 'playwright-core', 'index.mjs'),
]
const pwPath = PW_CANDIDATES.find((p) => existsSync(p))
if (!pwPath) throw new Error('playwright-core not found')
const { chromium } = await import(pwPath)

const preview = spawn('npm', ['--prefix', join(REPO, 'frontend'), 'run', 'preview', '--', '--port', '4198', '--strictPort', '--host', '127.0.0.1'], { stdio: 'pipe' })
const deadline = Date.now() + 20_000
for (;;) {
  try {
    const res = await fetch('http://127.0.0.1:4198/')
    if (res.ok) break
  } catch {
    if (Date.now() > deadline) { preview.kill(); throw new Error('vite preview never came up') }
    await new Promise((ok) => setTimeout(ok, 300))
  }
}

const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  await page.goto('http://127.0.0.1:4198/')
  const boot = await page.evaluate(() => window.__localBoot)
  if (boot?.vfs !== 'opfs-sahpool') throw new Error(`need OPFS, got ${JSON.stringify(boot)}`)

  const b64 = readFileSync(DB_FILE).toString('base64')
  const imported = await page.evaluate(async (data) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
    return window.__localImportDb(new File([bytes], 'collection.db'))
  }, b64)
  console.log(`imported real database: ${imported.holdings} holdings, ${imported.sealed} sealed`)

  const fetchAll = () =>
    page.evaluate(async () => ({
      collection: await window.__localApi.collection({}),
      sealed: await window.__localApi.sealed({}),
      insights: await window.__localApi.insights({}),
      sealedInsights: await window.__localApi.sealedInsights({}),
    }))

  const expected = {
    collection: JSON.parse(readFileSync(join(EXPECTED_DIR, 'collection.json'), 'utf-8')),
    sealed: JSON.parse(readFileSync(join(EXPECTED_DIR, 'sealed.json'), 'utf-8')),
    insights: JSON.parse(readFileSync(join(EXPECTED_DIR, 'insights.json'), 'utf-8')),
    sealedInsights: JSON.parse(readFileSync(join(EXPECTED_DIR, 'sealed-insights.json'), 'utf-8')),
  }

  const actual = await fetchAll()
  for (const key of Object.keys(expected)) {
    deepStrictEqual(actual[key], expected[key], `${key} diverges from Flask`)
    console.log(`${key}: deep-equal with Flask ✓`)
  }

  // Persistence: a reload must find the imported data in OPFS, not a blank db.
  await page.reload()
  await page.evaluate(() => window.__localBoot)
  const after = await fetchAll()
  deepStrictEqual(after.collection.grandTotals, expected.collection.grandTotals, 'data lost on reload')
  console.log(`persistence: survives reload ✓ (grand total ${after.collection.grandTotals.value})`)
} finally {
  await browser.close()
  preview.kill()
}
