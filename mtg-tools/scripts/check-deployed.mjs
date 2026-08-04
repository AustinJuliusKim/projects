// Production smoke: drive the deployed SPA like a first-time user.
//   DEPLOY_URL=https://mtg-tools.pages.dev node scripts/check-deployed.mjs
//
// Asserts: OPFS mounts, the first-run panel shows, a fixture CSV imports and
// commits through the API, totals are right, and the data survives a reload.
// All state lands in this headless browser's own storage and dies with it —
// nothing touches any real user's data.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const URL_BASE = process.env.DEPLOY_URL ?? 'https://mtg-tools.pages.dev'

const PW_CANDIDATES = [
  join(REPO, 'frontend', 'node_modules', 'playwright-core', 'index.mjs'),
  resolve(REPO, '..', '..', '..', 'frontend', 'node_modules', 'playwright-core', 'index.mjs'),
]
const pwPath = PW_CANDIDATES.find((p) => existsSync(p))
const { chromium } = await import(pwPath)

const csv = readFileSync(join(REPO, 'tests', 'fixtures', 'sample.csv')).toString('base64')

const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  await page.goto(URL_BASE)
  const boot = await page.evaluate(() => window.__localBoot)
  if (boot?.vfs !== 'opfs-sahpool' || boot.schemaVersion !== 1) {
    throw new Error(`bad boot: ${JSON.stringify(boot)}`)
  }
  console.log(`deployed app up at ${URL_BASE}: vfs=${boot.vfs} schemaVersion=${boot.schemaVersion}`)

  await page.waitForSelector('text=Your collection lives in this browser now', { timeout: 8000 })
  console.log('first-run panel shows ✓')

  const totals = await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const { importId } = await window.__localApi.upload(new File([bytes], 'sample.csv'))
    await window.__localApi.commitImport(importId)
    return (await window.__localApi.collection({})).grandTotals
  }, csv)
  if (totals.rows < 1 || totals.valueCents <= 0) throw new Error(`odd totals: ${JSON.stringify(totals)}`)
  console.log(`imported fixture: ${totals.rows} rows, ${totals.value} ✓`)

  await page.reload()
  await page.evaluate(() => window.__localBoot)
  const after = await page.evaluate(() => window.__localApi.collection({}))
  if (after.grandTotals.valueCents !== totals.valueCents) throw new Error('data lost on reload')
  console.log(`persistence across reload ✓ (${after.grandTotals.value})`)
} finally {
  await browser.close()
}
console.log('deployed smoke: all green')
