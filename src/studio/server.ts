import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import { Hono, type MiddlewareHandler } from 'hono'
import type { StoreFactory } from '../core/storage/s3'
import { accessGuard, createStudioSessions } from './access'
import { accessRoutes } from './routes/access'
import { authRoutes } from './routes/auth'
import { contextsRoutes } from './routes/contexts'
import { exportRoutes } from './routes/export'
import { filesRoutes } from './routes/files'
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
  /** Object-store factory override so tests can fake S3/R2 (defaults to the real client). */
  filesStoreFactory?: StoreFactory
  /**
   * This machine's access key for the served project. Requests without a session
   * cookie adopt it, so the person who ran `bctx studio` is already signed in as
   * the identity their CLI uses. Omit it to require an explicit browser login.
   */
  localKey?: string | null
}

// Loopback host names. The server binds 127.0.0.1, but that alone does not stop a
// *browser* the user is running from reaching the API, so we also gate on Host/Origin.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** Extract the host (sans port) from a `Host` header value, keeping IPv6 brackets. */
function hostWithoutPort(h: string): string {
  if (h.startsWith('[')) {
    const end = h.indexOf(']')
    return end === -1 ? h : h.slice(0, end + 1)
  }
  const colon = h.indexOf(':')
  return colon === -1 ? h : h.slice(0, colon)
}

/** Hostname of an Origin/Referer URL (keeps IPv6 brackets), or null if unparseable. */
function originHostname(value: string): string | null {
  try {
    return new URL(value).hostname
  } catch {
    return null
  }
}

/**
 * Reject browser-origin attacks against the no-auth localhost API:
 *  - **DNS rebinding** (read exfiltration): a page that rebinds its own hostname to
 *    127.0.0.1 still sends `Host: attacker.com`, so requiring a loopback Host blocks it.
 *  - **CSRF** (blind writes): a cross-site fetch — including the `text/plain` "simple
 *    request" that needs no preflight — always carries a non-loopback `Origin`, so
 *    requiring a loopback Origin/Referer on unsafe methods blocks store poisoning.
 * Same-origin SPA traffic (Host/Origin = 127.0.0.1:<port>) and native clients with no
 * Origin pass through. Applied before every route.
 */
const localOnlyGuard: MiddlewareHandler = async (c, next) => {
  const host = c.req.header('host')
  if (host && !LOOPBACK_HOSTS.has(hostWithoutPort(host))) {
    return c.json({ error: 'forbidden host' }, 403)
  }
  if (UNSAFE_METHODS.has(c.req.method)) {
    const originRaw = c.req.header('origin') ?? c.req.header('referer')
    if (originRaw) {
      const oh = originHostname(originRaw)
      if (!oh || !LOOPBACK_HOSTS.has(oh)) {
        return c.json({ error: 'cross-origin request forbidden' }, 403)
      }
    }
  }
  await next()
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

  // Block DNS-rebinding reads + CSRF writes before anything else (see localOnlyGuard).
  app.use('*', localOnlyGuard)

  // Bracket data requests so a project switch quiesces before closing the old store. The
  // switch/sync routes (/api/project*) are excluded — counting them would deadlock the drain.
  app.use('/api/*', async (c, next) => {
    if (c.req.path.startsWith('/api/project')) return next()
    provider.enter()
    try {
      await next()
    } finally {
      provider.leave()
    }
  })

  // Identity + capability check. After localOnlyGuard (so the request has already
  // passed the rebinding/CSRF checks) and before every route. A project without
  // access control falls straight through, unchanged.
  const sessions = createStudioSessions()
  app.use('/api/*', accessGuard({ provider, sessions, localKey: opts.localKey }))

  // --- read/write JSON API (same-origin) ---
  app.route('/api', healthRoutes(provider))
  app.route('/api', authRoutes(provider, sessions, { localKey: opts.localKey }))
  app.route('/api', projectsRoutes(provider))
  app.route('/api/access', accessRoutes(provider))
  app.route('/api/contexts', contextsRoutes(provider))
  app.route('/api/wiki', wikiRoutes(provider))
  app.route('/api/tags', tagsRoutes(provider))
  app.route('/api/export', exportRoutes(provider))
  app.route('/api/files', filesRoutes(provider, opts.filesStoreFactory))
  // Keep the API namespace honest: an unknown /api/* is a JSON 404, never the SPA shell.
  app.all('/api/*', (c) => c.json({ error: 'not found' }, 404))

  // --- static SPA with history fallback for client-side routes ---
  app.get('*', async (c) => {
    let urlPath: string
    try {
      urlPath = decodeURIComponent(c.req.path)
    } catch {
      return c.text('bad request', 400) // malformed percent-encoding — don't 500
    }
    const hit = await tryFile(root, urlPath)
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
