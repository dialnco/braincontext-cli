import { useCallback, useEffect, useState } from 'react'
import { ApiError } from '../api/client'

export interface AsyncState<T> {
  data: T | undefined
  loading: boolean
  error: string | null
  reload: () => void
}

/**
 * Run an async fetch, re-running when `deps` change. Guards against out-of-order
 * resolution (only the latest call may set state). `reload` forces a refetch.
 */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [data, setData] = useState<T | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  const reload = useCallback(() => setNonce((n) => n + 1), [])

  // `fn` is intentionally excluded: it's a fresh closure each render, so the caller
  // controls re-fetching via the explicit `deps` array (plus `nonce` for reload()).
  // biome-ignore lint/correctness/useExhaustiveDependencies: caller-supplied deps drive refetch
  useEffect(() => {
    let live = true
    setLoading(true)
    setError(null)
    fn()
      .then((d) => {
        if (live) {
          setData(d)
          setLoading(false)
        }
      })
      .catch((e) => {
        if (live) {
          setError(e instanceof ApiError ? e.message : String(e))
          setLoading(false)
        }
      })
    return () => {
      live = false
    }
  }, [...deps, nonce])

  return { data, loading, error, reload }
}
