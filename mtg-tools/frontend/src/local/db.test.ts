import { describe, expect, it } from 'vitest'

import { formatCents, now, toCents, transaction, type Database } from './db'

describe('now()', () => {
  it('matches the Python isoformat exactly, +00:00 and all', () => {
    // webapp/db.py now() emits second-precision `+00:00`, not JS's `Z`.
    // Timestamps are string-sorted in SQL and diffed by the parity gate,
    // so this format is a contract, not a preference.
    const clock = () => new Date(Date.UTC(2026, 6, 30, 12, 34, 56, 789))
    expect(now(clock)).toBe('2026-07-30T12:34:56+00:00')
  })

  it('zero-pads every field', () => {
    const clock = () => new Date(Date.UTC(2026, 0, 2, 3, 4, 5))
    expect(now(clock)).toBe('2026-01-02T03:04:05+00:00')
  })
})

describe('toCents()', () => {
  it('keeps null and empty as null — unpriced is not free', () => {
    expect(toCents(null)).toBeNull()
    expect(toCents(undefined)).toBeNull()
    expect(toCents('')).toBeNull()
  })

  it('converts two-decimal dollars exactly', () => {
    expect(toCents('1.10')).toBe(110)
    expect(toCents('0.35')).toBe(35)
    expect(toCents('2.0')).toBe(200)
    expect(toCents('250')).toBe(25000)
    expect(toCents('-0.50')).toBe(-50)
  })

  it('rounds half-even past the second decimal, like Decimal.quantize', () => {
    expect(toCents('1.005')).toBe(100) // tie -> even cent (100, not 101)
    expect(toCents('1.015')).toBe(102) // tie -> even cent (102)
    expect(toCents('1.0051')).toBe(101) // just past the tie -> up
    expect(toCents('1.0049')).toBe(100) // just short -> down
    expect(toCents('1.00500')).toBe(100) // trailing zeros are still a tie
  })

  it('refuses non-money text instead of guessing', () => {
    expect(() => toCents('cheap')).toThrow()
  })
})

describe('formatCents()', () => {
  it('formats like webapp/db.py format_cents', () => {
    expect(formatCents(null)).toBe('—')
    expect(formatCents(0)).toBe('$0.00')
    expect(formatCents(35)).toBe('$0.35')
    expect(formatCents(123456)).toBe('$1,234.56')
    expect(formatCents(-50)).toBe('-$0.50')
    expect(formatCents(2098429)).toBe('$20,984.29')
  })
})

describe('transaction()', () => {
  function fakeDb() {
    const statements: string[] = []
    const db: Database = {
      exec: (sql) => statements.push(typeof sql === 'string' ? sql : sql.sql),
      selectValue: () => undefined,
      selectObject: () => undefined,
      selectObjects: () => [],
    }
    return { db, statements }
  }

  it('commits on success', () => {
    const { db, statements } = fakeDb()
    const result = transaction(db, () => 42)
    expect(result).toBe(42)
    expect(statements).toEqual(['BEGIN IMMEDIATE', 'COMMIT'])
  })

  it('rolls back on throw and rethrows', () => {
    const { db, statements } = fakeDb()
    expect(() =>
      transaction(db, () => {
        throw new Error('nope')
      }),
    ).toThrow('nope')
    expect(statements).toEqual(['BEGIN IMMEDIATE', 'ROLLBACK'])
  })
})
