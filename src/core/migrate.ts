import { type Kysely, sql } from 'kysely'
import { Migrator } from 'kysely/migration'
import { migration as init0001 } from '../migrations/0001_init'
import { migration as pageProps0002 } from '../migrations/0002_page_properties'
import { migration as files0003 } from '../migrations/0003_file_storage'
import { withFileLock } from './lock'
import type { Database } from './types'

// Ordered by key: the Migrator applies any not-yet-recorded migration in name order, so an
// existing store at 0001 gets only 0002, and a fresh store gets 0001 then 0002.
const MIGRATIONS = {
  '0001_init': init0001,
  '0002_page_properties': pageProps0002,
  '0003_file_storage': files0003,
} as const
const LATEST = '0003_file_storage'

/** True if the latest migration is already recorded (fast path: no lock, no migrator). */
async function isCurrent(db: Kysely<Database>): Promise<boolean> {
  try {
    const r = await sql<{
      name: string
    }>`SELECT name FROM kysely_migration WHERE name = ${LATEST}`.execute(db)
    return r.rows.length > 0
  } catch {
    return false // kysely_migration doesn't exist yet → not migrated
  }
}

/** Concurrent first-run migrators collide on non-lock DDL / the migration-history insert. */
function isBenignMigrationRace(error: unknown): boolean {
  const msg = String((error as { message?: string })?.message ?? error)
  return /already exists|UNIQUE constraint|SQLITE_CONSTRAINT/i.test(msg)
}

/**
 * Migrate to the latest schema, safely under concurrency.
 *
 * Migrations are registered in code (not scanned from disk) so they survive
 * bundling into a single dist/cli.js. Concurrency: Kysely's migration lock is a
 * no-op on SQLite/libSQL, so N processes hitting a fresh file would each run the
 * DDL and the second would crash ("table already exists"). We guard with:
 *  1. a fast `isCurrent` pre-check so steady-state commands skip the migrator;
 *  2. a cross-process file lock (when `lockFile` is given) so only one process
 *     migrates at a time on a local file;
 *  3. tolerance of benign races (for remote, where no shared lockfile exists) —
 *     a collision is fine as long as the schema ends up current.
 */
export async function migrateToLatest(
  db: Kysely<Database>,
  opts: { lockFile?: string } = {},
): Promise<void> {
  if (await isCurrent(db)) return

  const run = async (): Promise<void> => {
    if (await isCurrent(db)) return // re-check inside the lock
    const migrator = new Migrator({
      db,
      provider: { getMigrations: async () => ({ ...MIGRATIONS }) },
    })
    const { error } = await migrator.migrateToLatest()
    if (error) {
      // A racing migrator may have already applied it; only rethrow if truly not current.
      if (!isBenignMigrationRace(error) || !(await isCurrent(db))) throw error
    }
  }

  if (opts.lockFile) await withFileLock(`${opts.lockFile}.migrate.lock`, run)
  else await run()
}
