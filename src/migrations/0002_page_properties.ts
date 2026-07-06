import { type Kysely, sql } from 'kysely'
import type { Migration } from 'kysely/migration'

/**
 * Add the derived `page_properties` mirror (typed scalar properties for `wiki query` / views).
 *
 * This is the FIRST incremental migration: the base schema (0001) is greenfield-reset, but a
 * store that already has real data can't be reset without losing it. Because migrations are
 * tracked by name, editing 0001 would never reach an already-migrated DB — so this new table
 * ships as its own migration, applied exactly once to existing stores and to fresh ones alike.
 *
 * The table is FULLY DERIVED from each page's `metadata.props` (rebuilt on every write by
 * `rebuildPageProperties`), so it starts empty and is safe to drop + rebuild at any time.
 * All DDL is idempotent (`IF NOT EXISTS`) to tolerate remote/replica re-runs, matching 0001.
 */
export const migration: Migration = {
  async up(db: Kysely<any>): Promise<void> {
    await sql`
      CREATE TABLE IF NOT EXISTS page_properties (
        context_id TEXT NOT NULL REFERENCES contexts(id) ON DELETE CASCADE,
        key        TEXT NOT NULL,
        value      TEXT,
        type       TEXT NOT NULL DEFAULT 'string',
        PRIMARY KEY (context_id, key)
      )
    `.execute(db)
    await sql`CREATE INDEX IF NOT EXISTS idx_page_properties_key ON page_properties(key, value)`.execute(
      db,
    )
  },

  async down(db: Kysely<any>): Promise<void> {
    await sql.raw('DROP TABLE IF EXISTS page_properties').execute(db)
  },
}
