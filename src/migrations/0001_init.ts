import { type Kysely, sql } from 'kysely'
import type { Migration } from 'kysely/migration'

/**
 * Single base migration for the whole schema (greenfield — no incremental
 * migrations; reset the DB to re-baseline). better-sqlite3 prepares one
 * statement at a time, so each DDL statement runs independently.
 *
 * Layers:
 *  - contexts (+ tags, FTS5, history)  — the v1 context store
 *  - skill_files                       — SKILL.md bundle sidecars (BLOB + exec bit)
 *  - page_type/slug on contexts + links + wiki_log — the wiki subsystem
 */
export const migration: Migration = {
  async up(db: Kysely<any>): Promise<void> {
    // --- contexts -----------------------------------------------------------
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
        page_type    TEXT,
        slug         TEXT,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        deleted_at   TEXT
      )
    `.execute(db)

    await sql`CREATE INDEX idx_contexts_namespace ON contexts(namespace)`.execute(db)
    await sql`CREATE INDEX idx_contexts_kind ON contexts(kind)`.execute(db)
    await sql`CREATE INDEX idx_contexts_scope ON contexts(scope)`.execute(db)
    await sql`CREATE INDEX idx_contexts_deleted_at ON contexts(deleted_at)`.execute(db)
    await sql`CREATE INDEX idx_contexts_page_type ON contexts(page_type)`.execute(db)
    // slug is unique only among wiki pages (where it is non-null)
    await sql`CREATE UNIQUE INDEX idx_contexts_slug ON contexts(slug) WHERE slug IS NOT NULL`.execute(
      db,
    )

    // --- tags ---------------------------------------------------------------
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

    // --- append-only audit of row mutations --------------------------------
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

    // --- SKILL.md bundle sidecars (BLOB + exec bit) ------------------------
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

    // --- wiki: typed links (the knowledge graph) ---------------------------
    // to_id NULL + to_title set => a "wanted/red link" (target page doesn't exist yet).
    await sql`
      CREATE TABLE links (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        from_id    TEXT NOT NULL REFERENCES contexts(id) ON DELETE CASCADE,
        to_id      TEXT REFERENCES contexts(id) ON DELETE CASCADE,
        to_title   TEXT,
        type       TEXT NOT NULL DEFAULT 'references',
        created_at TEXT NOT NULL,
        CHECK (to_id IS NULL OR from_id <> to_id)
      )
    `.execute(db)
    await sql`CREATE INDEX idx_links_from ON links(from_id)`.execute(db)
    await sql`CREATE INDEX idx_links_to ON links(to_id)`.execute(db)

    // --- wiki: operation log (ingest/query/maintenance) --------------------
    await sql`
      CREATE TABLE wiki_log (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        op           TEXT NOT NULL,
        ref_id       TEXT,
        title        TEXT,
        detail       TEXT,
        agent_source TEXT,
        created_at   TEXT NOT NULL
      )
    `.execute(db)

    // --- FTS5 mirror over (title, body), synced by triggers ----------------
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
    for (const stmt of [
      'DROP TRIGGER IF EXISTS contexts_au',
      'DROP TRIGGER IF EXISTS contexts_ad',
      'DROP TRIGGER IF EXISTS contexts_ai',
      'DROP TABLE IF EXISTS contexts_fts',
      'DROP TABLE IF EXISTS wiki_log',
      'DROP TABLE IF EXISTS links',
      'DROP TABLE IF EXISTS skill_files',
      'DROP TABLE IF EXISTS context_history',
      'DROP TABLE IF EXISTS context_tags',
      'DROP TABLE IF EXISTS tags',
      'DROP TABLE IF EXISTS contexts',
    ]) {
      await sql.raw(stmt).execute(db)
    }
  },
}
