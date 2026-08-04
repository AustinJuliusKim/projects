// Phase 3 gate: the TS importer, fed the same CSV bytes as webapp.importer,
// must stage identical rows (parsed fields, issue codes, states) and — after
// committing the singles — serve an identical /api/collection.
//
//   .venv/bin/python scripts/dump-import-parity.py OUT files...   (repo root)
//   EXPECTED_DIR=OUT CSV_DIR=... node scripts/check-phase3-parity.mjs f1 f2...
// dist must hold a VITE_BACKEND=local build.

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deepStrictEqual } from 'node:assert'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const EXPECTED_DIR = process.env.EXPECTED_DIR
const files = process.argv.slice(2)
if (!EXPECTED_DIR || !files.length) throw new Error('EXPECTED_DIR and file args required')

const PW_CANDIDATES = [
  join(REPO, 'frontend', 'node_modules', 'playwright-core', 'index.mjs'),
  resolve(REPO, '..', '..', '..', 'frontend', 'node_modules', 'playwright-core', 'index.mjs'),
]
const pwPath = PW_CANDIDATES.find((p) => existsSync(p))
if (!pwPath) throw new Error('playwright-core not found')
const { chromium } = await import(pwPath)

const preview = spawn('npm', ['--prefix', join(REPO, 'frontend'), 'run', 'preview', '--', '--port', '4197', '--strictPort', '--host', '127.0.0.1'], { stdio: 'pipe' })
const deadline = Date.now() + 20_000
for (;;) {
  try {
    if ((await fetch('http://127.0.0.1:4197/')).ok) break
  } catch {
    if (Date.now() > deadline) { preview.kill(); throw new Error('vite preview never came up') }
    await new Promise((ok) => setTimeout(ok, 300))
  }
}

const expected = JSON.parse(readFileSync(join(EXPECTED_DIR, 'staged.json'), 'utf-8'))
const expectedCollection = JSON.parse(
  readFileSync(join(EXPECTED_DIR, 'collection-after.json'), 'utf-8'),
)

const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  await page.goto('http://127.0.0.1:4197/')
  const boot = await page.evaluate(() => window.__localBoot)
  if (boot?.status !== 'ok') throw new Error(`boot failed: ${JSON.stringify(boot)}`)

  for (const path of files) {
    const name = basename(path)
    const b64 = readFileSync(path).toString('base64')
    const staged = await page.evaluate(
      async ([data, fileName]) => {
        const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
        const { importId, kind } = await window.__localApi.upload(
          new File([bytes], fileName),
        )
        const rows = await window.__localRpc('debugStagedRows', { id: importId })
        if (kind === 'singles') await window.__localApi.commitImport(importId)
        return { kind, rows }
      },
      [b64, name],
    )
    deepStrictEqual(staged, expected[name], `${name}: staged rows diverge from Python`)
    console.log(`${name}: ${staged.rows.length} staged rows deep-equal with Python ✓ (${staged.kind})`)
  }

  const collection = await page.evaluate(() => window.__localApi.collection({}))
  deepStrictEqual(collection, expectedCollection, 'post-commit collection diverges')
  console.log(
    `post-commit collection deep-equal with Flask ✓ ` +
      `(${collection.grandTotals.rows} rows, ${collection.grandTotals.value})`,
  )
} finally {
  await browser.close()
  preview.kill()
}
