import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Command } from 'commander'
import { type Context, listContexts, listTags } from '../core/contexts'
import { withDb } from '../core/db'
import { type DbOpts, resolveTarget } from '../core/paths'
import { currentProjectName } from '../core/registry'
import { KINDS } from '../core/types'
import { listPages, wikiGraph } from '../core/wiki'
import { selectContexts } from '../export/select'
import { planExport } from '../export/write'
import { dbOptsFrom } from './_shared'

const PAGE_TYPE_ORDER = ['entity', 'concept', 'summary', 'comparison', 'analysis', 'source']

/** Where the resolved store lives, and which registry project (if any) it is. */
function storeLabel(opts: DbOpts): { project: string | null; mode: string; location: string } {
  const t = resolveTarget(opts)
  const location = t.mode === 'remote' ? t.url : t.file
  // Mirror resolveTarget's precedence so the label matches the file actually used:
  // an explicit/env db or a global/local flag is an ad-hoc file with no project identity.
  let project: string | null
  if (opts.db || process.env.BCTX_DB || opts.global || opts.local) project = null
  else project = opts.project ?? process.env.BCTX_PROJECT ?? currentProjectName()
  return { project, mode: t.mode, location }
}

function tally<T>(items: T[], key: (t: T) => string): Map<string, number> {
  const m = new Map<string, number>()
  for (const it of items) m.set(key(it), (m.get(key(it)) ?? 0) + 1)
  return m
}

function breakdown(counts: Map<string, number>, order: readonly string[]): string {
  const parts = order.filter((k) => counts.get(k)).map((k) => `${k} ${counts.get(k)}`)
  // include any keys not in the known order (forward-compatible)
  for (const [k, n] of counts) if (!order.includes(k) && n) parts.push(`${k} ${n}`)
  return parts.length ? ` (${parts.join(', ')})` : ''
}

export function statusCommand(): Command {
  return new Command('status')
    .alias('doctor')
    .description(
      'Show the resolved store, what it holds, and whether exported agent files are stale.',
    )
    .option('--json', 'output JSON')
    .action(async (opts, command: Command) => {
      const dbOpts = dbOptsFrom(command)
      const { project, mode, location } = storeLabel(dbOpts)

      const report = await withDb(dbOpts, async (db) => {
        const allCtx = await listContexts(db, { includeDeleted: true, limit: 1_000_000 })
        const live = allCtx.filter((c) => c.deletedAt === null)
        const pages = await listPages(db, { limit: 1_000_000 })
        const tags = await listTags(db)
        const graph = await wikiGraph(db, {})
        const exportItems = await selectContexts(db, {})
        return {
          live,
          deleted: allCtx.length - live.length,
          pages,
          tagCount: tags.length,
          links: graph.edges.length,
          exportItems,
        }
      })

      // AGENTS.md freshness in the cwd: does a re-export change the managed block?
      const agentsPath = join(process.cwd(), 'AGENTS.md')
      let agents: 'fresh' | 'stale' | 'absent'
      if (existsSync(agentsPath)) {
        const planned = planExport(report.exportItems, {
          outDir: process.cwd(),
          targets: ['agents'],
        })
        agents =
          planned[0] && readFileSync(agentsPath, 'utf8') !== planned[0].content ? 'stale' : 'fresh'
      } else {
        agents = 'absent'
      }

      const byKind = tally(report.live, (c: Context) => c.kind)
      const byType = tally(report.pages, (p: Context) => p.pageType ?? 'page')

      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              store: { project, mode, location },
              contexts: { total: report.live.length, byKind: Object.fromEntries(byKind) },
              wiki: {
                pages: report.pages.length,
                links: report.links,
                byType: Object.fromEntries(byType),
              },
              tags: report.tagCount,
              deleted: report.deleted,
              agentsMd: agents,
            },
            null,
            2,
          ),
        )
        return
      }

      const agentsLine =
        agents === 'fresh'
          ? 'up to date ✓'
          : agents === 'stale'
            ? 'STALE — run `bctx export`'
            : 'not present — run `bctx export` to materialize'

      console.log('braincontext — status\n')
      console.log(`Store      ${project ?? '(ad-hoc)'} · ${mode} · ${location}`)
      console.log(`Contexts   ${report.live.length}${breakdown(byKind, KINDS)}`)
      console.log(
        `Wiki       ${report.pages.length} pages · ${report.links} links${breakdown(byType, PAGE_TYPE_ORDER)}`,
      )
      console.log(`Tags       ${report.tagCount}`)
      console.log(`Deleted    ${report.deleted} soft-deleted`)
      console.log(`AGENTS.md  ${agentsLine}`)
      console.log(
        '\nMCP: `bctx mcp` exposes this store to agents · docs: `bctx skills get braincontext`',
      )
    })
}
