import type { Kysely, Transaction } from 'kysely'
import type { Database } from './types'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** True if an error is a transient SQLite lock/busy that retrying can resolve. */
export function isBusyError(e: unknown): boolean {
  const anyE = e as { code?: string; message?: string; cause?: { code?: string; message?: string } }
  const code = anyE?.code ?? anyE?.cause?.code ?? ''
  const msg = `${anyE?.message ?? ''} ${anyE?.cause?.message ?? ''}`
  return (
    code === 'SQLITE_BUSY' ||
    code === 'SQLITE_BUSY_SNAPSHOT' ||
    code === 'SQLITE_LOCKED' ||
    /SQLITE_BUSY|database is locked|database table is locked/i.test(msg)
  )
}

/**
 * Per-connection write serialization. A single process must never run two write
 * transactions against ONE connection concurrently: libSQL opens a fresh
 * connection per `transaction()` (it nulls its handle at BEGIN), so concurrent
 * in-process transactions become multiple connections to the same file — which
 * SQLite's same-process locking handles poorly (busy stalls, even lost updates).
 *
 * Chaining writes per Kysely instance keeps a process to one in-flight writer,
 * which is correct AND fast (no connection churn). Cross-PROCESS concurrency is
 * unaffected — separate processes have separate instances and coordinate via
 * busy_timeout + WAL. This matters most for the long-lived MCP connection, where
 * concurrent tool calls would otherwise collide on one connection.
 */
const writeChains = new WeakMap<object, Promise<unknown>>()

/**
 * Derived handle → the handle it was derived from. `db.withPlugin(...)` returns a
 * NEW Kysely instance over the SAME client, so keying the chain on the instance would
 * give a plugin-wrapped handle (a read-only principal writing to the inbox) its own
 * chain beside the raw handle's (audit rows) — two concurrent writers on one client,
 * exactly what the chain exists to prevent. Wrappers register here instead.
 */
const chainRoots = new WeakMap<object, object>()

/** Declare that `derived` shares `root`'s connection, so their writes serialize together. */
export function shareWriteChain(derived: object, root: object): void {
  chainRoots.set(derived, chainRoots.get(root) ?? root)
}

function chainKey(db: object): object {
  return chainRoots.get(db) ?? db
}

/**
 * Run an arbitrary write (e.g. a libSQL `client.batch`) in `db`'s write chain, with
 * the same busy/locked retry as {@link withWriteRetry}. For writes that do not go
 * through a Kysely transaction but must still never overlap one on this connection.
 */
export async function serializeWrite<T>(
  db: Kysely<Database>,
  fn: () => Promise<T>,
  maxAttempts = 10,
): Promise<T> {
  const run = async (): Promise<T> => {
    for (let n = 1; ; n++) {
      try {
        return await fn()
      } catch (e) {
        if (n >= maxAttempts || !isBusyError(e)) throw e
        const base = Math.min(200, 5 * 2 ** (n - 1))
        await sleep(base + Math.floor(Math.random() * base))
      }
    }
  }
  return chained(db, run)
}

function chained<T>(db: Kysely<Database>, run: () => Promise<T>): Promise<T> {
  const key = chainKey(db)
  const prev = writeChains.get(key) ?? Promise.resolve()
  // Run after the previous write settles (whether it resolved or rejected).
  const result = prev.then(run, run)
  // Keep a non-rejecting tail on the chain so one failed write can't poison the next.
  writeChains.set(
    key,
    result.then(
      () => undefined,
      () => undefined,
    ),
  )
  return result
}

async function attempt<T>(
  db: Kysely<Database>,
  fn: (trx: Transaction<Database>) => Promise<T>,
  maxAttempts: number,
): Promise<T> {
  for (let n = 1; ; n++) {
    try {
      return await db.transaction().execute(fn)
    } catch (e) {
      if (n >= maxAttempts || !isBusyError(e)) throw e
      const base = Math.min(200, 5 * 2 ** (n - 1))
      await sleep(base + Math.floor(Math.random() * base))
    }
  }
}

/**
 * Run a write transaction. Writes against the same connection are serialized (see
 * above); a transient busy/locked error is retried with capped backoff + jitter.
 * Transactions are `BEGIN IMMEDIATE` (the libSQL default), so the write lock is
 * held from BEGIN — a reader-to-writer upgrade deadlock can't occur.
 */
export async function withWriteRetry<T>(
  db: Kysely<Database>,
  fn: (trx: Transaction<Database>) => Promise<T>,
  maxAttempts = 10,
): Promise<T> {
  return chained(db, () => attempt(db, fn, maxAttempts))
}
