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
  const prev = writeChains.get(db) ?? Promise.resolve()
  // Run after the previous write settles (whether it resolved or rejected).
  const result = prev.then(
    () => attempt(db, fn, maxAttempts),
    () => attempt(db, fn, maxAttempts),
  )
  // Keep a non-rejecting tail on the chain so one failed write can't poison the next.
  writeChains.set(
    db,
    result.then(
      () => undefined,
      () => undefined,
    ),
  )
  return result
}
