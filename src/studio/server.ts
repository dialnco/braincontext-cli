import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import { Hono } from 'hono'
import { contextsRoutes } from './routes/contexts'
import { exportRoutes } from './routes/export'
import { healthRoutes } from './routes/health'
import { projectsRoutes } from './routes/projects'
import { tagsRoutes } from './routes/tags'
import { wikiRoutes } from './routes/wiki'
import type { StoreProvider } from './stores'

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
 * The Studio HTTP surface as a pure Hono app: a same-origin JSON API (mounted from
 * the focused route modules in ./routes) plus the static SPA with history fallback.
 * The store is reached through a {@link StoreProvider} so a project switch swaps the
 * live db under every handler, and tests can inject a trivial in-memory provider
 * (mirroring the MCP server's injected-transport pattern).
 */
export function buildStudioApp(provider: StoreProvider, opts: StudioAppOpts): Hono {
  const app = new Hono()
  const root = opts.staticDir

  // --- read/write JSON API (same-origin) ---
  app.route('/api', healthRoutes())
  app.route('/api', projectsRoutes(provider))
  app.route('/api/contexts', contextsRoutes(provider))
  app.route('/api/wiki', wikiRoutes(provider))
  app.route('/api/tags', tagsRoutes(provider))
  app.route('/api/export', exportRoutes(provider))
  // Keep the API namespace honest: an unknown /api/* is a JSON 404, never the SPA shell.
  app.all('/api/*', (c) => c.json({ error: 'not found' }, 404))

  // --- static SPA with history fallback for client-side routes ---
  app.get('*', async (c) => {
    const hit = await tryFile(root, decodeURIComponent(c.req.path))
    if (hit) return c.body(hit.data, 200, { 'Content-Type': hit.type })
    const index = await tryFile(root, '/index.html')
    if (index) return c.body(index.data, 200, { 'Content-Type': index.type })
    return c.text('studio UI not built — run `npm run build`', 503)
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
