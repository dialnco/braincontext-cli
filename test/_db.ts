import SQLite from 'better-sqlite3'
import { Kysely, SqliteDialect } from 'kysely'
import { migrateToLatest } from '../src/core/migrate'
import type { Database } from '../src/core/types'

/** A migrated in-memory database for tests. */
export async function freshDb(): Promise<Kysely<Database>> {
  const sqlite = new SQLite(':memory:')
  sqlite.pragma('foreign_keys = ON')
  const db = new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) })
  await migrateToLatest(db)
  return db
}
