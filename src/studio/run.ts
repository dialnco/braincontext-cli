import { existsSync } from 'node:fs'
import { serve } from '@hono/node-server'
import type { Hono } from 'hono'
import type { DbOpts } from '../core/paths'
import { resolveAccessKey } from '../core/registry'
import { isInteractive } from '../lib/ansi'
import { openInBrowser } from '../lib/open'
import { resolveStudioDir } from './assets'
import { renderStudioBanner } from './banner'
import { buildStudioApp } from './server'
import { createStoreManager } from './stores'

// localhost ONLY — /api reads AND writes store contents with no auth, so it must
// not be reachable from other machines. Never bind 0.0.0.0.
const HOST = '127.0.0.1'
const DEFAULT_PORT = 8420
const MAX_PORT_TRIES = 20

export interface StudioOpts extends DbOpts {
  port?: number
  /** Open the Studio UI in the default browser once serving (default true). */
  open?: boolean
}

/**
 * Run the Studio web server. Mirrors src/mcp/run.ts: holds ONE long-lived store
 * manager (which can switch projects at runtime), serves until signalled, and logs
 * only to stderr. For a replica, the libSQL client's syncInterval keeps it fresh.
 */
export async function runStudio(opts: StudioOpts): Promise<void> {
  const stores = await createStoreManager(opts)

  const staticDir = resolveStudioDir()
  if (!existsSync(staticDir)) {
    console.error(
      `bctx studio: built UI not found at ${staticDir} — the API will serve but the UI returns 503.`,
    )
    console.error('  Run `npm run build` first, or use `npm run studio:dev` for HMR development.')
  }
  // Adopt the key this machine already holds for the served project, so the person
  // who launched Studio is signed in as the identity their CLI uses rather than
  // being asked to paste a key into their own browser.
  const localKey = resolveAccessKey(stores.status().project ?? undefined)
  const app = buildStudioApp(stores, { staticDir, localKey })

  let closing = false
  const shutdown = async () => {
    if (closing) return
    closing = true
    try {
      await stores.close()
    } finally {
      process.exit(0)
    }
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  const port = await listen(app, opts.port ?? DEFAULT_PORT)
  const url = `http://${HOST}:${port}`
  const status = stores.status()
  const label = status.project
    ? `${status.project} (${status.mode}) — ${status.location}`
    : status.location
  console.error(renderStudioBanner({ url, storeLabel: label, host: HOST }))

  // Launch the UI in the default browser. Skipped for --no-open and for
  // non-interactive runs (pipes, CI) where popping a browser is unwanted.
  if (opts.open !== false && isInteractive) {
    openInBrowser(`${url}/`)
  }
}

/** Bind on HOST, incrementing the port on EADDRINUSE. Resolves the actual port. */
function listen(app: Hono, startPort: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const attempt = (port: number, left: number) => {
      const server = serve({ fetch: app.fetch, hostname: HOST, port }, (info) => resolve(info.port))
      server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && left > 0) {
          console.error(`bctx studio: port ${port} in use, trying ${port + 1}…`)
          attempt(port + 1, left - 1)
        } else {
          reject(err)
        }
      })
    }
    attempt(startPort, MAX_PORT_TRIES)
  })
}
