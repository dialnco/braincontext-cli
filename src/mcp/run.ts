import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { enableForeignKeys, openStore } from '../core/db'
import { migrateToLatest } from '../core/migrate'
import { type DbOpts, resolveTarget } from '../core/paths'
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
  await enableForeignKeys(store.db)
  await store.sync()
  await migrateToLatest(store.db)
  const server = buildServer(store.db)

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

  // stderr only — a single stray stdout write corrupts the JSON-RPC stream.
  const label = target.mode === 'remote' ? target.url : target.file
  console.error(`bctx mcp: serving ${label} over stdio. Ctrl-C to stop.`)
  await server.connect(new StdioServerTransport())
}
