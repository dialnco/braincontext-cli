import { resolve } from 'node:path'
import { Command } from 'commander'
import { withDb } from '../core/db'
import { applyImport } from '../sync/import'
import { dbOptsFrom } from './_shared'

export function importCommand(): Command {
  return new Command('import')
    .description(
      'Manually sync edits from a per-context markdown dir back into the store ' +
        '(inverse of `export --targets store`). Matches files to contexts by frontmatter id.',
    )
    .argument('<dir>', 'directory of per-context .md files (from `bctx export --targets store`)')
    .option('--prune', 'soft-delete contexts whose file is gone (scoped to the export manifest)')
    .option('--namespace <ns>', 'scope --prune to this namespace when there is no export manifest')
    .option('--dry-run', 'preview changes without writing')
    .option('--agent <name>', 'attribute these sync writes to an agent')
    .option('--json', 'output JSON')
    .action(async (dir: string, opts, command: Command) => {
      const { plan, result } = await withDb(dbOptsFrom(command), (db) =>
        applyImport(db, resolve(dir), {
          prune: Boolean(opts.prune),
          dryRun: Boolean(opts.dryRun),
          agentSource: opts.agent ?? null,
          pruneNamespace: opts.namespace,
        }),
      )

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2))
        return
      }

      const w = opts.dryRun ? 'would ' : ''
      console.log(
        `${w}create: ${result.created}, ${w}update: ${result.updated}, unchanged: ${result.unchanged}, ${w}prune: ${result.pruned}${result.skipped > 0 ? `, skipped: ${result.skipped}` : ''}`,
      )
      if (opts.dryRun) {
        for (const e of plan.create) console.log(`  + ${e.title ?? e.file}`)
        for (const u of plan.update) console.log(`  ~ ${u.entry.title ?? u.entry.file}`)
        if (opts.prune) for (const m of plan.missing) console.log(`  - ${m.title ?? m.id}`)
      }
      if (!opts.prune && plan.missing.length > 0) {
        console.log(
          `${plan.missing.length} context(s) have no file — pass --prune to soft-delete them.`,
        )
      }
    })
}
