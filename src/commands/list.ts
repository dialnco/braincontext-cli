import { Command } from 'commander'
import { z } from 'zod'
import { type ListFilters, listContexts } from '../core/contexts'
import { withDb } from '../core/db'
import { KINDS, SCOPES } from '../core/types'
import { formatList } from '../lib/format'
import { dbOptsFrom } from './_shared'

export function listCommand(): Command {
  return new Command('list')
    .description('List contexts, newest first, with optional filters.')
    .option('--namespace <ns>', 'filter by namespace')
    .option('--kind <kind>', `filter by kind: ${KINDS.join(' | ')}`)
    .option('--scope <scope>', `filter by scope: ${SCOPES.join(' | ')}`)
    .option('--tag <tag>', 'filter by tag')
    .option('--agent <name>', 'filter by agent source')
    .option('--limit <n>', 'max rows (default 50)')
    .option('--all', 'include soft-deleted entries')
    .option('--json', 'output JSON')
    .action(async (opts, command: Command) => {
      const filters: ListFilters = {
        namespace: opts.namespace,
        kind: opts.kind ? z.enum(KINDS).parse(opts.kind) : undefined,
        scope: opts.scope ? z.enum(SCOPES).parse(opts.scope) : undefined,
        tag: opts.tag,
        agentSource: opts.agent,
        limit: opts.limit ? Number(opts.limit) : undefined,
        includeDeleted: Boolean(opts.all),
      }
      const items = await withDb(dbOptsFrom(command), (db) => listContexts(db, filters))
      console.log(opts.json ? JSON.stringify(items, null, 2) : formatList(items))
    })
}
