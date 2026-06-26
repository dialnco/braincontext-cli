import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { Command } from 'commander'
import { openStore } from '../core/db'
import { migrateToLatest } from '../core/migrate'
import { type DbOpts, globalDbPath, localDbPath } from '../core/paths'
import { dbOptsFrom } from './_shared'

function initPath(o: DbOpts): string {
  if (o.db) return o.db
  if (o.local) return localDbPath()
  return globalDbPath()
}

export function initCommand(): Command {
  return new Command('init')
    .description('Create and migrate the local braincontext SQLite store (idempotent).')
    .action(async (_opts, command: Command) => {
      const path = initPath(dbOptsFrom(command))
      mkdirSync(dirname(path), { recursive: true })
      const store = openStore({ mode: 'local', file: path })
      try {
        await store.prepare()
        await migrateToLatest(store.db, { lockFile: path })
      } finally {
        await store.close()
      }
      console.log(`Initialized braincontext store at ${path}`)
    })
}
