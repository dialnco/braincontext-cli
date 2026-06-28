import { resolve } from 'node:path'
import { Command } from 'commander'
import { z } from 'zod'
import type { Context, ListFilters } from '../core/contexts'
import { openStore, withDb } from '../core/db'
import { migrateToLatest } from '../core/migrate'
import { type DbOpts, resolveTarget } from '../core/paths'
import { KINDS, SCOPES } from '../core/types'
import { selectContexts } from '../export/select'
import { pruneStaleStoreFiles } from '../export/store'
import { ALL_TARGET_NAMES, ALL_TARGETS, runExport, type Target } from '../export/write'
import { writeExportManifest } from '../sync/import'
import { dbOptsFrom, parsePositiveInt } from './_shared'

/** A change fingerprint over the export set: any create/update/delete changes it. */
function fingerprint(items: Context[]): string {
  return JSON.stringify(items.map((i) => [i.id, i.updatedAt]).sort())
}

/**
 * Re-export whenever the store changes (poll its rows). Holds one long-lived store, syncs a
 * replica each tick, and writes only when the export set actually changed. Ctrl-C to stop.
 */
async function runExportWatch(
  dbOpts: DbOpts,
  filters: ListFilters,
  outDir: string,
  targets: Target[],
): Promise<void> {
  const target = resolveTarget(dbOpts)
  const store = openStore(target)
  await store.prepare()
  if (!dbOpts.noSync) await store.sync()
  await migrateToLatest(store.db, {
    lockFile: target.mode !== 'remote' ? target.file : undefined,
  })

  let last = ''
  const tick = async (): Promise<void> => {
    if (target.mode === 'replica' && !dbOpts.noSync) await store.sync().catch(() => undefined)
    const items = await selectContexts(store.db, filters)
    const fp = fingerprint(items)
    if (fp === last) return
    last = fp
    const result = runExport(items, { outDir, targets })
    for (const c of result.changed) console.error(`wrote: ${c.path}`)
  }

  await tick()
  console.error(
    `bctx export --watch: watching ${target.mode === 'remote' ? target.url : target.file} → ${outDir}. Ctrl-C to stop.`,
  )
  let stop = false
  let wake: (() => void) | null = null
  const onSignal = () => {
    stop = true
    wake?.() // cut the poll sleep short so Ctrl-C exits promptly
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  while (!stop) {
    await new Promise<void>((resolve) => {
      wake = resolve
      setTimeout(resolve, 2000)
    })
    wake = null
    if (!stop) await tick().catch((e) => console.error(`export --watch: ${(e as Error).message}`))
  }
  await store.close()
  process.exit(0) // libSQL keeps a handle open; exit explicitly like the MCP server does
}

export function exportCommand(): Command {
  return new Command('export')
    .description(
      'Export stored context to agent files (AGENTS.md, CLAUDE.md, .cursor/rules/*.mdc), ' +
        'or to a round-trippable per-context dir (--targets store, paired with `bctx import`).',
    )
    .option('--out <dir>', 'output directory (use a dedicated dir for --targets store)', '.')
    .option(
      '--targets <list>',
      `comma-separated subset of: ${ALL_TARGET_NAMES.join(',')}`,
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
    .option('--watch', 're-export whenever the store changes (Ctrl-C to stop)')
    .option('--json', 'output JSON')
    .action(async (opts, command: Command) => {
      const requested = String(opts.targets)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      const unknown = requested.filter((t) => !(ALL_TARGET_NAMES as string[]).includes(t))
      if (unknown.length > 0) {
        throw new Error(
          `Unknown --targets: ${unknown.join(', ')} (valid: ${ALL_TARGET_NAMES.join(', ')}).`,
        )
      }
      const targets = requested as Target[]

      const filters: ListFilters = {
        namespace: opts.namespace,
        kind: opts.kind ? z.enum(KINDS).parse(opts.kind) : undefined,
        scope: opts.scope ? z.enum(SCOPES).parse(opts.scope) : undefined,
        tag: opts.tag,
        agentSource: opts.agent,
        limit: parsePositiveInt(opts.limit, '--limit'),
      }
      const outDir = resolve(opts.out)
      const dbOpts = dbOptsFrom(command)

      if (opts.watch) {
        if (opts.check || opts.dryRun)
          throw new Error('--watch cannot be combined with --check/--dry-run.')
        await runExportWatch(dbOpts, filters, outDir, targets)
        return
      }

      const items = await withDb(dbOpts, (db) => selectContexts(db, filters))
      const result = runExport(items, {
        outDir,
        targets,
        dryRun: Boolean(opts.dryRun),
        check: Boolean(opts.check),
      })

      // Record the export's filter scope so `import --prune` can mirror it safely, and
      // remove stale store files (deleted contexts) within that same scope so they can't
      // resurrect on re-import.
      if (targets.includes('store') && !opts.dryRun && !opts.check) {
        writeExportManifest(outDir, {
          namespace: opts.namespace,
          kind: opts.kind,
          scope: opts.scope,
          tag: opts.tag,
          agentSource: opts.agent,
        })
        pruneStaleStoreFiles(outDir, new Set(items.map((i) => i.id)), {
          namespace: opts.namespace,
          kind: opts.kind,
          scope: opts.scope,
        })
      }

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
