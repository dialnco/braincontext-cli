import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createSessionResolver } from '../core/access/cache'
import { restrictForSession } from '../core/access/gate'
import { describeFailure } from '../core/access/session'
import { openStore } from '../core/db'
import { migrateToLatest } from '../core/migrate'
import { type DbOpts, resolveTarget } from '../core/paths'
import { resolveAccessKey } from '../core/registry'
import { buildServer } from './server'

/**
 * Run the MCP stdio server. Holds ONE long-lived store (not `withDb`, which would
 * destroy it), connects the transport, and never exits on its own. For a replica,
 * the libSQL client's `syncInterval` keeps it fresh in the background. stdout is
 * reserved for the MCP protocol — all diagnostics go to stderr.
 */
export async function runMcpStdio(opts: DbOpts): Promise<void> {
  const target = resolveTarget(opts)
  if (target.mode !== 'remote') mkdirSync(dirname(target.file), { recursive: true })
  const store = openStore(target)
  await store.prepare()
  await store.sync()
  await migrateToLatest(store.db, { lockFile: target.mode !== 'remote' ? target.file : undefined })

  // Authenticate once, here, so tool handlers can close over a handle that already
  // reflects the identity (a reader gets one that physically refuses writes). The
  // resolver re-verifies on a short TTL, so a revoked key stops working without
  // paying for a key hash on every tool call.
  const key = resolveAccessKey(target.project)
  const session = createSessionResolver(store.db, key)
  const initial = await session()
  const gatedDb = restrictForSession(
    store.db,
    initial.enabled && initial.ok ? initial.session : null,
  )
  const server = buildServer(gatedDb, { db: store.db, session })

  if (initial.enabled) {
    // stderr, so an agent operator can see why its tools are refusing. The server
    // still starts: every tool call then answers with the reason, which an agent
    // can relay, whereas refusing to boot usually shows up as a silent failure.
    console.error(
      initial.ok
        ? `bctx mcp: authenticated as ${initial.session.principal.handle} (${initial.session.principal.role}).`
        : `bctx mcp: NOT authenticated — ${describeFailure(initial.reason)}`,
    )
  }

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
  // Exit when the client disconnects (stdin EOF) — otherwise an orphaned server keeps the
  // embedded-replica write-lock and blocks the next session. shutdown() is idempotent.
  process.stdin.on('end', () => void shutdown())
  process.stdin.on('close', () => void shutdown())

  // stderr only — a single stray stdout write corrupts the JSON-RPC stream.
  const label = target.mode === 'remote' ? target.url : target.file
  console.error(`bctx mcp: serving ${label} over stdio. Ctrl-C to stop.`)
  await server.connect(new StdioServerTransport())
}
