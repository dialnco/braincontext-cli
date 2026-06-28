import { Command } from 'commander'
import { z } from 'zod'
import { createContext } from '../core/contexts'
import { withDb } from '../core/db'
import { KINDS, SCOPES } from '../core/types'
import { resolveAgent } from '../lib/agent'
import { formatContext } from '../lib/format'
import { resolveBody } from '../lib/stdin'
import { dbOptsFrom, splitCsv } from './_shared'

export function addCommand(): Command {
  return new Command('add')
    .description('Create a new context entry. Body comes from --file, stdin, or trailing args.')
    .argument('[body...]', 'inline body text (optional when using --file or stdin)')
    .option('--title <title>', 'short human title')
    .option('--kind <kind>', `entry kind: ${KINDS.join(' | ')}`, 'note')
    .option('--namespace <ns>', 'namespace / project bucket', 'global')
    .option('--scope <scope>', `scope: ${SCOPES.join(' | ')}`, 'project')
    .option('--tags <a,b,c>', 'comma-separated tags')
    .option(
      '--agent <name>',
      'agent source label (default: detected agent or user@host; set BCTX_AGENT to override)',
    )
    .option('--file <path>', 'read body from a file (use - for stdin)')
    .option('--json', 'output JSON')
    .action(async (bodyArgs: string[], opts, command: Command) => {
      const kind = z.enum(KINDS).parse(opts.kind)
      const scope = z.enum(SCOPES).parse(opts.scope)
      const body = await resolveBody(opts.file, bodyArgs)
      if (!body.trim()) {
        console.error('No body provided. Pass text, --file <path>, or pipe via stdin.')
        process.exitCode = 1
        return
      }
      const ctx = await withDb(dbOptsFrom(command), (db) =>
        createContext(db, {
          body,
          title: opts.title ?? null,
          kind,
          namespace: opts.namespace,
          scope,
          agentSource: resolveAgent(opts.agent),
          tags: splitCsv(opts.tags),
        }),
      )
      console.log(opts.json ? JSON.stringify(ctx, null, 2) : formatContext(ctx))
    })
}
