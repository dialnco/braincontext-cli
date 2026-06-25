import type { Kysely } from 'kysely'
import { Migrator } from 'kysely/migration'
import { migration as init0001 } from '../migrations/0001_init'
import type { Database } from './types'

/**
 * Migrations are registered in code (not scanned from disk) so they survive
 * bundling into a single dist/cli.js file. Add new entries in name order.
 */
export async function migrateToLatest(db: Kysely<Database>): Promise<void> {
  const migrator = new Migrator({
    db,
    provider: {
      async getMigrations() {
        return {
          '0001_init': init0001,
        }
      },
    },
  })

  const { error } = await migrator.migrateToLatest()
  if (error) throw error
}
