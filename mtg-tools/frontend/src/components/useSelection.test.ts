import { describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useSelection } from './useSelection'
import type { Holding } from '../api/client'

const row = (id: number): Holding => ({
  id, title: `Card ${id}`, edition: 'DOM', setName: 'Dominaria',
  collectorNumber: String(id), rarity: 'rare', foil: false, quantity: 1,
  priceCents: 100, totalCents: 100, price: '$1.00', total: '$1.00',
  condition: 'near_mint', language: 'en', verdict: 'undecided',
})

const page = [row(1), row(2), row(3)]
const filters = { price_min: 10 }

describe('useSelection', () => {
  it('sends explicit ids for a manual pick', () => {
    const { result } = renderHook(() => useSelection(page, 400, filters))
    act(() => result.current.setPicked([page[0], page[1]]))

    expect(result.current.count).toBe(2)
    expect(result.current.toRequest()).toEqual({ ids: [1, 2] })
  })

  it('never materializes ids when the user means "everything matching"', () => {
    // The whole point: 400 rows match, but the request carries the filter, not
    // 400 ids, so the server re-resolves it.
    const { result } = renderHook(() => useSelection(page, 400, filters))
    act(() => result.current.setPicked(page))
    act(() => result.current.escalate())

    const request = result.current.toRequest()
    expect(request).toEqual({ selectAll: true, filters })
    expect(request.ids).toBeUndefined()
    expect(result.current.count).toBe(400)
  })

  it('only offers escalation when it would actually add rows', () => {
    const { result } = renderHook(() => useSelection(page, 400, filters))
    expect(result.current.canEscalate).toBe(false)   // nothing picked yet

    act(() => result.current.setPicked([page[0]]))
    expect(result.current.canEscalate).toBe(false)   // partial page

    act(() => result.current.setPicked(page))
    expect(result.current.canEscalate).toBe(true)    // full page, more beyond
  })

  it('does not offer escalation when the page is the whole result', () => {
    const { result } = renderHook(() => useSelection(page, 3, filters))
    act(() => result.current.setPicked(page))
    expect(result.current.canEscalate).toBe(false)
  })

  it('drops the escalation as soon as the user picks rows again', () => {
    const { result } = renderHook(() => useSelection(page, 400, filters))
    act(() => result.current.setPicked(page))
    act(() => result.current.escalate())
    expect(result.current.allMatching).toBe(true)

    act(() => result.current.setPicked([page[0]]))
    expect(result.current.allMatching).toBe(false)
    expect(result.current.toRequest()).toEqual({ ids: [1] })
  })

  it('can collapse back to the page without clearing the ticks', () => {
    const { result } = renderHook(() => useSelection(page, 400, filters))
    act(() => result.current.setPicked(page))
    act(() => result.current.escalate())
    act(() => result.current.collapseToPage())

    expect(result.current.count).toBe(3)
    expect(result.current.toRequest()).toEqual({ ids: [1, 2, 3] })
  })

  it('carries the current filters, not the ones at mount', () => {
    const { result, rerender } = renderHook(
      ({ f }) => useSelection(page, 400, f),
      { initialProps: { f: { price_min: 10 } as Record<string, number> } },
    )
    act(() => result.current.setPicked(page))
    act(() => result.current.escalate())
    rerender({ f: { price_min: 50 } })

    expect(result.current.toRequest()).toEqual({
      selectAll: true, filters: { price_min: 50 },
    })
  })

  it('clears everything', () => {
    const { result } = renderHook(() => useSelection(page, 400, filters))
    act(() => result.current.setPicked(page))
    act(() => result.current.escalate())
    act(() => result.current.clear())

    expect(result.current.count).toBe(0)
    expect(result.current.allMatching).toBe(false)
  })
})
