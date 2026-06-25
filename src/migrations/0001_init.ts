import { type Kysely, sql } from 'kysely'
import type { Migration } from 'kysely/migration'

/**
 * Initial schema: contexts + tags + FTS5 search + append-only history.
 * better-sqlite3 prepares a single statement at a time, so each DDL statement
 * is executed independently.
 */
export const migration: Migration = {
  async up(db: Kysely<any>): Promise<void> {
    await sql`
      CREATE TABLE contexts (
        id           TEXT PRIMARY KEY,
        namespace    TEXT NOT NULL DEFAULT 'global',
        title        TEXT,
        body         TEXT NOT NULL,
        kind         TEXT NOT NULL DEFAULT 'note'
                       CHECK (kind IN ('note','rule','snippet','decision','skill')),
        scope        TEXT NOT NULL DEFAULT 'project'
                       CHECK (scope IN ('global','user','project','local')),
        agent_source TEXT,
        metadata     TEXT NOT NULL DEFAULT '{}',
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        deleted_at   TEXT
      )
    `.execute(db)

    await sql`CREATE INDEX idx_contexts_namespace ON contexts(namespace)`.execute(db)
    await sql`CREATE INDEX idx_contexts_kind ON contexts(kind)`.execute(db)
    await sql`CREATE INDEX idx_contexts_scope ON contexts(scope)`.execute(db)
    await sql`CREATE INDEX idx_contexts_deleted_at ON contexts(deleted_at)`.execute(db)

    await sql`
      CREATE TABLE tags (
        id   INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE
      )
    `.execute(db)

    await sql`
      CREATE TABLE context_tags (
        context_id TEXT NOT NULL REFERENCES contexts(id) ON DELETE CASCADE,
        tag_id     INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        PRIMARY KEY (context_id, tag_id)
      )
    `.execute(db)

    await sql`
      CREATE TABLE context_history (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        context_id   TEXT NOT NULL,
        event        TEXT NOT NULL CHECK (event IN ('create','update','delete')),
        old_body     TEXT,
        new_body     TEXT,
        agent_source TEXT,
        changed_at   TEXT NOT NULL
      )
    `.execute(db)

    await sql`CREATE INDEX idx_history_context_id ON context_history(context_id)`.execute(db)

    // Reserved for v1.5 SKILL.md bundles; unused in v1.
    await sql`
      CREATE TABLE skill_files (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        context_id TEXT NOT NULL REFERENCES contexts(id) ON DELETE CASCADE,
        rel_path   TEXT NOT NULL,
        content    TEXT NOT NULL,
        is_binary  INTEGER NOT NULL DEFAULT 0
      )
    `.execute(db)

    // Full-text search mirror over (title, body), external-content against contexts.rowid.
    await sql`
      CREATE VIRTUAL TABLE contexts_fts USING fts5(
        title,
        body,
        content='contexts',
        content_rowid='rowid'
      )
    `.execute(db)

    await sql`
      CREATE TRIGGER contexts_ai AFTER INSERT ON contexts BEGIN
        INSERT INTO contexts_fts(rowid, title, body)
        VALUES (new.rowid, coalesce(new.title,''), new.body);
      END
    `.execute(db)

    await sql`
      CREATE TRIGGER contexts_ad AFTER DELETE ON contexts BEGIN
        INSERT INTO contexts_fts(contexts_fts, rowid, title, body)
        VALUES ('delete', old.rowid, coalesce(old.title,''), old.body);
      END
    `.execute(db)

    await sql`
      CREATE TRIGGER contexts_au AFTER UPDATE ON contexts BEGIN
        INSERT INTO contexts_fts(contexts_fts, rowid, title, body)
        VALUES ('delete', old.rowid, coalesce(old.title,''), old.body);
        INSERT INTO contexts_fts(rowid, title, body)
        VALUES (new.rowid, coalesce(new.title,''), new.body);
      END
    `.execute(db)
  },

  async down(db: Kysely<any>): Promise<void> {
    await sql`DROP TRIGGER IF EXISTS contexts_au`.execute(db)
    await sql`DROP TRIGGER IF EXISTS contexts_ad`.execute(db)
    await sql`DROP TRIGGER IF EXISTS contexts_ai`.execute(db)
    await sql`DROP TABLE IF EXISTS contexts_fts`.execute(db)
    await sql`DROP TABLE IF EXISTS skill_files`.execute(db)
    await sql`DROP TABLE IF EXISTS context_history`.execute(db)
    await sql`DROP TABLE IF EXISTS context_tags`.execute(db)
    await sql`DROP TABLE IF EXISTS tags`.execute(db)
    await sql`DROP TABLE IF EXISTS contexts`.execute(db)
  },
}
