import { useEffect, useState } from 'react'

interface Health {
  status: string
  service: string
  time: string
}

// Minimal shape of a context row (full type lives in src/core/contexts.ts).
interface Ctx {
  id: string
  title: string | null
  body: string
  kind: string
  tags: string[]
}

/**
 * POC placeholder — NOT the real UI. It exists only to prove, end to end, that
 * the Vite build is served by `bctx studio` and can reach the same-origin JSON
 * API backed by the same SQLite store the CLI uses.
 */
export function App() {
  const [health, setHealth] = useState<Health | null>(null)
  const [contexts, setContexts] = useState<Ctx[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([
      fetch('/api/health').then((r) => r.json() as Promise<Health>),
      fetch('/api/contexts').then((r) => r.json() as Promise<Ctx[]>),
    ])
      .then(([h, c]) => {
        setHealth(h)
        setContexts(c)
      })
      .catch((e: unknown) => setError(String(e)))
  }, [])

  return (
    <main
      style={{
        fontFamily: 'system-ui, sans-serif',
        maxWidth: 820,
        margin: '0 auto',
        padding: 24,
        lineHeight: 1.5,
      }}
    >
      <h1>braincontext studio — build + serve POC</h1>
      <p>
        This placeholder proves the Vite build is served by <code>bctx studio</code> and can reach
        the same-origin API + DB. It is intentionally not the real UI.
      </p>
      {error && <p style={{ color: 'crimson' }}>failed to load: {error}</p>}
      <h2>/api/health</h2>
      <pre>{health ? JSON.stringify(health, null, 2) : 'loading…'}</pre>
      <h2>/api/contexts ({contexts?.length ?? 0})</h2>
      <pre>{contexts ? JSON.stringify(contexts, null, 2) : 'loading…'}</pre>
    </main>
  )
}
