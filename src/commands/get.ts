import { Command } from 'commander'
import { getContext } from '../core/contexts'
import { withDb } from '../core/db'
import { formatContext } from '../lib/format'
import { dbOptsFrom } from './_shared'

export function getCommand(): Command {
  return new Command('get')
    .description('Fetch a single context by id.')
    .argument('<id>', 'context id (ULID)')
    .option('--json', 'output JSON')
    .action(async (id: string, opts, command: Command) => {
      const ctx = await withDb(dbOptsFrom(command), (db) => getContext(db, id))
      if (!ctx) {
        console.error(`No context found with id ${id}`)
        process.exitCode = 1
        return
      }
      console.log(opts.json ? JSON.stringify(ctx, null, 2) : formatContext(ctx))
    })
}
