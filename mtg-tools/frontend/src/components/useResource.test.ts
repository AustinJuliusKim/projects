import { describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useResource } from './useResource'

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('useResource', () => {
  it('shows a skeleton only before anything has loaded', async () => {
    const first = deferred<string>()
    const { result } = renderHook(() => useResource(() => first.promise, []))

    expect(result.current.showSkeleton).toBe(true)
    expect(result.current.refetching).toBe(false)

    await act(async () => { first.resolve('data') })
    expect(result.current.showSkeleton).toBe(false)
    expect(result.current.data).toBe('data')
  })

  it('refetches without falling back to a skeleton', async () => {
    // The reason this hook exists: swapping content for grey bars on every
    // filter keystroke would flash the page and lose the reader's place.
    let resolveNext: (v: string) => void = () => {}
    const fetcher = vi.fn(() => new Promise<string>((res) => { resolveNext = res }))
    const { result } = renderHook(() => useResource(fetcher, []))

    await act(async () => { resolveNext('first') })
    expect(result.current.data).toBe('first')

    let reload!: Promise<void>
    act(() => { reload = result.current.reload() })

    expect(result.current.showSkeleton).toBe(false)   // content stays
    expect(result.current.refetching).toBe(true)      // …dimmed instead
    expect(result.current.data).toBe('first')         // previous render held

    await act(async () => { resolveNext('second'); await reload })
    expect(result.current.data).toBe('second')
    expect(result.current.refetching).toBe(false)
  })

  it('ignores a slow response that lands after a newer one', async () => {
    // Easy to hit while typing in the name filter: request 1 resolves after
    // request 2 and would otherwise overwrite fresher results with stale ones.
    const slow = deferred<string>()
    const fast = deferred<string>()
    const calls = [slow, fast]
    let index = 0
    const { result } = renderHook(() =>
      useResource(() => calls[index++].promise, []),
    )

    let second!: Promise<void>
    act(() => { second = result.current.reload() })

    await act(async () => { fast.resolve('newer'); await second })
    expect(result.current.data).toBe('newer')

    await act(async () => { slow.resolve('older') })
    expect(result.current.data).toBe('newer')   // not clobbered
  })

  it('surfaces an error without wiping what is on screen', async () => {
    let settle: { resolve: (v: string) => void; reject: (e: unknown) => void }
    const fetcher = vi.fn(
      () => new Promise<string>((res, rej) => { settle = { resolve: res, reject: rej } }),
    )
    const { result } = renderHook(() => useResource(fetcher, []))

    await act(async () => { settle!.resolve('good') })
    expect(result.current.data).toBe('good')

    let reload!: Promise<void>
    act(() => { reload = result.current.reload() })
    await act(async () => { settle!.reject(new Error('network down')); await reload })

    expect(result.current.error).toBe('network down')
    expect(result.current.data).toBe('good')   // stale beats blank
    expect(result.current.showSkeleton).toBe(false)
  })

  it('clears a previous error on a successful reload', async () => {
    let settle: { resolve: (v: string) => void; reject: (e: unknown) => void }
    const { result } = renderHook(() =>
      useResource(
        () => new Promise<string>((res, rej) => { settle = { resolve: res, reject: rej } }),
        [],
      ),
    )

    await act(async () => { settle!.reject(new Error('boom')) })
    expect(result.current.error).toBe('boom')

    let reload!: Promise<void>
    act(() => { reload = result.current.reload() })
    await act(async () => { settle!.resolve('ok'); await reload })
    expect(result.current.error).toBeNull()
  })
})
