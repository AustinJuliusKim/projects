/**
 * Port of `binders/sealed.py`'s parse-and-resolve surface. Codes and
 * candidate lists match the Python resolver exactly; issue *messages* are not
 * ported (the importer stores codes only). The one deliberate omission is
 * difflib's did-you-mean suggestions — they existed solely inside an
 * unmatched-row message the webapp never persisted.
 */

import { toCents } from '../db'
import {
  Catalog,
  deckDisplay,
  deckNickname,
  deckYear,
  isCollectorsEdition,
  nickname,
  splitDisplay,
  type Deck,
} from './catalog'

export const KNOWN_CONDITIONS = ['sealed', 'opened', 'damaged'] as const

export const MATCH_EXACT = 'exact'
export const MATCH_NICKNAME = 'nickname'
export const MATCH_SUFFIX = 'suffix'
export const MATCH_CONTAINS = 'contains'
export const MATCH_UUID = 'uuid'
export const MATCH_AMBIGUOUS = 'ambiguous'
export const MATCH_UNMATCHED = 'unmatched'

export interface SealedHolding {
  rawName: string
  setHint: string
  quantity: number
  condition: string
  priceCents: number | null
  priceDate: string | null // ISO date, matching Python date.isoformat()
  source: string
  costBasisCents: number | null
  notes: string
  line: number
  deck: Deck | null
  match: string
  candidates: Deck[]
}

export function sealedIdentity(holding: SealedHolding): string {
  if (holding.deck) return holding.deck.uuid
  return `unresolved:${nickname(holding.rawName)}`
}

export function sealedSetCode(holding: SealedHolding): string {
  return holding.deck ? holding.deck.setCode : holding.setHint
}

export function sealedYear(holding: SealedHolding): string {
  return holding.deck ? deckYear(holding.deck) : ''
}

/** sealed._parse_money: empty/unparseable → null (never 0 — the opposite of
 * the singles rule, where a bad price becomes 0). */
export function parseSealedMoney(value: string | undefined): number | null {
  const text = (value ?? '').trim()
  if (!text) return null
  try {
    return toCents(text.replaceAll('$', '').replaceAll(',', ''))
  } catch {
    return null
  }
}

/** sealed._parse_date: %Y-%m-%d, %m/%d/%Y, %m/%d/%y — else null. */
export function parseSealedDate(value: string | undefined): string | null {
  const text = (value ?? '').trim()
  if (!text) return null
  let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (match) {
    const [, y, m, d] = match
    return validDate(Number(y), Number(m), Number(d))
  }
  match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text)
  if (match) return validDate(Number(match[3]), Number(match[1]), Number(match[2]))
  match = /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/.exec(text)
  if (match) {
    // strptime %y: 00-68 → 2000s, 69-99 → 1900s.
    const yy = Number(match[3])
    return validDate(yy <= 68 ? 2000 + yy : 1900 + yy, Number(match[1]), Number(match[2]))
  }
  return null
}

function validDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1) return null
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate()
  if (day > days) return null
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export interface SealedIssue {
  level: 'error' | 'warn' | 'info'
  code: string
  line: number
}

function filterBySet(candidates: Deck[], setHint: string): Deck[] {
  if (!setHint) return [...candidates]
  const wanted = setHint.trim().toLowerCase()
  const narrowed = candidates.filter((d) => d.setCode.toLowerCase() === wanted)
  // A set hint that matches nothing is more likely a typo than a reason to
  // discard every candidate, so fall back rather than silently unmatching.
  return narrowed.length ? narrowed : [...candidates]
}

/** Port of sealed.resolve: pin each row to an exact product. */
export function resolve(
  holdings: SealedHolding[],
  catalog: Catalog,
): [SealedHolding[], SealedIssue[]] {
  const resolved: SealedHolding[] = []
  const issues: SealedIssue[] = []

  for (const holding of holdings) {
    if (!holding.rawName) {
      issues.push({ level: 'error', code: 'no-name', line: holding.line })
      resolved.push(holding)
      continue
    }

    const byUuid = catalog.byUuid(holding.rawName)
    if (byUuid) {
      resolved.push({ ...holding, deck: byUuid, match: MATCH_UUID })
      continue
    }

    // A row may carry doctor's own `Name [SET]` suggestion — strip the suffix
    // (only when the code is real) and let it stand in as a set hint.
    let lookupName = holding.rawName
    let setHint = holding.setHint
    const [base, displaySet] = splitDisplay(holding.rawName)
    if (base && displaySet && catalog.hasSet(displaySet)) {
      lookupName = base
      setHint = setHint || displaySet
    }

    // Narrowest match first; each tier only if the previous found nothing.
    const tiers: Array<[string, (text: string) => Deck[]]> = [
      [MATCH_EXACT, (t) => catalog.byName(t)],
      [MATCH_NICKNAME, (t) => catalog.byNickname(t)],
      [MATCH_SUFFIX, (t) => catalog.byNicknameSuffix(t)],
      [MATCH_CONTAINS, (t) => catalog.byNicknameContains(t)],
    ]
    let candidates: Deck[] = []
    let match = MATCH_UNMATCHED
    for (const [tierName, lookup] of tiers) {
      const found = filterBySet(lookup(lookupName), setHint)
      if (found.length) {
        candidates = found
        match = tierName
        break
      }
    }

    if (candidates.length === 1) {
      const found = candidates[0]
      const out = { ...holding, deck: found, match }
      resolved.push(out)

      // A Collector's Edition sibling is a real valuation trap.
      const siblings = catalog.decks.filter(
        (d) =>
          d.setCode === found.setCode &&
          d.uuid !== found.uuid &&
          isCollectorsEdition(d) &&
          deckNickname(d).includes(nickname(found.name, found.setName)),
      )
      if (siblings.length && !isCollectorsEdition(found)) {
        issues.push({ level: 'info', code: 'collectors-edition-exists', line: out.line })
      }
      continue
    }

    if (candidates.length > 1) {
      const out = { ...holding, match: MATCH_AMBIGUOUS, candidates }
      resolved.push(out)
      issues.push({ level: 'warn', code: 'ambiguous', line: out.line })
      continue
    }

    resolved.push({ ...holding, match: MATCH_UNMATCHED })
    issues.push({ level: 'error', code: 'unmatched', line: holding.line })
  }

  issues.push(...valueIssues(resolved))
  return [resolved, issues]
}

function valueIssues(holdings: SealedHolding[]): SealedIssue[] {
  const issues: SealedIssue[] = []
  for (const h of holdings) {
    if (h.quantity <= 0) issues.push({ level: 'error', code: 'bad-quantity', line: h.line })
    const hasPrice = h.priceCents !== null && h.priceCents > 0
    if (!hasPrice) {
      issues.push({ level: 'warn', code: 'no-price', line: h.line })
    } else if (h.priceDate === null) {
      issues.push({ level: 'warn', code: 'no-price-date', line: h.line })
    }
    if (!(KNOWN_CONDITIONS as readonly string[]).includes(h.condition)) {
      issues.push({ level: 'warn', code: 'condition', line: h.line })
    }
  }
  return issues
}

/** The `SET (YEAR)` strings the doctor offers for an ambiguous row. */
export function candidateLabels(holding: SealedHolding): string[] {
  return holding.candidates.map((d) => `${d.setCode} (${deckYear(d)})`)
}

export { deckDisplay }
