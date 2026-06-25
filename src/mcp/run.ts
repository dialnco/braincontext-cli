import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { openDb } from '../core/db'
import { migrateToLatest } from '../core/migrate'
import { type DbOpts, resolveDbPath } from '../core/paths'
import { buildServer } from './server'

/**
 * Run the MCP stdio server. Holds ONE long-lived db connection (not `withDb`,
 * which would destroy it), connects the transport, and never exits on its own.
 * stdout is reserved for the MCP protocol — all diagnostics go to stderr.
 */
export async function runMcpStdio(opts: DbOpts): Promise<void> {
  const path = resolveDbPath(opts)
  mkdirSync(dirname(path), { recursive: true })
  const db = openDb(path)
  await migrateToLatest(db)
  const server = buildServer(db)

  let closing = false
  const shutdown = async () => {
    if (closing) return
    closing = true
    try {
      await db.destroy()
    } finally {
      process.exit(0)
    }
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // stderr only — a single stray stdout write corrupts the JSON-RPC stream.
  console.error(`bctx mcp: serving ${path} over stdio. Ctrl-C to stop.`)
  await server.connect(new StdioServerTransport())
}
