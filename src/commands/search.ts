import { Command } from 'commander'
import { z } from 'zod'
import { type ListFilters, searchContexts } from '../core/contexts'
import { withDb } from '../core/db'
import { KINDS, SCOPES } from '../core/types'
import { formatList } from '../lib/format'
import { dbOptsFrom, parsePositiveInt } from './_shared'

export function searchCommand(): Command {
  return new Command('search')
    .description('Full-text search (FTS5 / BM25) across titles and bodies.')
    .argument('<query>', 'FTS5 query, e.g. "pnpm" or "deploy*"')
    .option('--namespace <ns>', 'filter by namespace')
    .option('--kind <kind>', `filter by kind: ${KINDS.join(' | ')}`)
    .option('--scope <scope>', `filter by scope: ${SCOPES.join(' | ')}`)
    .option('--tag <tag>', 'filter by tag')
    .option('--agent <name>', 'filter by agent source')
    .option('--limit <n>', 'max rows (default 50)')
    .option('--include-wiki', 'also include wiki pages (excluded by default)')
    .option('--json', 'output JSON')
    .action(async (query: string, opts, command: Command) => {
      const filters: ListFilters = {
        namespace: opts.namespace,
        kind: opts.kind ? z.enum(KINDS).parse(opts.kind) : undefined,
        scope: opts.scope ? z.enum(SCOPES).parse(opts.scope) : undefined,
        tag: opts.tag,
        agentSource: opts.agent,
        limit: parsePositiveInt(opts.limit, '--limit'),
        pageScope: opts.includeWiki ? 'all' : undefined,
      }
      const items = await withDb(dbOptsFrom(command), (db) => searchContexts(db, query, filters))
      console.log(opts.json ? JSON.stringify(items, null, 2) : formatList(items))
    })
}
