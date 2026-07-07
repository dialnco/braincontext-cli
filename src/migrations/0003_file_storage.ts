import { type Kysely, sql } from 'kysely'
import type { Migration } from 'kysely/migration'

/**
 * Add S3/R2-backed file storage: `store_config` (per-store key-value settings, including
 * the storage credentials so any client that opens this DB — local, replica, or remote —
 * can upload/read files) and `files` (metadata/references only; the blobs live exclusively
 * in the configured S3-compatible bucket, never in this database).
 *
 * Ships as its own incremental migration (see 0002's note): editing 0001 would never reach
 * an already-migrated store. All DDL is idempotent (`IF NOT EXISTS`) to tolerate
 * remote/replica re-runs.
 */
export const migration: Migration = {
  async up(db: Kysely<any>): Promise<void> {
    await sql`
      CREATE TABLE IF NOT EXISTS store_config (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `.execute(db)
    await sql`
      CREATE TABLE IF NOT EXISTS files (
        id           TEXT PRIMARY KEY,
        object_key   TEXT NOT NULL UNIQUE,
        filename     TEXT NOT NULL,
        mime         TEXT NOT NULL DEFAULT 'application/octet-stream',
        size         INTEGER NOT NULL,
        sha256       TEXT,
        agent_source TEXT,
        metadata     TEXT NOT NULL DEFAULT '{}',
        created_at   TEXT NOT NULL,
        deleted_at   TEXT
      )
    `.execute(db)
    await sql`CREATE INDEX IF NOT EXISTS idx_files_created ON files(created_at)`.execute(db)
    await sql`CREATE INDEX IF NOT EXISTS idx_files_deleted ON files(deleted_at)`.execute(db)
  },

  async down(db: Kysely<any>): Promise<void> {
    await sql.raw('DROP TABLE IF EXISTS files').execute(db)
    await sql.raw('DROP TABLE IF EXISTS store_config').execute(db)
  },
}
