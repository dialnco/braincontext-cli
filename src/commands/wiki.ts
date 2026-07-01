import { basename, resolve } from 'node:path'
import { Command } from 'commander'
import { z } from 'zod'
import { type Context, deleteContext, type UpdateInput } from '../core/contexts'
import { withDb } from '../core/db'
import { AUTHORED_PAGE_TYPES, LINK_TYPES } from '../core/types'
import {
  addLink,
  appendLog,
  backlinks,
  createPage,
  lint,
  listLog,
  listPages,
  outboundLinks,
  recordSource,
  removeLink,
  resolvePageRef,
  searchPages,
  updatePage,
} from '../core/wiki'
import { resolveAgent } from '../lib/agent'
import { formatList } from '../lib/format'
import { resolveBody } from '../lib/stdin'
import { exportWiki, renderIndexMarkdown } from '../wiki/export'
import { importWiki } from '../wiki/import'
import { collect, dbOptsFrom, parsePositiveInt, splitCsv } from './_shared'

function printPage(
  page: Context,
  out: {
    outbound: Awaited<ReturnType<typeof outboundLinks>>
    back: Awaited<ReturnType<typeof backlinks>>
  },
): void {
  console.log(`${page.id}  [${page.pageType}]  ${page.title ?? page.slug}`)
  if (page.slug) console.log(`  slug: ${page.slug}`)
  console.log(`  namespace: ${page.namespace}  updated: ${page.updatedAt}`)
  if (out.outbound.length > 0) {
    console.log('  links →')
    for (const l of out.outbound)
      console.log(`    [${l.type}] ${l.title}${l.wanted ? '  (wanted)' : ''}`)
  }
  if (out.back.length > 0) {
    console.log('  backlinks ←')
    for (const l of out.back) console.log(`    [${l.type}] ${l.title}`)
  }
  console.log('')
  console.log(page.body)
}

export function wikiCommand(): Command {
  const wiki = new Command('wiki').description(
    'Preferred workflow. Build & maintain a linked knowledge wiki (Karpathy LLM-wiki) over the store: pages, typed links, ingest, lint.',
  )

  wiki
    .command('new <title>')
    .description('Create a wiki page.')
    .requiredOption('--type <type>', `page type: ${AUTHORED_PAGE_TYPES.join(' | ')}`)
    .option('--body <text>', 'page body (or use --file / stdin)')
    .option('--file <path>', 'read body from a file (- for stdin)')
    .option('--namespace <ns>', 'wiki namespace', 'wiki')
    .option('--tags <a,b,c>', 'comma-separated tags')
    .option('--agent <name>', 'agent source label')
    .option('--json', 'output JSON')
    .action(async (title: string, opts, command: Command) => {
      const pageType = z.enum(AUTHORED_PAGE_TYPES).parse(opts.type)
      const body = opts.body ?? (await resolveBody(opts.file, []))
      const page = await withDb(dbOptsFrom(command), (db) =>
        createPage(db, {
          title,
          pageType,
          body,
          namespace: opts.namespace,
          tags: splitCsv(opts.tags),
          agentSource: resolveAgent(opts.agent),
        }),
      )
      console.log(
        opts.json
          ? JSON.stringify(page, null, 2)
          : `Created page "${page.title}" (${page.id}) [${page.slug}]`,
      )
    })

  wiki
    .command('get <ref>')
    .description('Fetch a page by id, slug, or title.')
    .option('--json', 'output JSON')
    .action(async (ref: string, opts, command: Command) => {
      const page = await withDb(dbOptsFrom(command), (db) => resolvePageRef(db, ref))
      if (!page) {
        console.error(`No wiki page matching "${ref}".`)
        process.exitCode = 1
        return
      }
      console.log(opts.json ? JSON.stringify(page, null, 2) : page.body)
    })

  wiki
    .command('update <ref>')
    .alias('edit')
    .description(
      'Edit a wiki page in place (by id, slug, or title): title/body/tags. Re-syncs [[links]] from the new body. Source pages are immutable.',
    )
    .option('--title <title>', 'set the title')
    .option('--body <text>', 'set the body inline (or use --file / stdin)')
    .option('--file <path>', 'set the body from a file (use - for stdin)')
    .option('--add-tag <tag>', 'add a tag (repeatable)', collect, [])
    .option('--rm-tag <tag>', 'remove a tag (repeatable)', collect, [])
    .option('--agent <name>', 'agent source label for this change')
    .option('--json', 'output JSON')
    .action(async (ref: string, opts, command: Command) => {
      const patch: UpdateInput = {}
      if (opts.title !== undefined) patch.title = opts.title
      if (opts.body !== undefined) patch.body = opts.body
      else if (opts.file) patch.body = await resolveBody(opts.file, [])
      if (patch.body !== undefined && !patch.body.trim()) {
        throw new Error(
          'Refusing to set an empty body (this would wipe the content). Omit --body/--file to keep it.',
        )
      }
      if (opts.addTag.length > 0) patch.addTags = opts.addTag
      if (opts.rmTag.length > 0) patch.removeTags = opts.rmTag
      if (opts.agent) patch.agentSource = resolveAgent(opts.agent)
      if (Object.keys(patch).length === 0) {
        throw new Error('Nothing to update. Pass --title, --body/--file, --add-tag, or --rm-tag.')
      }

      const page = await withDb(dbOptsFrom(command), async (db) => {
        const target = await resolvePageRef(db, ref)
        if (!target) return null
        return updatePage(db, target.id, patch)
      })
      if (!page) {
        console.error(`No wiki page matching "${ref}".`)
        process.exitCode = 1
        return
      }
      console.log(
        opts.json
          ? JSON.stringify(page, null, 2)
          : `Updated page "${page.title}" (${page.id}) [${page.slug}]`,
      )
    })

  wiki
    .command('show <ref>')
    .description('Show a page with its outbound links and backlinks.')
    .action(async (ref: string, _opts, command: Command) => {
      await withDb(dbOptsFrom(command), async (db) => {
        const page = await resolvePageRef(db, ref)
        if (!page) {
          console.error(`No wiki page matching "${ref}".`)
          process.exitCode = 1
          return
        }
        const [outbound, back] = await Promise.all([
          outboundLinks(db, page.id),
          backlinks(db, page.id),
        ])
        printPage(page, { outbound, back })
      })
    })

  wiki
    .command('link <from> <to>')
    .description('Add a typed link from one page to another (or to a not-yet-created title).')
    .option('--type <type>', `link type: ${LINK_TYPES.join(' | ')}`, 'relates')
    .action(async (fromRef: string, toRef: string, opts, command: Command) => {
      const type = z.enum(LINK_TYPES).parse(opts.type)
      await withDb(dbOptsFrom(command), async (db) => {
        const from = await resolvePageRef(db, fromRef)
        if (!from) {
          console.error(`No source page matching "${fromRef}".`)
          process.exitCode = 1
          return
        }
        const to = await resolvePageRef(db, toRef)
        await addLink(db, from.id, to ? { toId: to.id, type } : { toTitle: toRef, type })
        console.log(
          `Linked "${from.title}" -[${type}]-> ${to ? `"${to.title}"` : `[[${toRef}]] (wanted)`}`,
        )
      })
    })

  wiki
    .command('unlink <from> <to>')
    .description('Remove a link.')
    .option('--type <type>', 'restrict to a link type')
    .action(async (fromRef: string, toRef: string, opts, command: Command) => {
      await withDb(dbOptsFrom(command), async (db) => {
        const from = await resolvePageRef(db, fromRef)
        if (!from) {
          console.error(`No source page matching "${fromRef}".`)
          process.exitCode = 1
          return
        }
        const to = await resolvePageRef(db, toRef)
        const removed = await removeLink(
          db,
          from.id,
          to ? { toId: to.id, type: opts.type } : { toTitle: toRef, type: opts.type },
        )
        console.log(removed > 0 ? `Unlinked (${removed}).` : 'No matching link to remove.')
      })
    })

  wiki
    .command('rm <ref>')
    .description('Delete a wiki page (soft by default; --hard removes it and its links).')
    .option('--hard', 'permanently delete instead of soft-delete')
    .option('--agent <name>', 'agent source label for this change')
    .action(async (ref: string, opts, command: Command) => {
      await withDb(dbOptsFrom(command), async (db) => {
        const page = await resolvePageRef(db, ref)
        if (!page) {
          console.error(`No wiki page matching "${ref}".`)
          process.exitCode = 1
          return
        }
        await deleteContext(db, page.id, {
          hard: Boolean(opts.hard),
          agentSource: resolveAgent(opts.agent),
        })
        console.log(
          `${opts.hard ? 'Hard-deleted' : 'Soft-deleted'} page "${page.title}" (${page.id})`,
        )
      })
    })

  wiki
    .command('backlinks <ref>')
    .description('List pages that link to this page.')
    .option('--json', 'output JSON')
    .action(async (ref: string, opts, command: Command) => {
      await withDb(dbOptsFrom(command), async (db) => {
        const page = await resolvePageRef(db, ref)
        if (!page) {
          console.error(`No wiki page matching "${ref}".`)
          process.exitCode = 1
          return
        }
        const back = await backlinks(db, page.id)
        if (opts.json) console.log(JSON.stringify(back, null, 2))
        else if (back.length === 0) console.log('No backlinks.')
        else for (const l of back) console.log(`[${l.type}] ${l.title} (${l.pageId})`)
      })
    })

  wiki
    .command('search <query>')
    .description('Full-text search across wiki pages (FTS5/BM25).')
    .option('--type <type>', 'restrict to a page type')
    .option('--namespace <ns>', 'restrict to a namespace')
    .option('--limit <n>', 'max results')
    .option('--json', 'output JSON')
    .action(async (query: string, opts, command: Command) => {
      const items = await withDb(dbOptsFrom(command), (db) =>
        searchPages(db, query, {
          namespace: opts.namespace,
          pageType: opts.type,
          limit: parsePositiveInt(opts.limit, '--limit'),
        }),
      )
      console.log(opts.json ? JSON.stringify(items, null, 2) : formatList(items))
    })

  wiki
    .command('index')
    .description('Render the wiki catalog (by page type) to a file or stdout.')
    .option('--out <file>', 'write to a file instead of stdout')
    .option('--namespace <ns>', 'restrict to a namespace')
    .action(async (opts, command: Command) => {
      await withDb(dbOptsFrom(command), async (db) => {
        const pages = await listPages(db, { namespace: opts.namespace, limit: 100000 })
        const md = renderIndexMarkdown(pages)
        if (opts.out) {
          const { writeFileSync } = await import('node:fs')
          writeFileSync(resolve(opts.out), md, 'utf8')
          console.log(`Wrote ${resolve(opts.out)}`)
        } else {
          console.log(md)
        }
      })
    })

  wiki
    .command('log')
    .description('Show the wiki operation log (newest first).')
    .option('--tail <n>', 'number of entries', '20')
    .option('--json', 'output JSON')
    .action(async (opts, command: Command) => {
      const rows = await withDb(dbOptsFrom(command), (db) =>
        listLog(db, { limit: parsePositiveInt(opts.tail, '--tail') ?? 20 }),
      )
      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2))
        return
      }
      for (const e of rows)
        console.log(
          `[${e.createdAt}] ${e.op}${e.title ? ` | ${e.title}` : ''}${e.detail ? ` — ${e.detail}` : ''}`,
        )
    })

  wiki
    .command('ingest <source>')
    .description(
      'Store a raw source (immutable) + log it, then print a synthesis checklist for the agent.',
    )
    .option('--title <title>', 'source title')
    .option('--uri <uri>', 'source URI / path of record')
    .option('--agent <name>', 'agent source label')
    .option('--json', 'output JSON')
    .action(async (source: string, opts, command: Command) => {
      const body = await resolveBody(source, [])
      if (!body.trim()) {
        console.error('Empty source.')
        process.exitCode = 1
        return
      }
      const title = opts.title ?? (source === '-' ? 'untitled source' : basename(source))
      const page = await withDb(dbOptsFrom(command), async (db) => {
        const p = await recordSource(db, {
          title,
          body,
          uri: opts.uri,
          agentSource: resolveAgent(opts.agent),
        })
        await appendLog(db, {
          op: 'ingest',
          refId: p.id,
          title,
          agentSource: resolveAgent(opts.agent),
        })
        return p
      })
      if (opts.json) {
        console.log(JSON.stringify(page, null, 2))
        return
      }
      console.log(`Stored source "${title}" (${page.id}).`)
      console.log('Next (agent):')
      console.log(`  1. Write a summary page:   bctx wiki new "${title}" --type summary --file -`)
      console.log(
        `  2. Link summary→source:    bctx wiki link "<summary>" "${title}" --type source`,
      )
      console.log('  3. Update ~5–15 related entity/concept pages, weaving in [[links]].')
      console.log('  4. Refresh the catalog:    bctx wiki index --out index.md')
      console.log('  5. Review health:          bctx wiki lint')
    })

  wiki
    .command('lint')
    .description('Report wiki health issues (orphans, dangling/wanted links, ...).')
    .option('--json', 'output JSON')
    .action(async (opts, command: Command) => {
      const report = await withDb(dbOptsFrom(command), (db) => lint(db))
      if (opts.json) {
        console.log(JSON.stringify(report, null, 2))
        return
      }
      if (report.findings.length === 0) {
        console.log('Wiki is healthy — no findings.')
        return
      }
      for (const f of report.findings) {
        console.log(`[${f.kind}] ${f.title ?? f.pageId ?? ''} — ${f.detail}`)
      }
      console.log(`\n${report.findings.length} finding(s): ${JSON.stringify(report.counts)}`)
    })

  wiki
    .command('export <dir>')
    .description(
      'Export the wiki to markdown (per-page .md + index.md + log.md, Obsidian-compatible).',
    )
    .action(async (dir: string, _opts, command: Command) => {
      const result = await withDb(dbOptsFrom(command), (db) => exportWiki(db, resolve(dir)))
      console.log(`Exported ${result.files.length} file(s) to ${resolve(dir)}`)
    })

  wiki
    .command('import <dir>')
    .description('Import a directory of markdown pages into the wiki (parses links).')
    .action(async (dir: string, _opts, command: Command) => {
      const r = await withDb(dbOptsFrom(command), (db) => importWiki(db, resolve(dir)))
      console.log(`Imported: ${r.created} created, ${r.updated} updated, ${r.skipped} skipped.`)
    })

  return wiki
}
