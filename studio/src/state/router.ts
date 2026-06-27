import { useCallback, useEffect, useState } from 'react'

/**
 * A tiny hash router (no dependency). The studio server already does history
 * fallback, but hash routing keeps deep links working without any server route
 * config and survives the static-file serving cleanly. Routes:
 *   #/                     → wiki home
 *   #/page/<id>            → a wiki page
 *   #/graph                → graph overlay view
 *   #/contexts             → contexts tab
 *   #/contexts/<id>        → a context
 */
export interface Route {
  /** Path segments after the leading '#/', e.g. ['page','01H…']. */
  parts: string[]
  /** The raw hash path (without the leading '#'), e.g. '/page/01H…'. */
  path: string
}

function parse(): Route {
  const raw = window.location.hash.replace(/^#/, '') || '/'
  const path = raw.startsWith('/') ? raw : `/${raw}`
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent)
  return { parts, path }
}

export function navigate(to: string): void {
  // Accept either a path ('/page/x') or an href ('#/page/x') — strip a leading '#'
  // so callers can pass pageHref() without producing a double-hash ('#/#/page/x').
  const path = to.replace(/^#/, '')
  const next = path.startsWith('/') ? path : `/${path}`
  if (window.location.hash !== `#${next}`) window.location.hash = next
}

export function pageHref(id: string): string {
  return `#/page/${encodeURIComponent(id)}`
}

export function useRoute(): Route & { navigate: typeof navigate } {
  const [route, setRoute] = useState<Route>(parse)
  useEffect(() => {
    const onHash = () => setRoute(parse())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  const nav = useCallback((p: string) => navigate(p), [])
  return { ...route, navigate: nav }
}
