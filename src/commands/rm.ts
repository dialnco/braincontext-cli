import { Command } from 'commander'
import { deleteContext } from '../core/contexts'
import { withDb } from '../core/db'
import { dbOptsFrom, requireContext } from './_shared'

export function rmCommand(): Command {
  return new Command('rm')
    .description('Delete a context. Soft-delete by default; --hard removes it permanently.')
    .argument('<id>', 'context id (ULID)')
    .option('--hard', 'permanently delete instead of soft-delete')
    .option('--agent <name>', 'agent source label for this change')
    .action(async (id: string, opts, command: Command) => {
      const ok = await withDb(dbOptsFrom(command), async (db) => {
        if (!(await requireContext(db, id))) return false
        return deleteContext(db, id, { hard: Boolean(opts.hard), agentSource: opts.agent ?? null })
      })
      if (!ok) {
        console.error(`No context found with id ${id}`)
        process.exitCode = 1
        return
      }
      console.log(`${opts.hard ? 'Hard-deleted' : 'Soft-deleted'} ${id}`)
    })
}
