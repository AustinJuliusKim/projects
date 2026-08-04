/**
 * Port of `binders/io.py`'s parse surface plus `binders/model.py`'s identity
 * rules — grown from the benchmark's `parse.mjs`, which proved cent-exact
 * against the Python parser on 100k rows before this file existed.
 *
 * Money is integer cents from the moment it parses; `parse_row`'s failure
 * mode (`money()` raising → Decimal 0) is preserved as cents 0. Issue
 * *messages* are not ported: the importer stores only codes, and the doctor
 * screen renders from those.
 */

import { toCents } from '../db'

export const MANABOX_COLUMNS = [
  'Title', 'Edition', 'Foil', 'Quantity', 'Set name', 'Collector number',
  'Rarity', 'ManaBox ID', 'Scryfall ID', 'Purchase price', 'Misprint',
  'Altered', 'Condition', 'Language', 'Purchase price currency', 'Added',
] as const

export const SOURCE_COLUMN = 'Source'

const ALIASES = new Map([
  ['name', 'Title'], ['card name', 'Title'],
  ['set code', 'Edition'], ['set', 'Edition'],
  ['currency', 'Purchase price currency'],
])

const CANONICAL_BY_FOLD = new Map(MANABOX_COLUMNS.map((c) => [c.toLowerCase(), c]))

const TRUE_WORDS = new Set(['true', '1', 'yes', 'y', 't'])
const FALSE_WORDS = new Set(['false', '0', 'no', 'n', 'f', ''])
const FINISH_WORDS = new Set(['normal', 'nonfoil', 'non-foil', 'foil', 'etched', 'etched foil'])

export function canonicalHeader(fields: Iterable<string>): Map<string, string> {
  const mapping = new Map<string, string>()
  for (const name of fields ?? []) {
    if (!name) continue
    const key = name.trim().toLowerCase()
    mapping.set(name, CANONICAL_BY_FOLD.get(key) ?? ALIASES.get(key) ?? name)
  }
  return mapping
}

function parseBool(value: string | undefined): boolean {
  const text = (value ?? '').trim().toLowerCase()
  if (TRUE_WORDS.has(text)) return true
  if (FALSE_WORDS.has(text)) return false
  throw new Error(`cannot interpret '${value}' as a boolean`)
}

function parseFinish(value: string | undefined): [boolean, string] {
  const text = (value ?? '').trim().toLowerCase()
  if (FINISH_WORDS.has(text)) {
    if (text === 'normal' || text === 'nonfoil' || text === 'non-foil') return [false, 'normal']
    if (text.startsWith('etched')) return [true, 'etched']
    return [true, 'foil']
  }
  return [parseBool(text), '']
}

/**
 * ManaBox's Added timestamp, normalized to what Python's
 * `datetime.fromisoformat(...).isoformat()` prints — `_card_fields` stores
 * that string, and `_merge_into` compares it lexicographically, so the exact
 * rendering (six-digit microseconds, `+00:00`) is load-bearing.
 */
export function parseAdded(value: string | undefined): string | null {
  const text = (value ?? '').trim()
  if (!text) return null
  const normalized = text.endsWith('Z') ? `${text.slice(0, -1)}+00:00` : text
  const match =
    /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)(?:\.(\d{1,6}))?([+-]\d{2}:\d{2})?$/.exec(
      normalized,
    )
  if (match) {
    const time = match[2].length === 5 ? `${match[2]}:00` : match[2]
    // Python's isoformat omits the fraction entirely when microseconds are 0
    // (".000Z" round-trips to second precision), else prints six digits.
    const micro =
      match[3] && Number(match[3]) !== 0 ? `.${match[3].padEnd(6, '0')}` : ''
    return `${match[1]}T${time}${micro}${match[4] ?? ''}`
  }
  // Fall back to a date-only value rather than losing the row.
  if (/^\d{4}-\d{2}-\d{2}$/.test(text.slice(0, 10))) return `${text.slice(0, 10)}T00:00:00`
  return null
}

/** Port of model.normalize_title: NFKD, strip marks, non-alnum → space. */
export function normalizeTitle(title: string): string {
  const stripped = title.normalize('NFKD').replace(/\p{M}/gu, '')
  const kept = [...stripped]
    .map((ch) => (/[\p{L}\p{N}\s]/u.test(ch) ? ch : ' '))
    .join('')
  return kept.split(/\s+/).filter(Boolean).join(' ').toLowerCase()
}

export interface Card {
  title: string
  edition: string
  foil: boolean
  finish: string
  quantity: number
  setName: string
  collectorNumber: string
  rarity: string
  manaboxId: string
  scryfallId: string
  priceCents: number
  misprint: boolean
  altered: boolean
  condition: string
  language: string
  currency: string
  added: string | null
  sources: string[]
}

/** model.Card.identity: scryfall id when present, else the normalized tuple. */
export function cardIdentity(card: Card): string[] {
  const finish = card.finish || (card.foil ? 'foil' : 'normal')
  if (card.scryfallId) return [card.scryfallId, finish]
  return [
    normalizeTitle(card.title),
    card.edition.toLowerCase(),
    card.collectorNumber.toLowerCase(),
    finish,
  ]
}

export function parseRow(raw: Record<string, string>, source?: string): Card {
  const header = canonicalHeader(Object.keys(raw))
  const row: Record<string, string> = {}
  for (const [actual, canonical] of header) row[canonical] = raw[actual]

  const [foil, finish] = parseFinish(row['Foil'])

  let priceCents: number
  try {
    priceCents = toCents(row['Purchase price']?.replaceAll('$', '').replaceAll(',', '')) ?? 0
  } catch {
    priceCents = 0
  }

  const quantityRaw = (row['Quantity'] ?? '1').trim() || '1'
  const quantity = /^-?\d+$/.test(quantityRaw) ? parseInt(quantityRaw, 10) : 1

  let sources: string[] = []
  if (source) sources = [source]
  else if (row[SOURCE_COLUMN]) {
    sources = row[SOURCE_COLUMN].split('|').map((p) => p.trim()).filter(Boolean)
  }

  return {
    title: (row['Title'] ?? '').trim(),
    edition: (row['Edition'] ?? '').trim(),
    foil,
    finish,
    quantity,
    setName: (row['Set name'] ?? '').trim(),
    collectorNumber: (row['Collector number'] ?? '').trim(),
    rarity: (row['Rarity'] ?? '').trim().toLowerCase(),
    manaboxId: (row['ManaBox ID'] ?? '').trim(),
    scryfallId: (row['Scryfall ID'] ?? '').trim(),
    priceCents,
    misprint: parseBool(row['Misprint']),
    altered: parseBool(row['Altered']),
    condition: (row['Condition'] ?? '').trim(),
    language: (row['Language'] ?? '').trim(),
    currency: (row['Purchase price currency'] ?? '').trim(),
    added: parseAdded(row['Added']),
    sources,
  }
}

/**
 * Port of io.validate, codes only (the importer stores codes; messages were
 * never persisted). Returns per-card issue codes keyed by card index.
 */
export function validateCards(cards: Card[]): Map<number, string[]> {
  const problems = new Map<number, string[]>()
  const push = (index: number, code: string) => {
    const list = problems.get(index) ?? []
    list.push(code)
    problems.set(index, list)
  }
  const seen = new Set<string>()

  cards.forEach((card, index) => {
    if (!card.title) push(index, 'no-title')
    if (card.priceCents <= 0) push(index, 'zero-price')
    if (!card.scryfallId) push(index, 'no-scryfall-id')
    if (card.quantity <= 0) push(index, 'bad-quantity')
    if (card.condition && card.condition !== 'near_mint') push(index, 'condition')
    if (card.language && card.language !== 'en') push(index, 'language')
    if (card.currency && card.currency !== 'USD') push(index, 'currency')
    if (card.misprint || card.altered) push(index, 'misprint-altered')

    const key = JSON.stringify([card.sources, cardIdentity(card)])
    if (seen.has(key)) push(index, 'duplicate-row')
    seen.add(key)
  })

  return problems
}
