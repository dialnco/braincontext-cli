import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { type Client, createClient } from '@libsql/client'
import { LibsqlDialect } from '@libsql/kysely-libsql'
import { Kysely, sql } from 'kysely'
import { migrateToLatest } from './migrate'
import { type DbOpts, resolveTarget } from './paths'
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
  | { mode: 'local'; file: string }
  | { mode: 'replica'; file: string; syncUrl: string; authToken?: string; syncInterval?: number }
  | { mode: 'remote'; url: string; authToken?: string }

export interface Store {
  db: Kysely<Database>
  client: Client
  /** Pull the latest frames from the primary. No-op unless this is a replica. */
  sync(): Promise<void>
  /** Tear down Kysely and close the underlying libSQL client. */
  close(): Promise<void>
}

function clientFor(t: DbTarget): Client {
  if (t.mode === 'local') return createClient({ url: `file:${t.file}` })
  if (t.mode === 'replica') {
    return createClient({
      url: `file:${t.file}`,
      syncUrl: t.syncUrl,
      authToken: t.authToken,
      syncInterval: t.syncInterval,
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
  return {
    db,
    client,
    sync: async () => {
      if (t.mode === 'replica') await client.sync()
    },
    close: async () => {
      await db.destroy()
      client.close()
    },
  }
}

/** libSQL defaults `foreign_keys` OFF; enforce referential integrity per connection. */
export async function enableForeignKeys(db: Kysely<Database>): Promise<void> {
  await sql`PRAGMA foreign_keys = ON`.execute(db)
}

/**
 * Resolve the connection target, ensure its directory exists, open it, freshen a
 * replica, run any pending migrations (idempotent), run `fn`, settle the replica,
 * then always close the connection.
 */
export async function withDb<T>(
  opts: DbOpts,
  fn: (db: Kysely<Database>) => Promise<T>,
): Promise<T> {
  const target = resolveTarget(opts)
  if (target.mode !== 'remote') mkdirSync(dirname(target.file), { recursive: true })
  const store = openStore(target)
  try {
    await enableForeignKeys(store.db)
    if (!opts.noSync) await store.sync()
    await migrateToLatest(store.db)
    const result = await fn(store.db)
    if (!opts.noSync) await store.sync()
    return result
  } finally {
    await store.close()
  }
}
