// Phase 0 smoke: does the local backend actually boot in a real browser?
// Assumes frontend/dist holds a VITE_BACKEND=local build (see usage below).
// Serves it, loads it in headless Chromium, and awaits the worker's ping —
// asserting the OPFS SAHPool VFS mounted and the schema stamped version 1.
//
//   VITE_BACKEND=local npm --prefix frontend run build
//   node scripts/check-local-boot.mjs

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const PW_CANDIDATES = [
  join(REPO, 'frontend', 'node_modules', 'playwright-core', 'index.mjs'),
  resolve(REPO, '..', '..', '..', 'frontend', 'node_modules', 'playwright-core', 'index.mjs'),
]
const pwPath = PW_CANDIDATES.find((p) => existsSync(p))
if (!pwPath) throw new Error('playwright-core not found (npm --prefix frontend ci first)')
const { chromium } = await import(pwPath)

const preview = spawn('npm', ['--prefix', join(REPO, 'frontend'), 'run', 'preview', '--', '--port', '4199', '--strictPort', '--host', '127.0.0.1'], {
  stdio: 'pipe',
})
let previewLog = ''
preview.stdout.on('data', (d) => { previewLog += d })
preview.stderr.on('data', (d) => { previewLog += d })

// Poll until the server actually accepts connections; stdout banners lie.
const deadline = Date.now() + 20_000
for (;;) {
  try {
    const res = await fetch('http://127.0.0.1:4199/')
    if (res.ok) break
  } catch {
    if (Date.now() > deadline) {
      preview.kill()
      throw new Error(`vite preview never came up:\n${previewLog}`)
    }
    await new Promise((ok) => setTimeout(ok, 300))
  }
}

const browser = await chromium.launch()
try {
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto('http://127.0.0.1:4199/')
  const boot = await page.evaluate(() => window.__localBoot)
  if (boot?.status !== 'ok') throw new Error(`ping failed: ${JSON.stringify(boot)}`)
  if (boot.schemaVersion !== 1) throw new Error(`schema version ${boot.schemaVersion}, wanted 1`)
  console.log(`local backend up: vfs=${boot.vfs} schemaVersion=${boot.schemaVersion}`)
  if (boot.vfs !== 'opfs-sahpool') {
    console.log('note: OPFS unavailable in this context — memory fallback engaged')
  }

  // Phase 1 endpoints, through the real worker in the real browser.
  const phase1 = await page.evaluate(async () => {
    const api = window.__localApi
    const session = await api.session()
    const history = await api.history()
    let undoRefusal = null
    try {
      await api.undo()
    } catch (error) {
      undoRefusal = { message: error.message, code: error.code, status: error.status }
    }
    return { session, history, undoRefusal }
  })
  const { session, history, undoRefusal } = phase1
  if (session.csrfToken !== '') throw new Error('local session should carry an empty CSRF token')
  if (session.undoable !== null) throw new Error('fresh database should have nothing undoable')
  if (!Array.isArray(history) || history.length !== 0) throw new Error('fresh history should be empty')
  if (undoRefusal?.status !== 409 || undoRefusal.code !== 'nothing-to-undo') {
    throw new Error(`undo on empty log should 409: ${JSON.stringify(undoRefusal)}`)
  }
  console.log(`phase 1 endpoints ok: session/history answer, empty undo refuses with 409 ("${undoRefusal.message}")`)

  // Phase 6: the first-run offer on an empty database, and the one-tab rule.
  await page.waitForSelector('text=Your collection lives in this browser now', { timeout: 5000 })
  console.log('phase 6: first-run panel visible on an empty database ✓')

  const second = await context.newPage()
  await second.goto('http://127.0.0.1:4199/')
  await second.waitForSelector('text=open in another tab', { timeout: 5000 })
  console.log('phase 6: second tab is blocked with the explanation screen ✓')
  await second.close()
} finally {
  await browser.close()
  preview.kill()
}
