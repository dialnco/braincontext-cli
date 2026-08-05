import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { type Client, createClient } from '@libsql/client'
import { LibsqlDialect } from '@libsql/kysely-libsql'
import { Kysely, sql } from 'kysely'
import { enterGate } from './access/gate'
import { runWithSession, type SessionResult } from './access/session'
import { migrateToLatest } from './migrate'
import { type DbOpts, resolveTarget } from './paths'
import { resolveAccessKey } from './registry'
import type { Database } from './types'

/**
 * A resolved connection target. The whole local↔online story is expressed here:
 * - `local`   — a plain SQLite file (offline, single-machine).
 * - `replica` — a local SQLite file that is an *embedded replica* of a remote
 *               libSQL/Turso primary: reads are local, writes go to the primary,
 *               `sync()` pulls the latest frames down.
 * - `remote`  — a pure remote connection (no local file); used for the one-time
 *               seed during `migrate-online` and for fully-online usage.
 */
export type DbTarget =
  | { mode: 'local'; file: string; project?: string }
  | {
      mode: 'replica'
      file: string
      syncUrl: string
      authToken?: string
      syncInterval?: number
      project?: string
    }
  | { mode: 'remote'; url: string; authToken?: string; project?: string }

/**
 * Busy timeout (ms) for local `file:` databases. Passed as the libSQL client
 * `timeout` so it persists across the client's per-transaction reconnects (the
 * sqlite3 client drops and lazily reopens its connection on `transaction()`, so a
 * per-connection `PRAGMA busy_timeout` would NOT survive — the config value does).
 * Without it, concurrent writers fail instantly with SQLITE_BUSY instead of queuing.
 */
const BUSY_TIMEOUT_MS = 5000

export interface Store {
  db: Kysely<Database>
  client: Client
  /** Apply per-store pragmas (WAL for files + foreign_keys). Run once after open. */
  prepare(): Promise<void>
  /** Pull the latest frames from the primary. No-op unless this is a replica. */
  sync(): Promise<void>
  /** Tear down Kysely and close the underlying libSQL client. */
  close(): Promise<void>
}

function clientFor(t: DbTarget): Client {
  if (t.mode === 'local') return createClient({ url: `file:${t.file}`, timeout: BUSY_TIMEOUT_MS })
  if (t.mode === 'replica') {
    return createClient({
      url: `file:${t.file}`,
      syncUrl: t.syncUrl,
      authToken: t.authToken,
      syncInterval: t.syncInterval,
      timeout: BUSY_TIMEOUT_MS,
    })
  }
  return createClient({ url: t.url, authToken: t.authToken })
}

/**
 * Build a Kysely instance over a libSQL client.
 *
 * `@libsql/kysely-libsql` bundles an older `@libsql/core` whose `Client` type
 * differs from the modern `@libsql/client` we depend on (only `sync()`'s return
 * type — a value we discard). The structural shapes are otherwise identical and
 * runtime-compatible, so we bridge the one type-skew here, in a single place.
 */
export function kyselyFor(client: Client): Kysely<Database> {
  return new Kysely<Database>({ dialect: new LibsqlDialect({ client: client as never }) })
}

/**
 * Open a libSQL-backed Kysely instance for a resolved target. One driver covers
 * local files, embedded replicas, and remote connections — the mode is just the
 * shape of the URL/config, so "migrate to online" is a config change, not a swap.
 *
 * The caller owns the lifecycle: `db.destroy()` does NOT close a client we passed
 * in (the dialect only auto-closes clients it created), so `close()` does both.
 */
export function openStore(t: DbTarget): Store {
  const client = clientFor(t)
  const db = kyselyFor(client)
  const isFile = t.mode !== 'remote'
  return {
    db,
    client,
    prepare: async () => {
      // WAL lets readers proceed without blocking the single writer; it is a
      // file-header-persistent mode, so setting it once sticks across reconnects.
      if (isFile) await sql`PRAGMA journal_mode = WAL`.execute(db)
      // libSQL defaults foreign_keys OFF — enforce referential integrity.
      await sql`PRAGMA foreign_keys = ON`.execute(db)
    },
    sync: async () => {
      if (t.mode === 'replica') await client.sync()
    },
    close: async () => {
      await db.destroy()
      client.close()
    },
  }
}

/**
 * SQLite `PRAGMA data_version` — increments (as seen by this connection) whenever
 * ANOTHER connection commits to the same database file. Near-zero cost; the studio
 * polls it to notice agent/CLI writes. Note the counter is per-connection state, so
 * a recycled connection may report a fresh baseline — callers must treat any CHANGE
 * as "maybe modified" (a spurious refetch is cheap), never diff the magnitude.
 */
export async function dataVersion(db: Kysely<Database>): Promise<number> {
  const r = await sql<{ data_version: number }>`PRAGMA data_version`.execute(db)
  return Number(r.rows[0]?.data_version ?? 0)
}

/**
 * Resolve the connection target, ensure its directory exists, open it, freshen a
 * replica, run any pending migrations (idempotent), enforce access control, run
 * `fn`, settle the replica, then always close the connection.
 *
 * The access gate sits here — after migrations (its tables must exist) and before
 * `fn` — because this is the one path every CLI command's store access goes
 * through. `fn` receives the possibly read-only-wrapped handle plus the resolved
 * session, and runs inside `runWithSession` so writes downstream can attribute
 * themselves without threading an actor argument through core/.
 */
export async function withDb<T>(
  opts: DbOpts,
  fn: (db: Kysely<Database>, access: SessionResult) => Promise<T>,
): Promise<T> {
  const target = resolveTarget(opts)
  if (target.mode !== 'remote') mkdirSync(dirname(target.file), { recursive: true })
  const store = openStore(target)
  try {
    await store.prepare()
    if (!opts.noSync) await store.sync()
    await migrateToLatest(store.db, {
      lockFile: target.mode !== 'remote' ? target.file : undefined,
    })
    const gate = await enterGate(store.db, {
      key: resolveAccessKey(target.project),
      requires: opts.requires,
      action: opts.action ?? 'cli',
      surface: 'cli',
    })
    const result = await runWithSession(gate.session, () => fn(gate.db, gate.result))
    if (!opts.noSync) await store.sync()
    return result
  } finally {
    await store.close()
  }
}
