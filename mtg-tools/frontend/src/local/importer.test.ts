// @vitest-environment node
/**
 * The import lifecycle, ported intent from tests_webapp/test_core.py's
 * TestDetection/TestStaging/TestCommit/TestUndo — run against the repo's real
 * fixture CSVs (via ?raw) so the TS importer chews the same bytes the Python
 * suite chews.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import SCHEMA from '../../../webapp/schema.sql?raw'
import SAMPLE from '../../../tests/fixtures/sample.csv?raw'
import SEALED_SAMPLE from '../../../tests/fixtures/sealed_sample.csv?raw'
import { initSchema, wrapDb, type Database } from './db'
import { ApiFailure } from './errors'
import { makeRoutes } from './endpoints'
import { detectKind } from './importer'

type Db = Database & { close(): void }
type Routes = ReturnType<typeof makeRoutes>

async function openDb(): Promise<Db> {
  const { default: sqlite3InitModule } = await import('@sqlite.org/sqlite-wasm')
  const sqlite3 = await sqlite3InitModule()
  const db = wrapDb(new sqlite3.oo1.DB(':memory:') as never) as Db
  initSchema(db, SCHEMA)
  return db
}

function routesFor(db: Db): Routes {
  return makeRoutes({
    db: () => db,
    vfs: () => 'memory',
    schemaVersion: () => 1,
    importDatabase: () => Promise.reject(new Error('not under test')),
    exportDb: () => null,
  })
}

const file = (text: string, name: string) => new File([text], name)

const count = (db: Database, table: string) =>
  Number(db.selectValue(`SELECT COUNT(*) FROM ${table}`))

describe('detection', () => {
  it('recognizes both ManaBox dialects and the sealed shape', () => {
    expect(detectKind(SAMPLE)).toEqual(['singles', 'ManaBox (current)'])
    const legacy = SAMPLE.replace(
      'Title,Edition,Foil,Quantity,Set name',
      'Name,Set code,Foil,Quantity,Set name',
    )
    expect(detectKind(legacy)).toEqual(['singles', 'ManaBox (legacy Name/Set code)'])
    expect(detectKind(SEALED_SAMPLE)).toEqual(['sealed', 'sealed.csv'])
  })

  it('rejects an unrecognizable header, quoting it back', () => {
    expect(() => detectKind('Foo,Bar\n1,2\n')).toThrow(/Header was: Foo, Bar/)
  })
})

describe('the import lifecycle', () => {
  let db: Db
  let routes: Routes
  beforeEach(async () => {
    db = await openDb()
    routes = routesFor(db)
  })

  it('staging touches no canonical data; discard leaves none', async () => {
    const { importId } = await routes.upload({ file: file(SAMPLE, 'sample.csv') })
    expect(count(db, 'holdings')).toBe(0)
    expect(count(db, 'staged_rows')).toBeGreaterThan(0)
    routes.discardImport({ id: importId })
    expect(count(db, 'holdings')).toBe(0)
    expect(count(db, 'staged_rows')).toBe(0)
  })

  it('commit adds rows and records one undoable operation', async () => {
    const { importId } = await routes.upload({ file: file(SAMPLE, 'sample.csv') })
    const result = routes.commitImport({ id: importId })
    expect(result.added).toBeGreaterThan(0)
    expect(result.updated).toBe(0)
    expect(count(db, 'holdings')).toBe(result.added as number)
    const undoable = routes.session().undoable!
    expect(undoable.kind).toBe('import_commit')
    expect(undoable.summary).toContain('sample.csv')
  })

  it('a second export merges quantities instead of duplicating cards', async () => {
    const first = await routes.upload({ file: file(SAMPLE, 'sample.csv') })
    routes.commitImport({ id: first.importId })
    const beforeRows = count(db, 'holdings')
    const beforeQty = Number(db.selectValue('SELECT SUM(quantity) FROM holdings'))

    // The same cards again, under a different filename and one changed byte
    // (so the sha differs): quantities must add, row count must not.
    const again = await routes.upload({ file: file(SAMPLE + ' ', 'rescan.csv') })
    const result = routes.commitImport({ id: again.importId })
    expect(result.added).toBe(0)
    expect(result.updated).toBe(beforeRows)
    expect(count(db, 'holdings')).toBe(beforeRows)
    expect(Number(db.selectValue('SELECT SUM(quantity) FROM holdings'))).toBe(beforeQty * 2)
  })

  it('the same file cannot be imported twice', async () => {
    const { importId } = await routes.upload({ file: file(SAMPLE, 'sample.csv') })
    routes.commitImport({ id: importId })
    await expect(routes.upload({ file: file(SAMPLE, 'renamed.csv') })).rejects.toThrow(
      /already imported as “sample.csv”/,
    )
    await expect(routes.upload({ file: file(SAMPLE, 'renamed.csv') })).rejects.toMatchObject({
      code: 'duplicate',
      status: 409,
    })
  })

  it('undo reverses a commit exactly — including a merge', async () => {
    const first = await routes.upload({ file: file(SAMPLE, 'sample.csv') })
    routes.commitImport({ id: first.importId })
    const snapshot = db.selectObjects('SELECT * FROM holdings ORDER BY id')

    const again = await routes.upload({ file: file(SAMPLE + ' ', 'rescan.csv') })
    routes.commitImport({ id: again.importId })
    expect(db.selectObjects('SELECT * FROM holdings ORDER BY id')).not.toEqual(snapshot)

    routes.undo()
    expect(db.selectObjects('SELECT * FROM holdings ORDER BY id')).toEqual(snapshot)
    // The second import record is back to staged, not committed.
    expect(
      db.selectValue('SELECT status FROM imports WHERE id = ?', [again.importId]),
    ).toBe('staged')
  })

  it('blocking sealed rows gate the commit until resolved or skipped', async () => {
    const { importId } = await routes.upload({ file: file(SEALED_SAMPLE, 'sealed.csv') })
    const detail = routes.importDetail({ id: importId })
    expect(detail.blocking).toBeGreaterThan(0)

    let refusal: ApiFailure | null = null
    try {
      routes.commitImport({ id: importId })
    } catch (error) {
      refusal = error as ApiFailure
    }
    expect(refusal?.status).toBe(409)
    expect(refusal?.code).toBe('blocked')
    expect(refusal?.message).toContain('still need a decision')
    expect(count(db, 'sealed')).toBe(0)

    for (const issue of detail.issues) {
      if (!issue.blocking) continue
      for (const row of issue.rows) {
        routes.resolveRow({ importId, rowId: row.id, body: { skip: true } })
      }
    }
    const result = routes.commitImport({ id: importId })
    expect(count(db, 'sealed')).toBe(result.added as number)
    expect(result.added).toBeGreaterThan(0)
  })

  it('resolving an ambiguous row with a set code unblocks it', async () => {
    const { importId } = await routes.upload({ file: file(SEALED_SAMPLE, 'sealed.csv') })
    const detail = routes.importDetail({ id: importId })
    const ambiguous = detail.issues.find((i) => i.code === 'ambiguous')
    expect(ambiguous).toBeDefined()
    const target = ambiguous!.rows[0]
    expect(target.candidates.length).toBeGreaterThan(1)

    const setCode = target.candidates[0].split(' ')[0]
    const { blocking } = routes.resolveRow({
      importId,
      rowId: target.id,
      body: { set_code: setCode },
    })
    expect(blocking).toBeLessThan(detail.blocking)
    const after = db.selectObject('SELECT state, resolution FROM staged_rows WHERE id = ?', [
      target.id,
    ])!
    expect(after.state).toBe('resolved')
    expect(JSON.parse(after.resolution as string).set_code).toBe(setCode)
  })
})
