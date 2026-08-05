import { type Kysely, sql } from 'kysely'
import type { Migration } from 'kysely/migration'

/**
 * Project access control: named users (`principals`), the hashed keys they
 * authenticate with (`principal_keys`), and an append-only decision log
 * (`access_log`).
 *
 * The feature is OFF until `store_config['access.enabled']` is set, so applying
 * this migration alone changes no behavior — see core/access/session.ts.
 *
 * Enforcement is advisory: the remote is a libSQL primary that clients sync
 * against directly, so anyone holding the raw libSQL token can bypass these
 * tables with any SQLite client. They give roles, attribution, audit, and
 * revocation across the bctx surfaces — not a boundary against a member who
 * sets out to defeat them.
 *
 * Ships as its own incremental migration (see 0002's note): editing 0001 would
 * never reach an already-migrated store. All DDL is idempotent to tolerate
 * remote/replica re-runs.
 */
export const migration: Migration = {
  async up(db: Kysely<any>): Promise<void> {
    // --- principals: one row per human/agent identity on this project --------
    await sql`
      CREATE TABLE IF NOT EXISTS principals (
        id           TEXT PRIMARY KEY,
        handle       TEXT NOT NULL,
        display_name TEXT,
        role         TEXT NOT NULL DEFAULT 'reader'
                       CHECK (role IN ('owner','admin','writer','reader')),
        capabilities TEXT,
        status       TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active','disabled')),
        created_at   TEXT NOT NULL,
        created_by   TEXT,
        updated_at   TEXT NOT NULL
      )
    `.execute(db)
    // Handles are compared case-insensitively, so uniqueness must be too.
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_principals_handle
              ON principals(lower(handle))`.execute(db)
    await sql`CREATE INDEX IF NOT EXISTS idx_principals_role ON principals(role)`.execute(db)

    // --- principal_keys: the secrets, stored only as scrypt hashes -----------
    // `prefix` is the PUBLIC half of a key (`bctxk.<prefix>.<secret>`): it makes
    // verification a single indexed lookup instead of a scan-and-hash over every
    // row, and it is what listings show. `secret_hash` is a PHC-style string, so
    // the KDF parameters can change without a migration.
    await sql`
      CREATE TABLE IF NOT EXISTS principal_keys (
        id           TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
        label        TEXT,
        prefix       TEXT NOT NULL UNIQUE,
        secret_hash  TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        expires_at   TEXT,
        last_used_at TEXT,
        revoked_at   TEXT,
        created_by   TEXT
      )
    `.execute(db)
    await sql`CREATE INDEX IF NOT EXISTS idx_principal_keys_principal
              ON principal_keys(principal_id)`.execute(db)

    // --- access_log: append-only allow/deny decisions ------------------------
    // `principal_id` is deliberately NOT a foreign key and `handle` is
    // denormalized: the log must outlive the user it describes (deleting a
    // compromised account must not erase what that account did).
    await sql`
      CREATE TABLE IF NOT EXISTS access_log (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        at           TEXT NOT NULL,
        principal_id TEXT,
        handle       TEXT,
        agent_source TEXT,
        surface      TEXT NOT NULL,
        action       TEXT NOT NULL,
        target_type  TEXT,
        target_id    TEXT,
        decision     TEXT NOT NULL CHECK (decision IN ('allow','deny')),
        detail       TEXT
      )
    `.execute(db)
    await sql`CREATE INDEX IF NOT EXISTS idx_access_log_at ON access_log(at)`.execute(db)
    await sql`CREATE INDEX IF NOT EXISTS idx_access_log_principal
              ON access_log(principal_id)`.execute(db)
    await sql`CREATE INDEX IF NOT EXISTS idx_access_log_decision
              ON access_log(decision)`.execute(db)

    // --- attribution on the rows themselves ---------------------------------
    // Nullable: rows written before access control (or with it disabled) keep
    // NULL, and `agent_source` stays exactly what it was — this adds identity
    // alongside the tool label, it does not redefine it.
    await addColumn(db, 'contexts', 'principal_id')
    await addColumn(db, 'context_history', 'principal_id')
    await addColumn(db, 'files', 'principal_id')
  },

  async down(db: Kysely<any>): Promise<void> {
    // The added columns are left in place: SQLite's DROP COLUMN is unavailable on
    // older engines and rebuilding `contexts` would take its FTS triggers with it.
    // A nullable, unread column is harmless; the tables below are the real state.
    for (const stmt of [
      'DROP TABLE IF EXISTS access_log',
      'DROP TABLE IF EXISTS principal_keys',
      'DROP TABLE IF EXISTS principals',
    ]) {
      await sql.raw(stmt).execute(db)
    }
  },
}

/**
 * `ALTER TABLE … ADD COLUMN`, made idempotent. SQLite has no `IF NOT EXISTS` for
 * columns, and this migration can run twice against one remote primary (two
 * replicas bootstrapping at once — see core/migrate.ts), so we both pre-check
 * and tolerate the racing duplicate.
 */
async function addColumn(db: Kysely<any>, table: string, column: string): Promise<void> {
  const info = await sql<{ name: string }>`SELECT name FROM pragma_table_info(${table})`.execute(db)
  if (info.rows.some((r) => r.name === column)) return
  try {
    await sql.raw(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`).execute(db)
  } catch (e) {
    const msg = String((e as { message?: string })?.message ?? e)
    if (!/duplicate column name/i.test(msg)) throw e
  }
}
