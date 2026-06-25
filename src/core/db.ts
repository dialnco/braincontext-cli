import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import SQLite from 'better-sqlite3'
import { Kysely, SqliteDialect } from 'kysely'
import { migrateToLatest } from './migrate'
import { type DbOpts, resolveDbPath } from './paths'
import type { Database } from './types'

/** Open a Kysely instance over a better-sqlite3 file with sane local-first pragmas. */
export function openDb(path: string): Kysely<Database> {
  const sqlite = new SQLite(path)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  return new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) })
}

/**
 * Resolve the store path, ensure its directory exists, open it, run any pending
 * migrations (idempotent), run `fn`, then always close the connection.
 */
export async function withDb<T>(
  opts: DbOpts,
  fn: (db: Kysely<Database>) => Promise<T>,
): Promise<T> {
  const path = resolveDbPath(opts)
  mkdirSync(dirname(path), { recursive: true })
  const db = openDb(path)
  try {
    await migrateToLatest(db)
    return await fn(db)
  } finally {
    await db.destroy()
  }
}
