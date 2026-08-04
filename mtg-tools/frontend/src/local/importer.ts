/**
 * Ingest: upload -> stage -> doctor -> commit. Port of `webapp/importer.py`.
 *
 * The invariant that makes this safe: **canonical data is untouched until
 * commit.** An upload lands in `staged_rows`, issues come from the same
 * validate/resolve ports the CLI's logic defines, and only an explicit commit
 * writes to `holdings` or `sealed` — one transaction, one undo entry.
 *
 * The SHA-256 digest is computed by the caller (crypto.subtle is async) so
 * everything here stays synchronous inside the mutation's transaction.
 */

import Papa from 'papaparse'

import { now, type Database } from './db'
import * as ops from './operations'
import {
  MANABOX_COLUMNS,
  canonicalHeader,
  cardIdentity,
  parseRow,
  validateCards,
  type Card,
} from './binders/io'
import { catalog } from './binders/catalog'
import {
  candidateLabels,
  parseSealedDate,
  parseSealedMoney,
  resolve,
  sealedIdentity,
  sealedSetCode,
  sealedYear,
  type SealedHolding,
} from './binders/sealed'

export class DetectionError extends Error {}
export class DuplicateImportError extends Error {}
export class ImportNotFound extends Error {}
export class ImportStateError extends Error {}

export async function sha256hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function decodeUpload(bytes: Uint8Array): string {
  // utf-8-sig semantics: strip a BOM, replace undecodable bytes.
  return new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, '')
}

function parseCsv(text: string): Record<string, string>[] {
  return Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true, // csv.DictReader also skips fully blank lines
  }).data
}

function sniff(text: string): string[] {
  const first = Papa.parse<string[]>(text, { header: false, preview: 1 }).data[0]
  return (first ?? []).map((c) => (c ?? '').trim())
}

export function detectKind(text: string): [string, string] {
  const header = sniff(text)
  if (!header.length || header.every((h) => !h)) throw new DetectionError('The file is empty.')

  const mapping = canonicalHeader(header)
  const canonical = new Set(mapping.values())
  if (canonical.has('Title')) {
    const known = [...canonical].filter((c) =>
      (MANABOX_COLUMNS as readonly string[]).includes(c),
    ).length
    const dialect = header.includes('Title')
      ? 'ManaBox (current)'
      : 'ManaBox (legacy Name/Set code)'
    if (known >= 6) return ['singles', dialect]
  }

  const lowered = new Set(header.map((h) => h.toLowerCase()))
  if (lowered.has('name') && lowered.has('quantity')) return ['sealed', 'sealed.csv']

  throw new DetectionError(
    "Couldn't tell what this file is. Expected a ManaBox export (a Title or " +
      'Name column) or a sealed list (Name + Quantity). Header was: ' +
      header.slice(0, 8).join(', '),
  )
}

// --- staging -----------------------------------------------------------------

export function stageImport(
  db: Database,
  filename: string,
  text: string,
  digest: string,
): [number, string] {
  const prior = db.selectObject(
    "SELECT id, filename, committed_at FROM imports WHERE sha256 = ? AND status = 'committed'",
    [digest],
  )
  if (prior !== undefined) {
    throw new DuplicateImportError(
      `This exact file was already imported as “${prior.filename}” on ` +
        `${String(prior.committed_at ?? '').slice(0, 10)}. Importing it again would ` +
        'double those quantities.',
    )
  }

  const [kind, dialect] = detectKind(text)

  db.exec({
    sql:
      'INSERT INTO imports (filename, sha256, kind, dialect, status, created_at) ' +
      "VALUES (?, ?, ?, ?, 'staged', ?)",
    bind: [filename, digest, kind, dialect, now()],
  })
  const importId = Number(db.selectValue('SELECT last_insert_rowid()'))

  const rows = parseCsv(text)
  const staged = kind === 'singles' ? stageSingles(rows) : stageSealed(rows)

  staged.forEach((r, i) => {
    db.exec({
      sql:
        'INSERT INTO staged_rows (import_id, line_no, raw, parsed, issues, state) ' +
        'VALUES (?, ?, ?, ?, ?, ?)',
      bind: [
        importId,
        i + 2,
        JSON.stringify(r.raw),
        JSON.stringify(r.parsed),
        JSON.stringify(r.issues),
        r.state,
      ],
    })
  })
  db.exec({
    sql: 'UPDATE imports SET row_count = ? WHERE id = ?',
    bind: [staged.length, importId],
  })
  return [importId, kind]
}

interface Staged {
  raw: Record<string, string>
  parsed: Record<string, unknown>
  issues: string[]
  state: 'pending' | 'resolved'
}

function stageSingles(rows: Record<string, string>[]): Staged[] {
  const cards: Card[] = []
  for (const row of rows) {
    if (Object.values(row).some((v) => (v ?? '').trim())) cards.push(parseRow(row))
  }
  const problems = validateCards(cards)

  return cards.map((card, index) => {
    const codes = problems.get(index) ?? []
    return {
      raw: index < rows.length ? rows[index] : {},
      parsed: cardFields(card),
      issues: codes,
      // Only an error blocks a commit; warnings are informational.
      state: isBlocking(codes) ? 'pending' : 'resolved',
    }
  })
}

function stageSealed(rows: Record<string, string>[]): Staged[] {
  const holdings: SealedHolding[] = []
  rows.forEach((row, i) => {
    if (!Object.values(row).some((v) => (v ?? '').trim())) return
    const qty = (row['Quantity'] ?? '1').trim() || '1'
    holdings.push({
      rawName: (row['Name'] ?? '').trim(),
      setHint: (row['Set'] ?? '').trim(),
      quantity: /^-?\d+$/.test(qty) ? parseInt(qty, 10) : 1,
      condition: ((row['Condition'] ?? 'sealed').trim().toLowerCase()) || 'sealed',
      priceCents: parseSealedMoney(row['Price']),
      priceDate: parseSealedDate(row['Price date']),
      source: (row['Source'] ?? '').trim(),
      costBasisCents: parseSealedMoney(row['Cost basis']),
      notes: (row['Notes'] ?? '').trim(),
      line: i + 2,
      deck: null,
      match: 'unmatched',
      candidates: [],
    })
  })

  const [resolved, issues] = resolve(holdings, catalog())
  const problems = new Map<number, string[]>()
  for (const issue of issues) {
    const list = problems.get(issue.line) ?? []
    list.push(issue.code)
    problems.set(issue.line, list)
  }

  return resolved.map((holding, index) => {
    const codes = problems.get(holding.line) ?? []
    return {
      raw: index < rows.length ? rows[index] : {},
      parsed: sealedFields(holding),
      issues: codes,
      state: isBlocking(codes) ? 'pending' : 'resolved',
    }
  })
}

//: Codes that must be dealt with before a commit. Everything else is advisory.
export const BLOCKING = ['unmatched', 'ambiguous', 'no-name', 'bad-quantity'] as const

function isBlocking(codes: string[]): boolean {
  return codes.some((c) => (BLOCKING as readonly string[]).includes(c))
}

function cardFields(card: Card): Record<string, unknown> {
  return {
    identity: cardIdentity(card).join('|'),
    title: card.title,
    edition: card.edition,
    set_name: card.setName,
    collector_number: card.collectorNumber,
    rarity: card.rarity,
    foil: card.foil ? 1 : 0,
    finish: card.finish,
    quantity: card.quantity,
    price_cents: card.priceCents,
    condition: card.condition,
    language: card.language,
    scryfall_id: card.scryfallId,
    manabox_id: card.manaboxId,
    sources: card.sources.join('|'),
    added_at: card.added,
  }
}

function sealedFields(holding: SealedHolding): Record<string, unknown> {
  const deck = holding.deck
  return {
    identity: sealedIdentity(holding),
    mtgjson_uuid: deck ? deck.uuid : '',
    raw_name: holding.rawName,
    product_name: deck ? deck.name : '',
    set_code: sealedSetCode(holding),
    set_name: deck ? deck.setName : '',
    release_year: sealedYear(holding),
    quantity: holding.quantity,
    condition: holding.condition,
    price_cents: holding.priceCents,
    price_date: holding.priceDate,
    price_source: holding.source,
    cost_basis_cents: holding.costBasisCents,
    purchase_url: deck ? deck.tcgplayerUrl : '',
    notes: holding.notes,
    resolved: holding.deck ? 1 : 0,
    candidates: candidateLabels(holding),
  }
}

// --- reading back ------------------------------------------------------------

export interface IssueRow {
  id: number
  line_no: number
  parsed: Record<string, unknown>
  resolution: Record<string, unknown>
  state: string
  blocking: boolean
}

export function issuesFor(db: Database, importId: number): Map<string, IssueRow[]> {
  const grouped = new Map<string, IssueRow[]>()
  for (const row of db.selectObjects(
    'SELECT * FROM staged_rows WHERE import_id = ? ORDER BY line_no',
    [importId],
  )) {
    for (const code of JSON.parse(row.issues as string) as string[]) {
      const list = grouped.get(code) ?? []
      list.push({
        id: row.id as number,
        line_no: row.line_no as number,
        parsed: JSON.parse(row.parsed as string),
        resolution: JSON.parse(row.resolution as string),
        state: row.state as string,
        blocking: (BLOCKING as readonly string[]).includes(code),
      })
      grouped.set(code, list)
    }
  }
  return grouped
}

export function blockingCount(db: Database, importId: number): number {
  return Number(
    db.selectValue(
      "SELECT COUNT(*) AS n FROM staged_rows WHERE import_id = ? AND state = 'pending'",
      [importId],
    ),
  )
}

// --- commit ------------------------------------------------------------------

export function commitImport(db: Database, importId: number): Record<string, unknown> {
  const record = db.selectObject('SELECT * FROM imports WHERE id = ?', [importId])
  if (record === undefined) throw new ImportNotFound(`no import ${importId}`)
  if (record.status !== 'staged') {
    throw new ImportStateError(`import ${importId} is already ${record.status}`)
  }

  const pending = blockingCount(db, importId)
  if (pending) {
    throw new ImportStateError(
      `${pending} row(s) still need a decision. Resolve them on the review ` +
        'screen, or skip them, before committing.',
    )
  }

  const table = record.kind === 'singles' ? 'holdings' : 'sealed'
  const staged = db.selectObjects(
    "SELECT * FROM staged_rows WHERE import_id = ? AND state != 'skipped' ORDER BY line_no",
    [importId],
  )

  // Snapshot the import row before its status changes.
  const importBefore = ops.snapshotRows(db, 'imports', [importId])

  const beforeRows: Record<string, unknown>[] = []
  const createdIds: number[] = []
  let added = 0
  let updated = 0

  for (const row of staged) {
    const fields: Record<string, unknown> = {
      ...JSON.parse(row.parsed as string),
      ...(JSON.parse(row.resolution as string) ?? {}),
    }
    delete fields.candidates

    const existing = db.selectObject(`SELECT * FROM ${table} WHERE identity = ?`, [
      fields.identity,
    ])
    if (existing === undefined) {
      createdIds.push(insertRow(db, table, fields, importId))
      added += 1
    } else {
      // Capture the row as it is *now*, before the merge changes it —
      // snapshotting later would silently make the import unreversible.
      beforeRows.push({ ...existing })
      mergeInto(db, table, existing, fields, importId)
      updated += 1
    }
  }

  db.exec({
    sql: "UPDATE imports SET status = 'committed', committed_at = ? WHERE id = ?",
    bind: [now(), importId],
  })

  ops.record(
    db,
    'import_commit',
    `Imported ${record.filename} — ${added} new, ${updated} updated`,
    {
      before: { [table]: beforeRows, imports: importBefore },
      created: { [table]: createdIds },
      affected: added + updated,
    },
  )
  return { added, updated, kind: record.kind }
}

function tableColumns(db: Database, table: string): Set<string> {
  return new Set(db.selectObjects(`PRAGMA table_info(${table})`).map((r) => r.name as string))
}

function insertRow(
  db: Database,
  table: string,
  fields: Record<string, unknown>,
  importId: number,
): number {
  const payload: Record<string, unknown> = { ...fields }
  payload.source_import_id = importId
  payload.created_at = payload.updated_at = now()
  const known = tableColumns(db, table)
  const columns = Object.keys(payload).filter((c) => known.has(c))
  const placeholders = columns.map(() => '?').join(',')
  db.exec({
    sql: `INSERT INTO ${table} (${columns.join(',')}) VALUES (${placeholders})`,
    bind: columns.map((c) => payload[c] ?? null),
  })
  return Number(db.selectValue('SELECT last_insert_rowid()'))
}

function mergeInto(
  db: Database,
  table: string,
  existing: Record<string, unknown>,
  fields: Record<string, unknown>,
  importId: number,
): void {
  // Add quantity; take the newer scan's price.
  const quantity = (existing.quantity as number) + Number(fields.quantity ?? 0)

  let price = existing.price_cents as number | null
  const incoming = (fields.price_cents as number | null | undefined) ?? null
  if (incoming !== null) {
    let newer = true
    if (table === 'holdings') {
      const oldAt = existing.added_at as string | null
      const newAt = (fields.added_at as string | null | undefined) ?? null
      if (oldAt && newAt) newer = newAt >= oldAt
    }
    if (newer || price === null) price = incoming
  }

  db.exec({
    sql:
      `UPDATE ${table} SET quantity = ?, price_cents = ?, ` +
      'source_import_id = ?, version = version + 1, updated_at = ? WHERE id = ?',
    bind: [quantity, price, importId, now(), existing.id],
  })
}

export function discardImport(db: Database, importId: number): void {
  // Canonical data was never touched.
  db.exec({
    sql: "UPDATE imports SET status = 'discarded' WHERE id = ? AND status = 'staged'",
    bind: [importId],
  })
  db.exec({ sql: 'DELETE FROM staged_rows WHERE import_id = ?', bind: [importId] })
}

/** api.py's _import serializer. */
export function importJson(row: Record<string, unknown>) {
  return {
    id: row.id,
    filename: row.filename,
    kind: row.kind,
    dialect: row.dialect,
    rowCount: row.row_count,
    status: row.status,
    createdAt: row.created_at,
    committedAt: row.committed_at,
  }
}
