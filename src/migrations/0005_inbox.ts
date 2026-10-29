import { type Kysely, sql } from 'kysely'
import type { Migration } from 'kysely/migration'

/**
 * The member-to-member inbox: threads (a question, task, or heads-up addressed to
 * one member or to the team pool), their append-only messages, and per-member read
 * markers. See core/inbox/.
 *
 * Its own tables rather than a new `contexts.kind`: an inbox item is workflow, not
 * knowledge, and must never surface in search, AGENTS.md exports, the wiki graph,
 * or skills.
 *
 * Ordering never trusts a client clock. `num` and `seq` are AUTOINCREMENT keys
 * assigned by whichever database executes the insert — for a replica that is the
 * shared primary, so they are one total order across every member's machine.
 *
 * Authors and assignees are denormalized (`*_handle`) with no foreign key to
 * `principals`, like `access_log`: a thread must outlive the user it mentions.
 * Lookups always go by principal id — a deleted user's handle can be reused.
 *
 * Ships as its own incremental migration; all DDL is idempotent for remote re-runs.
 */
export const migration: Migration = {
  async up(db: Kysely<any>): Promise<void> {
    await sql`
      CREATE TABLE IF NOT EXISTS inbox_threads (
        num                      INTEGER PRIMARY KEY AUTOINCREMENT,
        id                       TEXT NOT NULL UNIQUE,
        kind                     TEXT NOT NULL CHECK (kind IN ('ask','task','fyi')),
        title                    TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
        status                   TEXT NOT NULL DEFAULT 'open'
                                   CHECK (status IN ('open','in_progress','resolved','declined','cancelled')),
        urgent                   INTEGER NOT NULL DEFAULT 0,
        from_principal_id        TEXT NOT NULL,
        from_handle              TEXT NOT NULL,
        from_session             TEXT,
        assignee_principal_id    TEXT,
        assignee_handle          TEXT,
        claimed_session          TEXT,
        claimed_agent            TEXT,
        claimed_at               TEXT,
        resolution               TEXT,
        closed_by_principal_id   TEXT,
        closed_by_handle         TEXT,
        closed_at                TEXT,
        refs                     TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(refs)),
        last_seq                 INTEGER NOT NULL DEFAULT 0,
        last_author_principal_id TEXT,
        agent_turns              INTEGER NOT NULL DEFAULT 0,
        created_at               TEXT NOT NULL,
        updated_at               TEXT NOT NULL
      )
    `.execute(db)
    await sql`CREATE INDEX IF NOT EXISTS idx_inbox_threads_assignee
              ON inbox_threads(assignee_principal_id, status, last_seq)`.execute(db)
    await sql`CREATE INDEX IF NOT EXISTS idx_inbox_threads_from
              ON inbox_threads(from_principal_id, status, last_seq)`.execute(db)
    await sql`CREATE INDEX IF NOT EXISTS idx_inbox_threads_status
              ON inbox_threads(status, last_seq)`.execute(db)

    await sql`
      CREATE TABLE IF NOT EXISTS inbox_messages (
        seq                 INTEGER PRIMARY KEY AUTOINCREMENT,
        id                  TEXT NOT NULL UNIQUE,
        thread_id           TEXT NOT NULL REFERENCES inbox_threads(id),
        author_principal_id TEXT NOT NULL,
        author_handle       TEXT NOT NULL,
        author_session      TEXT,
        agent_source        TEXT,
        surface             TEXT NOT NULL CHECK (surface IN ('cli','mcp','studio')),
        by_agent            INTEGER NOT NULL DEFAULT 0,
        type                TEXT NOT NULL CHECK (type IN ('message','event')),
        event               TEXT,
        body                TEXT NOT NULL CHECK (length(CAST(body AS BLOB)) <= 32768),
        created_at          TEXT NOT NULL,
        CHECK ((type = 'event') = (event IS NOT NULL))
      )
    `.execute(db)
    await sql`CREATE INDEX IF NOT EXISTS idx_inbox_messages_thread
              ON inbox_messages(thread_id, seq)`.execute(db)
    await sql`CREATE INDEX IF NOT EXISTS idx_inbox_messages_author
              ON inbox_messages(author_principal_id, created_at)`.execute(db)

    // Read state lives apart from any notion of participation: reading a thread on
    // the shared board must never grant the right to act on it.
    await sql`
      CREATE TABLE IF NOT EXISTS inbox_reads (
        principal_id  TEXT NOT NULL,
        thread_id     TEXT NOT NULL,
        last_read_seq INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (principal_id, thread_id)
      )
    `.execute(db)
  },

  async down(db: Kysely<any>): Promise<void> {
    for (const stmt of [
      'DROP TABLE IF EXISTS inbox_reads',
      'DROP TABLE IF EXISTS inbox_messages',
      'DROP TABLE IF EXISTS inbox_threads',
    ]) {
      await sql.raw(stmt).execute(db)
    }
  },
}
