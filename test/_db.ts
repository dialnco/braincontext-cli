import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@libsql/client'
import { type Kysely, sql } from 'kysely'
import { kyselyFor } from '../src/core/db'
import { migrateToLatest } from '../src/core/migrate'
import type { Database } from '../src/core/types'

/**
 * A migrated libSQL database for tests, backed by a unique temp file.
 *
 * Not `:memory:`: the libSQL client recreates its underlying connection after each
 * transaction (it nulls the handle so a fresh one is opened lazily). For a file that
 * reopens the same data; for `:memory:` it would be a brand-new empty database, so
 * everything written before the first transaction would vanish. A temp file is the
 * faithful local-mode analogue and exercises the real code path.
 */
export async function freshDb(): Promise<Kysely<Database>> {
  const dir = mkdtempSync(join(tmpdir(), 'bctx-test-'))
  const client = createClient({ url: `file:${join(dir, 'test.db')}` })
  const db = kyselyFor(client)
  await sql`PRAGMA foreign_keys = ON`.execute(db)
  await migrateToLatest(db)
  return db
}
