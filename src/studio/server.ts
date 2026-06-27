import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import { Hono } from 'hono'
import type { Kysely } from 'kysely'
import { listContexts } from '../core/contexts'
import type { Database } from '../core/types'

// Exactly the extensions a Vite bundle emits. Correct Content-Type matters: a
// `type="module"` script is rejected by browsers under the wrong MIME.
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

export interface StudioAppOpts {
  /** Absolute path to the built SPA (dist/studio). Injected so tests can fake it. */
  staticDir: string
}

/**
 * The Studio HTTP surface as a pure Hono app: a tiny read-only JSON API plus the
 * static SPA with history fallback. Pure (no socket) so it can be exercised via
 * `app.request()` in tests, mirroring the MCP server's injected-transport pattern.
 */
export function buildStudioApp(db: Kysely<Database>, opts: StudioAppOpts): Hono {
  const app = new Hono()
  const root = opts.staticDir

  // --- read-only JSON API (same-origin) ---
  app.get('/api/health', (c) =>
    c.json({ status: 'ok', service: 'bctx-studio', time: new Date().toISOString() }),
  )
  app.get('/api/contexts', async (c) => c.json(await listContexts(db, { limit: 100 })))
  // Keep the API namespace honest: an unknown /api/* is a JSON 404, never the SPA shell.
  app.all('/api/*', (c) => c.json({ error: 'not found' }, 404))

  // --- static SPA with history fallback for client-side routes ---
  app.get('*', async (c) => {
    const hit = await tryFile(root, decodeURIComponent(c.req.path))
    if (hit) return c.body(hit.data, 200, { 'Content-Type': hit.type })
    const index = await tryFile(root, '/index.html')
    if (index) return c.body(index.data, 200, { 'Content-Type': index.type })
    return c.text('studio UI not built — run `pnpm build`', 503)
  })

  return app
}

async function tryFile(
  root: string,
  urlPath: string,
): Promise<{ data: ArrayBuffer; type: string } | null> {
  // Collapse `..`, then strip leading separators so the path can only join *under*
  // root; the startsWith check below is the backstop against any traversal escape.
  const rel = normalize(urlPath).replace(/^[./\\]+/, '')
  const abs = rel === '' ? join(root, 'index.html') : join(root, rel)
  if (abs !== root && !abs.startsWith(root + sep)) return null
  if (!existsSync(abs)) return null
  const buf = await readFile(abs)
  // Slice to an exactly-sized ArrayBuffer (Buffer pooling makes `.buffer` larger).
  const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  return { data, type: MIME[extname(abs)] ?? 'application/octet-stream' }
}
