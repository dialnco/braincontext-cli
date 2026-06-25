import { type Kysely, sql } from 'kysely'
import type { Migration } from 'kysely/migration'

/**
 * Re-shape `skill_files` for faithful SKILL.md bundles: store sidecar bytes as a
 * BLOB (binaries in assets/) and track the executable bit (chmod +x scripts/).
 * The table is empty in every store (skills were unused in v1), so a drop+create
 * is safe and loses no data.
 */
export const migration: Migration = {
  async up(db: Kysely<any>): Promise<void> {
    await sql`DROP TABLE IF EXISTS skill_files`.execute(db)
    await sql`
      CREATE TABLE skill_files (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        context_id    TEXT NOT NULL REFERENCES contexts(id) ON DELETE CASCADE,
        rel_path      TEXT NOT NULL,
        content       BLOB NOT NULL,
        is_executable INTEGER NOT NULL DEFAULT 0
      )
    `.execute(db)
    await sql`CREATE INDEX idx_skill_files_context_id ON skill_files(context_id)`.execute(db)
  },

  async down(db: Kysely<any>): Promise<void> {
    await sql`DROP INDEX IF EXISTS idx_skill_files_context_id`.execute(db)
    await sql`DROP TABLE IF EXISTS skill_files`.execute(db)
    await sql`
      CREATE TABLE skill_files (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        context_id TEXT NOT NULL REFERENCES contexts(id) ON DELETE CASCADE,
        rel_path   TEXT NOT NULL,
        content    TEXT NOT NULL,
        is_binary  INTEGER NOT NULL DEFAULT 0
      )
    `.execute(db)
  },
}
