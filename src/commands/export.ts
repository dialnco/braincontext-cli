import { resolve } from 'node:path'
import { Command } from 'commander'
import { z } from 'zod'
import { withDb } from '../core/db'
import { KINDS, SCOPES } from '../core/types'
import { selectContexts } from '../export/select'
import { ALL_TARGETS, runExport, type Target } from '../export/write'
import { dbOptsFrom } from './_shared'

export function exportCommand(): Command {
  return new Command('export')
    .description(
      'Export stored context to agent files (AGENTS.md, CLAUDE.md, .cursor/rules/*.mdc).',
    )
    .option('--out <dir>', 'output directory', '.')
    .option(
      '--targets <list>',
      `comma-separated subset of: ${ALL_TARGETS.join(',')}`,
      ALL_TARGETS.join(','),
    )
    .option('--namespace <ns>', 'filter by namespace')
    .option('--kind <kind>', `filter by kind: ${KINDS.join(' | ')}`)
    .option('--scope <scope>', `filter by scope: ${SCOPES.join(' | ')}`)
    .option('--tag <tag>', 'filter by tag')
    .option('--agent <name>', 'filter by agent source')
    .option('--limit <n>', 'max contexts to include')
    .option('--dry-run', 'show what would change without writing')
    .option('--check', 'exit non-zero if files would change (no writes)')
    .option('--json', 'output JSON')
    .action(async (opts, command: Command) => {
      const targets = String(opts.targets)
        .split(',')
        .map((s) => s.trim())
        .filter((t): t is Target => (ALL_TARGETS as string[]).includes(t))

      const items = await withDb(dbOptsFrom(command), (db) =>
        selectContexts(db, {
          namespace: opts.namespace,
          kind: opts.kind ? z.enum(KINDS).parse(opts.kind) : undefined,
          scope: opts.scope ? z.enum(SCOPES).parse(opts.scope) : undefined,
          tag: opts.tag,
          agentSource: opts.agent,
          limit: opts.limit ? Number(opts.limit) : undefined,
        }),
      )

      const result = runExport(items, {
        outDir: resolve(opts.out),
        targets,
        dryRun: Boolean(opts.dryRun),
        check: Boolean(opts.check),
      })

      if (opts.json) {
        console.log(
          JSON.stringify(
            { changed: result.changed.map((c) => c.path), unchanged: result.unchanged },
            null,
            2,
          ),
        )
      } else if (result.changed.length === 0) {
        console.log('Up to date — no changes.')
      } else {
        const verb = opts.check || opts.dryRun ? 'would write' : 'wrote'
        for (const c of result.changed) console.log(`${verb}: ${c.path}`)
      }

      if (opts.check && result.changed.length > 0) process.exitCode = 1
    })
}
