import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { serve } from '@hono/node-server'
import type { Hono } from 'hono'
import { openStore } from '../core/db'
import { migrateToLatest } from '../core/migrate'
import { type DbOpts, resolveTarget } from '../core/paths'
import { resolveStudioDir } from './assets'
import { buildStudioApp } from './server'

// localhost ONLY — /api returns store contents with no auth, so it must not be
// reachable from other machines. Never bind 0.0.0.0.
const HOST = '127.0.0.1'
const DEFAULT_PORT = 8420
const MAX_PORT_TRIES = 20

export interface StudioOpts extends DbOpts {
  port?: number
}

/**
 * Run the Studio web server. Mirrors src/mcp/run.ts: holds ONE long-lived store
 * (not `withDb`, which would destroy it), serves until signalled, and logs only
 * to stderr. For a replica, the libSQL client's syncInterval keeps it fresh.
 */
export async function runStudio(opts: StudioOpts): Promise<void> {
  const target = resolveTarget(opts)
  if (target.mode !== 'remote') mkdirSync(dirname(target.file), { recursive: true })
  const store = openStore(target)
  await store.prepare()
  if (!opts.noSync) await store.sync()
  await migrateToLatest(store.db, { lockFile: target.mode !== 'remote' ? target.file : undefined })

  const staticDir = resolveStudioDir()
  if (!existsSync(staticDir)) {
    console.error(
      `bctx studio: built UI not found at ${staticDir} — the API will serve but the UI returns 503.`,
    )
    console.error('  Run `pnpm build` first, or use `pnpm studio:dev` for HMR development.')
  }
  const app = buildStudioApp(store.db, { staticDir })

  let closing = false
  const shutdown = async () => {
    if (closing) return
    closing = true
    try {
      await store.close()
    } finally {
      process.exit(0)
    }
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  const port = await listen(app, opts.port ?? DEFAULT_PORT)
  const label = target.mode === 'remote' ? target.url : target.file
  console.error(`bctx studio: serving ${label}`)
  console.error(`  UI   http://${HOST}:${port}/`)
  console.error(`  API  http://${HOST}:${port}/api/health , /api/contexts`)
  console.error('  Ctrl-C to stop.')
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
