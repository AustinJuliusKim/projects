import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Loading state for a fetched resource, with the distinction that matters:
 * **first load is not the same as a refetch.**
 *
 * A skeleton is right when there is nothing on screen yet — it reserves the
 * space the content will occupy, so nothing jumps when it arrives. It is wrong
 * on a refetch: the collection view refetches on every filter keystroke, sort
 * and page change, and swapping real rows for grey bars each time would flash
 * the whole page and lose the reader's place.
 *
 * So `showSkeleton` is true only while there is no data. Once there is, a
 * refetch keeps the previous render and callers dim it instead.
 */
export interface Resource<T> {
  data: T | null
  error: string | null
  /** A request is in flight, first or otherwise. */
  loading: boolean
  /** Nothing has ever loaded — reserve space rather than showing stale nothing. */
  showSkeleton: boolean
  /** Reloading over content that is already on screen. Dim, don't replace. */
  refetching: boolean
  reload: () => Promise<void>
  setData: (value: T) => void
}

export function useResource<T>(
  fetcher: () => Promise<T>,
  deps: unknown[] = [],
): Resource<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  // Guards against a slow first request resolving after a faster later one and
  // overwriting it — easy to hit when typing in the name filter.
  const sequence = useRef(0)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const run = useCallback(async () => {
    const ticket = ++sequence.current
    setLoading(true)
    try {
      const result = await fetcher()
      if (!alive.current || ticket !== sequence.current) return
      setData(result)
      setError(null)
    } catch (caught) {
      if (!alive.current || ticket !== sequence.current) return
      setError(caught instanceof Error ? caught.message : 'Something went wrong')
    } finally {
      if (alive.current && ticket === sequence.current) setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  useEffect(() => {
    void run()
  }, [run])

  return {
    data,
    error,
    loading,
    showSkeleton: loading && data === null,
    refetching: loading && data !== null,
    reload: run,
    setData: (value: T) => setData(value),
  }
}
