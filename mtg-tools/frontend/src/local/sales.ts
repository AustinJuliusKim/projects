/**
 * The sale lifecycle: listed → sold → fees → net → realized gain. Port of
 * `webapp/sales.py`.
 *
 * Money stays integer cents through every step; net and realized gain are
 * computed and **stored**, not derived at read time. Cost basis is never
 * invented — no basis means gain is NULL, not "the whole sale price".
 *
 * One faithfully-ported quirk: when a full quantity sells, the verdict row is
 * snapshotted *after* it was deleted (so undo restores the subject and the
 * sale, not the verdict) — matching webapp/sales.py record_sale exactly.
 */

import { now, type Database } from './db'
import * as ops from './operations'

export class SaleError extends Error {}

export const STATUSES = ['listed', 'sold', 'cancelled'] as const
const KINDS = ['holding', 'sealed'] as const

function tableFor(kind: string): string {
  if (!(KINDS as readonly string[]).includes(kind)) {
    throw new SaleError(`'${kind}' is not a sellable kind`)
  }
  return kind === 'holding' ? 'holdings' : 'sealed'
}

function subjectRow(db: Database, kind: string, subjectId: number) {
  const row = db.selectObject(`SELECT * FROM ${tableFor(kind)} WHERE id = ?`, [subjectId])
  if (row === undefined) throw new SaleError(`No ${kind} ${subjectId}.`)
  return row
}

function nameOf(kind: string, row: Record<string, unknown>): string {
  if (kind === 'holding') return (row.title as string) + (row.foil ? ' (foil)' : '')
  return (row.product_name as string) || (row.raw_name as string)
}

function costBasisCents(
  kind: string,
  row: Record<string, unknown>,
  quantity: number,
): number | null {
  if (kind !== 'sealed') return null
  const basis = row.cost_basis_cents as number | null
  return basis === null ? null : basis * quantity
}

// --- the queue ---------------------------------------------------------------

export function listForSale(db: Database) {
  const rows = []
  for (const kind of KINDS) {
    const table = tableFor(kind)
    for (const row of db.selectObjects(
      `SELECT s.*, v.decided_at FROM ${table} s ` +
        'JOIN verdicts v ON v.subject_kind = ? AND v.subject_id = s.id ' +
        "WHERE v.verdict = 'sell' " +
        'ORDER BY (COALESCE(s.price_cents,0) * s.quantity) DESC',
      [kind],
    )) {
      const sale = db.selectObject(
        'SELECT * FROM sales WHERE subject_kind = ? AND subject_id = ? ' +
          "AND status != 'cancelled' ORDER BY id DESC LIMIT 1",
        [kind, row.id],
      )
      rows.push({
        kind,
        id: row.id as number,
        name: nameOf(kind, row),
        setCode: (kind === 'holding' ? row.edition : row.set_code) as string,
        quantity: row.quantity as number,
        priceCents: row.price_cents as number | null,
        marketCents: ((row.price_cents as number | null) ?? 0) * (row.quantity as number),
        costBasisCents: costBasisCents(kind, row, row.quantity as number),
        sale: sale ? { ...sale } : null,
      })
    }
  }
  // Stable, like Python's list.sort — equal values keep per-kind order.
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => b.row.marketCents - a.row.marketCents || a.index - b.index)
    .map(({ row }) => row)
}

// --- transitions -------------------------------------------------------------

export function recordListing(
  db: Database,
  kind: string,
  subjectId: number,
  options: {
    channel?: string
    listedCents?: number | null
    quantity?: number | null
    notes?: string
  } = {},
): number {
  const row = subjectRow(db, kind, subjectId)
  const quantity = Math.trunc(Number(options.quantity ?? 0)) || (row.quantity as number)
  if (quantity <= 0 || quantity > (row.quantity as number)) {
    throw new SaleError(
      `Cannot list ${quantity} of ${row.quantity} — pick between 1 and ${row.quantity}.`,
    )
  }

  const openSale = db.selectObject(
    "SELECT id FROM sales WHERE subject_kind = ? AND subject_id = ? AND status = 'listed'",
    [kind, subjectId],
  )
  if (openSale) {
    throw new SaleError('That is already listed. Record the sale or cancel it first.')
  }

  const listedCents =
    options.listedCents ?? (((row.price_cents as number | null) ?? 0) * quantity)

  const stamp = now()
  db.exec({
    sql:
      'INSERT INTO sales (subject_kind, subject_id, subject_name, subject_set, ' +
      'quantity, channel, status, listed_at, listed_cents, cost_basis_cents, ' +
      'notes, created_at, updated_at) ' +
      "VALUES (?, ?, ?, ?, ?, ?, 'listed', ?, ?, ?, ?, ?, ?)",
    bind: [
      kind,
      subjectId,
      nameOf(kind, row),
      (kind === 'holding' ? row.edition : row.set_code) as string,
      quantity,
      options.channel ?? '',
      stamp,
      listedCents,
      costBasisCents(kind, row, quantity),
      options.notes ?? '',
      stamp,
      stamp,
    ],
  })
  const saleId = Number(db.selectValue('SELECT last_insert_rowid()'))

  ops.record(db, 'sale_listed', `Listed ${nameOf(kind, row)} ×${quantity}`, {
    created: { sales: [saleId] },
    affected: 1,
  })
  return saleId
}

export function recordSale(
  db: Database,
  saleId: number,
  options: {
    soldCents: number
    feesCents?: number
    shippingCents?: number
    soldAt?: string | null
    notes?: string | null
  },
) {
  const sale = db.selectObject('SELECT * FROM sales WHERE id = ?', [saleId])
  if (sale === undefined) throw new SaleError(`No sale ${saleId}.`)
  if (sale.status !== 'listed') throw new SaleError(`That sale is already ${sale.status}.`)

  const soldCents = options.soldCents
  const feesCents = options.feesCents ?? 0
  const shippingCents = options.shippingCents ?? 0
  for (const [label, value] of [
    ['Sale price', soldCents],
    ['Fees', feesCents],
    ['Shipping', shippingCents],
  ] as const) {
    if (value === null || value === undefined || Math.trunc(Number(value)) < 0) {
      throw new SaleError(`${label} cannot be negative.`)
    }
  }

  const net = Math.trunc(soldCents) - Math.trunc(feesCents) - Math.trunc(shippingCents)
  const basis = sale.cost_basis_cents as number | null
  // None, not zero: an unknown basis must not become a realized gain.
  const gain = basis === null ? null : net - basis

  const kind = sale.subject_kind as string
  const subjectId = sale.subject_id as number
  const table = tableFor(kind)
  const row = subjectRow(db, kind, subjectId)

  const before: Record<string, ops.RowDict[]> = {
    sales: ops.snapshotRows(db, 'sales', [saleId]),
    [table]: ops.snapshotRows(db, table, [subjectId]),
  }

  const stamp = now()
  db.exec({
    sql:
      "UPDATE sales SET status = 'sold', sold_at = ?, sold_cents = ?, " +
      'fees_cents = ?, shipping_cents = ?, net_cents = ?, ' +
      'realized_gain_cents = ?, notes = COALESCE(?, notes), updated_at = ? ' +
      'WHERE id = ?',
    bind: [
      options.soldAt ?? stamp,
      Math.trunc(soldCents),
      Math.trunc(feesCents),
      Math.trunc(shippingCents),
      net,
      gain,
      options.notes ?? null,
      stamp,
      saleId,
    ],
  })

  const remaining = (row.quantity as number) - (sale.quantity as number)
  if (remaining > 0) {
    db.exec({
      sql:
        `UPDATE ${table} SET quantity = ?, version = version + 1, updated_at = ? ` +
        'WHERE id = ?',
      bind: [remaining, stamp, subjectId],
    })
  } else {
    db.exec({
      sql: 'DELETE FROM verdicts WHERE subject_kind = ? AND subject_id = ?',
      bind: [kind, subjectId],
    })
    db.exec({ sql: `DELETE FROM ${table} WHERE id = ?`, bind: [subjectId] })
    // Faithful quirk: this snapshot runs after the deletes, so it captures
    // nothing — undo restores the subject and sale, not the verdict.
    before.verdicts = [
      ...(before.verdicts ?? []),
      ...ops.snapshotRows(db, 'verdicts', [[kind, subjectId]]),
    ]
  }

  ops.record(db, 'sale_recorded', `Sold ${nameOf(kind, row)} ×${sale.quantity}`, {
    before,
    affected: 1,
  })

  return {
    saleId,
    netCents: net,
    realizedGainCents: gain,
    removedFromCollection: remaining <= 0,
  }
}

export function cancel(db: Database, saleId: number): void {
  const sale = db.selectObject('SELECT * FROM sales WHERE id = ?', [saleId])
  if (sale === undefined) throw new SaleError(`No sale ${saleId}.`)
  if (sale.status === 'sold') {
    throw new SaleError('That already sold — undo it from History instead.')
  }

  const before = { sales: ops.snapshotRows(db, 'sales', [saleId]) }
  db.exec({
    sql: "UPDATE sales SET status = 'cancelled', updated_at = ? WHERE id = ?",
    bind: [now(), saleId],
  })
  ops.record(db, 'sale_cancelled', 'Cancelled a listing', { before, affected: 1 })
}

// --- reading -----------------------------------------------------------------

export function saleRows(db: Database, status?: string | null) {
  let clause = ''
  const params: unknown[] = []
  if (status) {
    if (!(STATUSES as readonly string[]).includes(status)) {
      throw new SaleError(`'${status}' is not a sale status`)
    }
    clause = 'WHERE s.status = ?'
    params.push(status)
  }

  return db
    .selectObjects(`SELECT * FROM sales s ${clause} ORDER BY s.id DESC`, params)
    .map((sale) => {
      const table = tableFor(sale.subject_kind as string)
      const subject = db.selectObject(`SELECT * FROM ${table} WHERE id = ?`, [
        sale.subject_id,
      ])
      return {
        ...sale,
        // subject_name was captured at listing time so the record survives a
        // fully-sold (deleted) subject.
        name: subject
          ? nameOf(sale.subject_kind as string, subject)
          : ((sale.subject_name as string) || null),
      }
    })
}

export function summary(db: Database) {
  const sold = db.selectObject(
    'SELECT COUNT(*) AS n, ' +
      'COALESCE(SUM(sold_cents),0) AS gross, ' +
      'COALESCE(SUM(fees_cents),0) + COALESCE(SUM(shipping_cents),0) AS costs, ' +
      'COALESCE(SUM(net_cents),0) AS net ' +
      "FROM sales WHERE status = 'sold'",
  )!
  const gain = db.selectObject(
    'SELECT COALESCE(SUM(realized_gain_cents),0) AS gain, ' +
      'COUNT(realized_gain_cents) AS known ' +
      "FROM sales WHERE status = 'sold'",
  )!
  const listed = db.selectObject(
    "SELECT COUNT(*) AS n, COALESCE(SUM(listed_cents),0) AS cents FROM sales WHERE status = 'listed'",
  )!

  return {
    soldCount: sold.n as number,
    grossCents: sold.gross as number,
    costsCents: sold.costs as number,
    netCents: sold.net as number,
    realizedGainCents: gain.gain as number,
    // How many sold rows actually had a cost basis.
    gainKnownFor: gain.known as number,
    listedCount: listed.n as number,
    listedCents: listed.cents as number,
  }
}
