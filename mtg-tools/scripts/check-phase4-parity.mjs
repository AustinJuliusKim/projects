// Phase 4 gate: the identical mutation scenario as dump-mutations-parity.py,
// replayed in the browser against the local backend with the same frozen
// clock — every read endpoint must deep-equal Flask's dump byte for byte.
//
//   EXPECTED_DIR=... node scripts/check-phase4-parity.mjs
// dist must hold a VITE_BACKEND=local build.

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deepStrictEqual } from 'node:assert'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const EXPECTED_DIR = process.env.EXPECTED_DIR
if (!EXPECTED_DIR) throw new Error('EXPECTED_DIR required')
const FROZEN = '2026-07-31T00:00:00+00:00'

const PW_CANDIDATES = [
  join(REPO, 'frontend', 'node_modules', 'playwright-core', 'index.mjs'),
  resolve(REPO, '..', '..', '..', 'frontend', 'node_modules', 'playwright-core', 'index.mjs'),
]
const pwPath = PW_CANDIDATES.find((p) => existsSync(p))
const { chromium } = await import(pwPath)

const preview = spawn('npm', ['--prefix', join(REPO, 'frontend'), 'run', 'preview', '--', '--port', '4196', '--strictPort', '--host', '127.0.0.1'], { stdio: 'pipe' })
const deadline = Date.now() + 20_000
for (;;) {
  try {
    if ((await fetch('http://127.0.0.1:4196/')).ok) break
  } catch {
    if (Date.now() > deadline) { preview.kill(); throw new Error('vite preview never came up') }
    await new Promise((ok) => setTimeout(ok, 300))
  }
}

const fixture = (name) =>
  readFileSync(join(REPO, 'tests', 'fixtures', name)).toString('base64')

const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  await page.goto('http://127.0.0.1:4196/')
  await page.evaluate(() => window.__localBoot)

  const results = await page.evaluate(
    async ([frozen, sampleB64, sample2B64, sealedB64]) => {
      const api = window.__localApi
      const rpc = window.__localRpc
      await rpc('debugSetClock', { iso: frozen })
      const toFile = (b64, name) =>
        new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], name)

      // -- the scenario (mirrors dump-mutations-parity.py exactly) ------
      for (const [b64, name] of [[sampleB64, 'sample.csv'], [sample2B64, 'sample2.csv']]) {
        const { importId } = await api.upload(toFile(b64, name))
        await api.commitImport(importId)
      }

      const sealedImport = (await api.upload(toFile(sealedB64, 'sealed_sample.csv'))).importId
      const detail = await api.importDetail(sealedImport)
      for (const issue of detail.issues) {
        if (!issue.blocking) continue
        for (const row of issue.rows) {
          await api.resolveRow(sealedImport, row.id, { skip: true })
        }
      }
      await api.commitImport(sealedImport)

      await api.bulkApply({ kind: 'holding', ids: [1, 2] }, 'verdict', 'sell')
      await api.bulkApply({ kind: 'holding', ids: [1, 2, 3] }, 'adjust_price', '5')
      await api.bulkApply({ kind: 'holding', ids: [4] }, 'price', '9.99')
      await api.bulkApply({ kind: 'sealed', selectAll: true, filters: {} }, 'cost_basis', '30.00')
      await api.bulkApply({ kind: 'sealed', ids: [1] }, 'verdict', 'sell')

      const sale1 = (await api.listForSale({ kind: 'holding', id: 1 })).saleId
      await api.recordSale(sale1, { sold: '100.00', fees: '8.00', shipping: '2.00' })
      const sale2 = (await api.listForSale({ kind: 'holding', id: 2 })).saleId
      await api.cancelSale(sale2)
      const sale3 = (await api.listForSale({ kind: 'sealed', id: 1, quantity: 1 })).saleId
      await api.recordSale(sale3, { sold: '45.00', fees: '4.50' })

      await api.undo()

      const download = async (name, opts) => {
        const { filename, blob } = await api.download(name, opts)
        const bytes = new Uint8Array(await blob.arrayBuffer())
        let binary = ''
        for (const b of bytes) binary += String.fromCharCode(b)
        return { filename, b64: btoa(binary) }
      }
      const downloads = {
        'manifest.json.txt': { json: await api.exportManifest() },
        'ledger.csv': await download('ledger'),
        'buylist.csv': await download('buylist'),
        'buylist-ck.csv': await download('buylist-ck'),
        'template.csv': await download('sealed-template'),
        bundle: await download('bundle'),
      }
      for (const table of ['holdings', 'sealed', 'verdicts', 'sales', 'price_history', 'imports', 'operations']) {
        downloads[`table-${table}.csv`] = await download('table', { table })
      }

      return {
        collection: await api.collection({}),
        sealed: await api.sealed({}),
        insights: await api.insights({}),
        queue: await api.salesQueue(),
        sales: await api.sales(),
        'sales-summary': await api.salesSummary(),
        history: await api.history(),
        downloads,
      }
    },
    [FROZEN, fixture('sample.csv'), fixture('sample2.csv'), fixture('sealed_sample.csv')],
  )

  const { downloads, ...endpoints } = results
  for (const name of Object.keys(endpoints)) {
    const expected = JSON.parse(readFileSync(join(EXPECTED_DIR, `${name}.json`), 'utf-8'))
    deepStrictEqual(endpoints[name], expected, `${name} diverges from Flask`)
    console.log(`${name}: deep-equal with Flask ✓`)
  }

  // Phase-5 exports: bytes must match Flask's, file by file.
  deepStrictEqual(
    downloads['manifest.json.txt'].json,
    JSON.parse(readFileSync(join(EXPECTED_DIR, 'manifest.json.txt'), 'utf-8')),
    'manifest diverges',
  )
  console.log('manifest: deep-equal with Flask ✓')
  for (const name of Object.keys(downloads)) {
    if (name === 'manifest.json.txt' || name === 'bundle') continue
    const actual = Buffer.from(downloads[name].b64, 'base64')
    const expected = readFileSync(join(EXPECTED_DIR, name))
    deepStrictEqual(actual, expected, `${name} bytes diverge from Flask`)
  }
  console.log('11 CSV exports: byte-identical with Flask ✓')

  // The bundle: same entry names; CSV entries byte-identical; the sqlite image
  // compared by header (page layout legitimately differs between builds).
  const { unzipSync } = await import(
    join(REPO, 'frontend', 'node_modules', 'fflate', 'esm', 'browser.js')
  )
  const entries = unzipSync(Buffer.from(downloads.bundle.b64, 'base64'))
  const expectedNames = JSON.parse(readFileSync(join(EXPECTED_DIR, 'bundle', '_names.json'), 'utf-8'))
  // Flask's parity run sits on :memory:, so its bundle legitimately lacks the
  // database image; the local backend always has one. Compare the rest.
  const dropSqlite = (names) => names.filter((n) => n !== 'collection.sqlite')
  deepStrictEqual(dropSqlite(Object.keys(entries)).sort(), dropSqlite(expectedNames), 'bundle entry names diverge')
  if (entries['collection.sqlite']) {
    const header = Buffer.from(entries['collection.sqlite'].slice(0, 15)).toString('latin1')
    if (header !== 'SQLite format 3') throw new Error('bundle sqlite image is not a database')
  }
  for (const entry of dropSqlite(Object.keys(entries))) {
    const expectedBytes = readFileSync(join(EXPECTED_DIR, 'bundle', entry.replaceAll('/', '__')))
    deepStrictEqual(Buffer.from(entries[entry]), expectedBytes, `bundle ${entry} diverges`)
  }
  console.log(`bundle: ${Object.keys(entries).length} entries match Flask ✓ (sqlite image header-checked)`)
  console.log(
    `scenario parity complete — history has ${endpoints.history.length} operations, ` +
      `net ${endpoints['sales-summary'].net}`,
  )
} finally {
  await browser.close()
  preview.kill()
}
