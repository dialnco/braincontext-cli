import { basename, resolve } from 'node:path'
import { Command } from 'commander'
import { z } from 'zod'
import { type Context, deleteContext, RevConflictError, type UpdateInput } from '../core/contexts'
import { createDatatable, expandTransclusions } from '../core/datatable'
import { withDb } from '../core/db'
import { EditError, editPage, getPageSection, patchPageSection } from '../core/edit'
import {
  listProperties,
  type PropertyKeyInfo,
  queryPages,
  renderView,
  type WhereClause,
  type WikiQuery,
} from '../core/query'
import {
  extractTableToDatatable,
  TableError,
  type TableLocator,
  tableAddColumn,
  tableAddRow,
  tableDeleteColumn,
  tableDeleteRow,
  tableGet,
  tableRenameColumn,
  tableSetCell,
} from '../core/tables'
import { AUTHORED_PAGE_TYPES, LINK_TYPES } from '../core/types'
import {
  addLink,
  appendLog,
  backlinks,
  createPage,
  createView,
  ingestStatus,
  lint,
  listLog,
  listPages,
  outboundLinks,
  pageFreshness,
  pagePeek,
  recordSource,
  reindexWiki,
  removeLink,
  resolvePageRef,
  searchPages,
  setPageProps,
  updatePage,
  verifyPage,
} from '../core/wiki'
import { resolveAgent } from '../lib/agent'
import { formatList } from '../lib/format'
import { type Align, columnIndex, serializeTable } from '../lib/mdtable'
import { truncateAtTokens } from '../lib/outline'
import { resolveBody } from '../lib/stdin'
import { estimateTokens, formatTokens } from '../lib/tokens'
import { driftFindings, snapshotSourceHashes } from '../wiki/drift'
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
  if (page.pageType !== 'source' && page.pageType !== 'index') {
    const f = pageFreshness(page)
    const by = f.verifiedBy ? ` by ${f.verifiedBy}` : ''
    console.log(
      `  freshness: ${f.state} (${f.verifiedAt ? 'verified' : 'updated'} ${f.ageDays}d ago${by})  ${formatTokens(estimateTokens(page.body))}`,
    )
  }
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
    .option('--sources <a,b,c>', 'repo-relative source files this page documents (drift tracking)')
    .option(
      '--prop <key=value>',
      'set a typed property (repeatable; queryable via `wiki query`)',
      collect,
      [],
    )
    .option('--agent <name>', 'agent source label')
    .option('--json', 'output JSON')
    .action(async (title: string, opts, command: Command) => {
      const pageType = z.enum(AUTHORED_PAGE_TYPES).parse(opts.type)
      const body = opts.body ?? (await resolveBody(opts.file, []))
      const sources = splitCsv(opts.sources)
      const props = parseProps(opts.prop as string[])
      const metadata: Record<string, unknown> = {}
      if (sources.length > 0) metadata.sources = sources
      if (Object.keys(props).length > 0) metadata.props = props
      const page = await withDb(dbOptsFrom(command), (db) =>
        createPage(db, {
          title,
          pageType,
          body,
          namespace: opts.namespace,
          tags: splitCsv(opts.tags),
          agentSource: resolveAgent(opts.agent),
          metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
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
    .description(
      'Fetch a page by id, slug, or title. Use --peek to preview outline/excerpt/cost before spending tokens on the full body.',
    )
    .option('--peek', 'summary view: outline + excerpt + links + token cost (no full body)')
    .option('--section <heading>', 'print only this heading-anchored section (no #)')
    .option('--max-tokens <n>', 'truncate the body to ~N tokens (at a paragraph boundary)')
    .option('--no-embed', 'leave ![[Title]] transclusions unexpanded (show the raw body)')
    .option('--json', 'output JSON')
    .action(async (ref: string, opts, command: Command) => {
      const maxTokens = parsePositiveInt(opts.maxTokens, '--max-tokens')
      await withDb(dbOptsFrom(command), async (db) => {
        if (opts.section) {
          try {
            const view = await getPageSection(db, ref, opts.section)
            console.log(opts.json ? JSON.stringify(view, null, 2) : view.text)
          } catch (e) {
            if (e instanceof EditError) {
              console.error(e.message)
              process.exitCode = 1
              return
            }
            throw e
          }
          return
        }
        const page = await resolvePageRef(db, ref)
        if (!page) {
          console.error(`No wiki page matching "${ref}".`)
          process.exitCode = 1
          return
        }
        if (opts.peek) {
          const peek = await pagePeek(db, page.id)
          if (!peek) {
            console.error(`No wiki page matching "${ref}".`)
            process.exitCode = 1
            return
          }
          if (opts.json) {
            console.log(JSON.stringify(peek, null, 2))
            return
          }
          console.log(`${peek.id}  [${peek.pageType}]  ${peek.title ?? peek.slug}`)
          console.log(
            `  full body: ${formatTokens(peek.tokenEstimate)}  freshness: ${peek.freshness.state} (${peek.freshness.ageDays}d)`,
          )
          if (peek.tags.length > 0) console.log(`  tags: ${peek.tags.join(', ')}`)
          if (peek.outline.length > 0) {
            console.log('  outline:')
            for (const h of peek.outline) console.log(`    · ${h}`)
          }
          console.log(`  links: ${peek.links.length} out · ${peek.backlinks.length} in`)
          if (peek.excerpt) console.log(`\n${peek.excerpt}`)
          return
        }
        // A `view` renders live from its saved query; else `![[Title]]` embeds inline the
        // referenced page on read (--no-embed shows the stored body verbatim; commander maps
        // --no-embed to embed:false).
        let body: string
        if (page.pageType === 'view') body = await renderView(db, page.metadata)
        else if (opts.embed === false) body = page.body
        else body = await expandTransclusions(db, page.body)
        if (maxTokens) {
          const t = truncateAtTokens(body, maxTokens)
          if (t.truncated) {
            body = `${t.text}\n\n[truncated at ~${t.returnedTokens} of ~${t.totalTokens} tokens — rerun without --max-tokens for the rest]`
          }
        }
        console.log(opts.json ? JSON.stringify({ ...page, body }, null, 2) : body)
      })
    })

  wiki
    .command('verify <ref>')
    .description(
      'Mark a page as verified (its content was just checked against reality). Unverified/old pages surface as stale in `wiki lint`.',
    )
    .option('--agent <name>', 'agent source label')
    .option('--json', 'output JSON')
    .action(async (ref: string, opts, command: Command) => {
      const result = await withDb(dbOptsFrom(command), async (db) => {
        const target = await resolvePageRef(db, ref)
        if (!target) return null
        const page = await verifyPage(db, target.id, { agent: resolveAgent(opts.agent) })
        if (!page) return null
        // Baseline the declared source files so `wiki lint --drift` can tell when
        // the code this page documents changes out from under it.
        const hashes = await snapshotSourceHashes(db, page.id, process.cwd())
        return { page, hashes }
      })
      if (!result) {
        console.error(`No wiki page matching "${ref}".`)
        process.exitCode = 1
        return
      }
      const f = pageFreshness(result.page)
      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              id: result.page.id,
              title: result.page.title,
              freshness: f,
              sourceHashes: result.hashes,
            },
            null,
            2,
          ),
        )
        return
      }
      console.log(`Verified "${result.page.title}" (${result.page.id}) at ${f.verifiedAt}`)
      if (result.hashes) {
        const missing = Object.entries(result.hashes).filter(([, h]) => h === null)
        console.log(`Snapshotted ${Object.keys(result.hashes).length} source hash(es).`)
        for (const [path] of missing) console.log(`  ! ${path} not found (recorded as missing)`)
      }
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
    .option('--sources <a,b,c>', 'replace the source files this page documents (drift tracking)')
    .option('--if-rev <rev>', 'only update if the page rev still matches (optimistic concurrency)')
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
      if (opts.sources !== undefined) patch.setMetadata = { sources: splitCsv(opts.sources) ?? [] }
      if (opts.agent) patch.agentSource = resolveAgent(opts.agent)
      if (Object.keys(patch).length === 0) {
        throw new Error(
          'Nothing to update. Pass --title, --body/--file, --add-tag, --rm-tag, or --sources.',
        )
      }
      // Set ifRev after the "nothing to update" guard so a bare --if-rev isn't a no-op edit.
      if (opts.ifRev) patch.ifRev = opts.ifRev

      let page: Context | null
      try {
        page = await withDb(dbOptsFrom(command), async (db) => {
          const target = await resolvePageRef(db, ref)
          if (!target) return null
          return updatePage(db, target.id, patch)
        })
      } catch (e) {
        if (e instanceof RevConflictError) {
          console.error(
            `Conflict: "${ref}" changed since it was read (current rev ${e.currentRev}). Re-read and retry.`,
          )
          process.exitCode = 1
          return
        }
        throw e
      }
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
    .command('patch-section <ref>')
    .description(
      'Replace ONE heading-anchored section instead of rewriting the whole body. --body is spliced in verbatim (include the heading line to keep it). Refuses if the heading is missing or ambiguous.',
    )
    .requiredOption('--section <heading>', 'heading text of the section to replace (no #)')
    .option('--body <text>', 'new section markdown (or use --file / stdin)')
    .option('--file <path>', 'read the new section from a file (- for stdin)')
    .option('--if-rev <rev>', 'only apply if the page rev still matches')
    .option('--agent <name>', 'agent source label')
    .option('--json', 'output JSON')
    .action(async (ref: string, opts, command: Command) => {
      const body = opts.body ?? (await resolveBody(opts.file, []))
      try {
        const page = await withDb(dbOptsFrom(command), (db) =>
          patchPageSection(db, ref, opts.section, body, {
            ifRev: opts.ifRev,
            agentSource: resolveAgent(opts.agent),
          }),
        )
        console.log(
          opts.json
            ? JSON.stringify(page, null, 2)
            : `Patched section "${opts.section}" in "${page.title}" (rev ${page.rev})`,
        )
      } catch (e) {
        if (!reportEditError(e)) throw e
      }
    })

  wiki
    .command('replace <ref>')
    .description(
      "Anchored exact find→replace on a page body (for prose/links a table/section op can't reach). Exact-match-or-refuse: with no --occurrence, --find must occur exactly once.",
    )
    .requiredOption('--find <text>', 'exact text to find')
    .requiredOption('--replace <text>', 'replacement text')
    .option('--occurrence <n>', 'which 1-based match to replace (when --find occurs many times)')
    .option('--if-rev <rev>', 'only apply if the page rev still matches')
    .option('--agent <name>', 'agent source label')
    .option('--json', 'output JSON')
    .action(async (ref: string, opts, command: Command) => {
      const occurrence = parsePositiveInt(opts.occurrence, '--occurrence')
      try {
        const page = await withDb(dbOptsFrom(command), (db) =>
          editPage(db, ref, opts.find, opts.replace, {
            occurrence,
            ifRev: opts.ifRev,
            agentSource: resolveAgent(opts.agent),
          }),
        )
        console.log(
          opts.json
            ? JSON.stringify(page, null, 2)
            : `Replaced text in "${page.title}" (rev ${page.rev})`,
        )
      } catch (e) {
        if (!reportEditError(e)) throw e
      }
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
    .option(
      '--budget <tokens>',
      'cap the catalog at ~N tokens (drops sources first, then largest pages; omissions are stated)',
    )
    .action(async (opts, command: Command) => {
      await withDb(dbOptsFrom(command), async (db) => {
        const pages = await listPages(db, { namespace: opts.namespace, limit: 100000 })
        const md = renderIndexMarkdown(pages, {
          budget: parsePositiveInt(opts.budget, '--budget'),
        })
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
      'Store a raw source (immutable) + log it, then print a synthesis checklist for the agent. With --status, treat <source> as a page ref and report how far the synthesis got (derived from the graph — resumable across sessions).',
    )
    .option('--title <title>', 'source title')
    .option('--uri <uri>', 'source URI / path of record')
    .option('--status', 'report synthesis progress for an already-ingested source')
    .option('--agent <name>', 'agent source label')
    .option('--json', 'output JSON')
    .action(async (source: string, opts, command: Command) => {
      if (opts.status) {
        const status = await withDb(dbOptsFrom(command), async (db) => {
          const target = await resolvePageRef(db, source)
          return target ? ingestStatus(db, target.id) : null
        })
        if (!status) {
          console.error(`No source page matching "${source}".`)
          process.exitCode = 1
          return
        }
        if (opts.json) {
          console.log(JSON.stringify(status, null, 2))
          return
        }
        console.log(`Source "${status.title}" (${status.sourceId}) ingested ${status.ingestedAt}`)
        for (const s of status.steps) {
          console.log(`  ${s.done ? '✓' : '·'} ${s.step}: ${s.detail}`)
        }
        console.log(
          status.complete
            ? 'Synthesis complete.'
            : 'Synthesis incomplete — see pending steps above.',
        )
        return
      }
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
      console.log('  6. Verify touched pages:   bctx wiki verify "<ref>"')
    })

  wiki
    .command('lint')
    .description(
      'Report wiki health issues (orphans, dangling/wanted links, stale/never-verified pages, ...).',
    )
    .option('--stale-days <n>', 'stale window in days (default 45)')
    .option('--drift', 'also check pages whose declared source files changed (paths vs cwd)')
    .option('--json', 'output JSON')
    .action(async (opts, command: Command) => {
      const report = await withDb(dbOptsFrom(command), async (db) => {
        const r = await lint(db, { staleDays: parsePositiveInt(opts.staleDays, '--stale-days') })
        if (opts.drift) {
          const drift = await driftFindings(db, process.cwd())
          r.findings.push(...drift)
          if (drift.length > 0) r.counts.drift = drift.length
        }
        return r
      })
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

  wiki
    .command('reindex')
    .description(
      'Repair derived state from the authoritative pages: rebuild the page_properties mirror (for `wiki query`/views). With --links, also re-derive the [[references]]/![[embeds]] graph. Idempotent; does not modify the pages themselves. Run after a schema/parser upgrade.',
    )
    .option('--links', 're-derive the typed-link graph too (references + embeds)')
    .option('--json', 'output JSON')
    .action(async (opts, command: Command) => {
      const r = await withDb(dbOptsFrom(command), (db) => reindexWiki(db, { links: opts.links }))
      console.log(
        opts.json
          ? JSON.stringify(r, null, 2)
          : `Reindexed ${r.pages} page(s): ${r.propsRebuilt} with properties${r.linksResynced ? ', link graph re-derived' : ''}.`,
      )
    })

  wiki
    .command('query')
    .description(
      'Find pages by their typed properties. --where is a JSON object; each key is ANDed and its value is a scalar (eq) or a condition like {"gt":2} / {"in":["a","b"]} / {"contains":"x"}.',
    )
    .requiredOption('--where <json>', 'JSON predicate, e.g. \'{"status":"deprecated"}\'')
    .option('--sort <key[:dir]>', 'sort by a property (dir = asc|desc)')
    .option('--sort-numeric', 'compare the sort key numerically')
    .option('--limit <n>', 'max rows (default 100)')
    .option('--json', 'output JSON')
    .action(async (opts, command: Command) => {
      const q = buildWikiQuery(opts)
      const pages = await withDb(dbOptsFrom(command), (db) => queryPages(db, q))
      if (opts.json) {
        console.log(JSON.stringify(pages, null, 2))
        return
      }
      if (pages.length === 0) {
        console.log('No pages match.')
        return
      }
      for (const p of pages) {
        console.log(`${p.id}  [${p.pageType}]  ${p.title ?? p.slug}`)
      }
      console.log(`\n${pages.length} page(s).`)
    })

  wiki
    .command('list-properties')
    .alias('props')
    .description('List the distinct queryable property keys across the wiki (with counts).')
    .option('--json', 'output JSON')
    .action(async (opts, command: Command) => {
      const keys = await withDb(dbOptsFrom(command), (db) => listProperties(db))
      if (opts.json) {
        console.log(JSON.stringify(keys, null, 2))
        return
      }
      if (keys.length === 0) {
        console.log('No properties set on any page yet.')
        return
      }
      for (const k of keys as PropertyKeyInfo[]) {
        console.log(`${k.key}  (${k.count} page(s), ${k.types.join('/')})`)
      }
    })

  wiki
    .command('set-prop <ref>')
    .description('Set or delete one typed property on a page (mirrored for `wiki query`).')
    .requiredOption('--key <name>', 'property name')
    .option('--value <v>', 'property value (omit with --rm to delete the key)')
    .option('--type <t>', 'value type: string | number | boolean (default: inferred)')
    .option('--rm', 'delete the property instead of setting it')
    .option('--if-rev <rev>', 'only apply if the page rev still matches')
    .option('--agent <name>', 'agent source label')
    .option('--json', 'output JSON')
    .action(async (ref: string, opts, command: Command) => {
      const value = opts.rm ? null : coerceProp(opts.value, opts.type)
      try {
        const page = await withDb(dbOptsFrom(command), async (db) => {
          const target = await resolvePageRef(db, ref)
          if (!target) return null
          return setPageProps(
            db,
            target.id,
            { [opts.key]: value },
            { ifRev: opts.ifRev, agentSource: resolveAgent(opts.agent) },
          )
        })
        if (!page) {
          console.error(`No wiki page matching "${ref}".`)
          process.exitCode = 1
          return
        }
        console.log(
          opts.json
            ? JSON.stringify(page, null, 2)
            : `${opts.rm ? 'Removed' : 'Set'} ${opts.key} on "${page.title}" (rev ${page.rev})`,
        )
      } catch (e) {
        if (e instanceof RevConflictError) {
          console.error(
            `Conflict: the page changed since it was read (current rev ${e.currentRev}). Re-read and retry.`,
          )
          process.exitCode = 1
          return
        }
        throw e
      }
    })

  wiki.addCommand(tableCommand())
  wiki.addCommand(datatableCommand())
  wiki.addCommand(viewCommand())

  return wiki
}

/** Build a WikiQuery from the `wiki query` / `wiki view new` CLI options. */
function buildWikiQuery(opts: {
  where: string
  sort?: string
  sortNumeric?: boolean
  limit?: string
}): WikiQuery {
  let where: WhereClause
  try {
    const parsed = JSON.parse(opts.where)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('--where must be a JSON object')
    }
    where = parsed as WhereClause
  } catch (e) {
    throw new Error(`Invalid --where JSON: ${(e as Error).message}`)
  }
  const q: WikiQuery = { where }
  if (opts.sort) {
    const [key, dir] = opts.sort.split(':')
    q.sort = {
      key: (key ?? '').trim(),
      dir: dir === 'asc' ? 'asc' : 'desc',
      numeric: opts.sortNumeric === true,
    }
  }
  const limit = parsePositiveInt(opts.limit, '--limit')
  if (limit !== undefined) q.limit = limit
  return q
}

/** Parse repeatable `--prop key=value` options into a typed props record (values inferred). */
function parseProps(pairs: string[]): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  for (const pair of pairs) {
    const eq = pair.indexOf('=')
    if (eq < 1) throw new Error(`Invalid --prop "${pair}" (expected key=value)`)
    const key = pair.slice(0, eq).trim()
    if (!key) throw new Error(`Invalid --prop "${pair}" (empty key)`)
    out[key] = coerceProp(pair.slice(eq + 1))
  }
  return out
}

/** Coerce a CLI --value string to a typed prop (explicit --type, else inferred). */
function coerceProp(value: string | undefined, type?: string): string | number | boolean {
  if (value === undefined) throw new Error('--value is required unless --rm is given')
  if (type === 'number' || (type === undefined && /^-?\d+(\.\d+)?$/.test(value))) {
    const n = Number(value)
    if (!Number.isFinite(n)) throw new Error(`--value "${value}" is not a number`)
    return n
  }
  if (type === 'boolean' || (type === undefined && (value === 'true' || value === 'false'))) {
    if (value !== 'true' && value !== 'false') throw new Error('--value must be true or false')
    return value === 'true'
  }
  return value
}

/** `bctx wiki view new` — save a query as a `view` page rendered to a live GFM table. */
function viewCommand(): Command {
  const view = new Command('view').description(
    'Saved views: a `view` page whose body is a live GFM table of pages matching a saved query.',
  )

  view
    .command('new <title>')
    .description('Create a view from a --where query and the property --columns to project.')
    .requiredOption('--where <json>', 'JSON predicate (same grammar as `wiki query`)')
    .requiredOption('--columns <a,b,c>', 'property columns to show in the table')
    .option('--sort <key[:dir]>', 'sort by a property (dir = asc|desc)')
    .option('--sort-numeric', 'compare the sort key numerically')
    .option('--namespace <ns>', 'wiki namespace', 'wiki')
    .option('--tags <a,b,c>', 'comma-separated tags')
    .option('--agent <name>', 'agent source label')
    .option('--json', 'output JSON')
    .action(async (title: string, opts, command: Command) => {
      const query = buildWikiQuery(opts)
      const columns = splitCsv(opts.columns)
      const page = await withDb(dbOptsFrom(command), (db) =>
        createView(db, {
          title,
          query,
          columns,
          namespace: opts.namespace,
          tags: splitCsv(opts.tags),
          agentSource: resolveAgent(opts.agent),
        }),
      )
      console.log(
        opts.json
          ? JSON.stringify(page, null, 2)
          : `Created view "${page.title}" (${page.id}) [${page.slug}]`,
      )
    })

  return view
}

/** `bctx wiki datatable new` — create a page whose body is a canonical GFM table. */
function datatableCommand(): Command {
  const dt = new Command('datatable').description(
    'Datatables: a page whose body is one canonical GFM table, embeddable in many pages via ![[Title]].',
  )

  dt.command('new <title>')
    .description('Create a datatable page from column headers (and optional rows).')
    .requiredOption('--columns <a,b,c>', 'comma-separated column headers')
    .option('--row <a,b,c>', 'a row of cells in header order (repeatable)', collect, [])
    .option('--namespace <ns>', 'wiki namespace', 'wiki')
    .option('--tags <a,b,c>', 'comma-separated tags')
    .option('--agent <name>', 'agent source label')
    .option('--json', 'output JSON')
    .action(async (title: string, opts, command: Command) => {
      const columns = splitCsv(opts.columns)
      if (columns.length === 0) throw new Error('--columns must list at least one header')
      const rows = (opts.row as string[]).map((r) => splitCsv(r))
      const page = await withDb(dbOptsFrom(command), (db) =>
        createDatatable(db, {
          title,
          columns,
          rows,
          namespace: opts.namespace,
          tags: splitCsv(opts.tags),
          agentSource: resolveAgent(opts.agent),
        }),
      )
      console.log(
        opts.json
          ? JSON.stringify(page, null, 2)
          : `Created datatable "${page.title}" (${page.id}) [${page.slug}] — embed with ![[${page.title}]]`,
      )
    })

  dt.command('extract <ref>')
    .description(
      'Move a table out of a page into its own datatable, leaving a ![[Title]] embed in its place.',
    )
    .requiredOption('--title <title>', 'title for the new datatable page')
    .option('--caption <text>', 'heading above the table (to pick one of several)')
    .option('--table-index <n>', '0-based table index on the page')
    .option('--namespace <ns>', 'wiki namespace for the datatable (defaults to the source page)')
    .option('--if-rev <rev>', 'only apply if the page rev still matches (optimistic concurrency)')
    .option('--agent <name>', 'agent source label for this change')
    .option('--json', 'output JSON')
    .action(async (ref: string, opts, command: Command) => {
      const loc: TableLocator = {
        caption: opts.caption,
        tableIndex: parseTableIndex(opts.tableIndex),
      }
      try {
        const { datatable, page } = await withDb(dbOptsFrom(command), (db) =>
          extractTableToDatatable(db, ref, loc, {
            title: opts.title,
            namespace: opts.namespace,
            ifRev: opts.ifRev,
            agentSource: resolveAgent(opts.agent),
          }),
        )
        console.log(
          opts.json
            ? JSON.stringify({ datatable, page }, null, 2)
            : `Extracted table from "${page.title}" into datatable "${datatable.title}" (${datatable.id}) [${datatable.slug}] — source now embeds ![[${datatable.title}]] (rev ${page.rev})`,
        )
      } catch (e) {
        if (!reportTableError(e)) throw e
      }
    })

  return dt
}

/** Parse a 0-based table index (0 is valid, unlike parsePositiveInt). */
function parseTableIndex(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const n = Number(value)
  if (!Number.isInteger(n) || n < 0) throw new Error('--table-index must be a non-negative integer')
  return n
}

/** Parse a column alignment flag (left | right | center; null = default). */
function parseAlign(value: string | undefined): Align | null {
  if (value === undefined) return null
  if (value === 'left' || value === 'right' || value === 'center') return value
  throw new Error('--align must be left, right, or center')
}

/** Print a handled table-op error and set a failing exit code; returns true if handled. */
function reportTableError(e: unknown): boolean {
  if (e instanceof RevConflictError) {
    console.error(
      `Conflict: the page changed since it was read (current rev ${e.currentRev}). Re-read and retry.`,
    )
    process.exitCode = 1
    return true
  }
  if (e instanceof TableError) {
    console.error(e.message)
    process.exitCode = 1
    return true
  }
  return false
}

/** Print a handled section/replace edit error and fail the exit code; true if handled. */
function reportEditError(e: unknown): boolean {
  if (e instanceof RevConflictError) {
    console.error(
      `Conflict: the page changed since it was read (current rev ${e.currentRev}). Re-read and retry.`,
    )
    process.exitCode = 1
    return true
  }
  if (e instanceof EditError) {
    console.error(e.message)
    process.exitCode = 1
    return true
  }
  return false
}

/** `bctx wiki table get|set|add-row|rm-row` — edit a GFM table by cell/row (no body rewrite). */
function tableCommand(): Command {
  const table = new Command('table').description(
    'Edit a GFM table inside a page body by cell/row — no whole-body rewrite.',
  )
  const locatorOpts = (c: Command): Command =>
    c
      .option('--caption <text>', 'heading above the table (to pick one of several)')
      .option('--table-index <n>', '0-based table index on the page')

  locatorOpts(table.command('get <ref>'))
    .description('Read a table as structured rows (header + rows + rev, no page body).')
    .option('--json', 'output JSON')
    .action(async (ref: string, opts, command: Command) => {
      const loc: TableLocator = {
        caption: opts.caption,
        tableIndex: parseTableIndex(opts.tableIndex),
      }
      try {
        const view = await withDb(dbOptsFrom(command), (db) => tableGet(db, ref, loc))
        if (opts.json) {
          console.log(JSON.stringify(view, null, 2))
          return
        }
        const heading = view.headingAbove ? ` — ${view.headingAbove}` : ''
        console.log(
          `[${view.slug ?? view.pageId}] table #${view.tableIndex}${heading}  rev ${view.rev}`,
        )
        console.log(serializeTable(view))
      } catch (e) {
        if (!reportTableError(e)) throw e
      }
    })

  locatorOpts(table.command('set <ref>'))
    .description('Set one cell (addressed by --row + --col), leaving the rest byte-identical.')
    .requiredOption('--row <key>', 'first-column value of the row (or a 0-based ordinal)')
    .requiredOption('--col <name>', 'column header name (or a 0-based ordinal)')
    .requiredOption('--value <text>', 'the new cell value')
    .option('--if-rev <rev>', 'only apply if the page rev still matches (optimistic concurrency)')
    .option('--agent <name>', 'agent source label for this change')
    .option('--json', 'output JSON')
    .action(async (ref: string, opts, command: Command) => {
      const loc: TableLocator = {
        caption: opts.caption,
        tableIndex: parseTableIndex(opts.tableIndex),
      }
      try {
        const page = await withDb(dbOptsFrom(command), (db) =>
          tableSetCell(db, ref, loc, opts.row, opts.col, opts.value, {
            ifRev: opts.ifRev,
            agentSource: resolveAgent(opts.agent),
          }),
        )
        console.log(
          opts.json
            ? JSON.stringify(page, null, 2)
            : `Updated cell in "${page.title}" (rev ${page.rev})`,
        )
      } catch (e) {
        if (!reportTableError(e)) throw e
      }
    })

  locatorOpts(table.command('add-row <ref>'))
    .description('Append a row; --cells are given in header order.')
    .requiredOption('--cells <a,b,c>', 'comma-separated cell values in header order')
    .option('--if-rev <rev>', 'only apply if the page rev still matches (optimistic concurrency)')
    .option('--agent <name>', 'agent source label for this change')
    .option('--json', 'output JSON')
    .action(async (ref: string, opts, command: Command) => {
      const loc: TableLocator = {
        caption: opts.caption,
        tableIndex: parseTableIndex(opts.tableIndex),
      }
      try {
        const page = await withDb(dbOptsFrom(command), (db) =>
          tableAddRow(db, ref, loc, splitCsv(opts.cells) ?? [], {
            ifRev: opts.ifRev,
            agentSource: resolveAgent(opts.agent),
          }),
        )
        console.log(
          opts.json
            ? JSON.stringify(page, null, 2)
            : `Added row to "${page.title}" (rev ${page.rev})`,
        )
      } catch (e) {
        if (!reportTableError(e)) throw e
      }
    })

  locatorOpts(table.command('rm-row <ref>'))
    .description('Delete the row matching --row (first-column value or ordinal).')
    .requiredOption('--row <key>', 'first-column value of the row (or a 0-based ordinal)')
    .option('--if-rev <rev>', 'only apply if the page rev still matches (optimistic concurrency)')
    .option('--agent <name>', 'agent source label for this change')
    .option('--json', 'output JSON')
    .action(async (ref: string, opts, command: Command) => {
      const loc: TableLocator = {
        caption: opts.caption,
        tableIndex: parseTableIndex(opts.tableIndex),
      }
      try {
        const page = await withDb(dbOptsFrom(command), (db) =>
          tableDeleteRow(db, ref, loc, opts.row, {
            ifRev: opts.ifRev,
            agentSource: resolveAgent(opts.agent),
          }),
        )
        console.log(
          opts.json
            ? JSON.stringify(page, null, 2)
            : `Deleted row from "${page.title}" (rev ${page.rev})`,
        )
      } catch (e) {
        if (!reportTableError(e)) throw e
      }
    })

  locatorOpts(table.command('add-col <ref>'))
    .description('Insert a column (appends unless --at); every row gets an empty cell.')
    .requiredOption('--name <text>', 'the new column header')
    .option('--at <n>', '0-based position to insert at (default: append at the end)')
    .option('--align <dir>', 'column alignment: left | right | center')
    .option('--if-rev <rev>', 'only apply if the page rev still matches (optimistic concurrency)')
    .option('--agent <name>', 'agent source label for this change')
    .option('--json', 'output JSON')
    .action(async (ref: string, opts, command: Command) => {
      const loc: TableLocator = {
        caption: opts.caption,
        tableIndex: parseTableIndex(opts.tableIndex),
      }
      try {
        const page = await withDb(dbOptsFrom(command), (db) =>
          tableAddColumn(
            db,
            ref,
            loc,
            { name: opts.name, at: parseTableIndex(opts.at), align: parseAlign(opts.align) },
            { ifRev: opts.ifRev, agentSource: resolveAgent(opts.agent) },
          ),
        )
        console.log(
          opts.json
            ? JSON.stringify(page, null, 2)
            : `Added column "${opts.name}" to "${page.title}" (rev ${page.rev})`,
        )
      } catch (e) {
        if (!reportTableError(e)) throw e
      }
    })

  locatorOpts(table.command('rm-col <ref>'))
    .description('Delete a column by --col (header name or 0-based index).')
    .requiredOption('--col <name>', 'column header name (or a 0-based index)')
    .option('--if-rev <rev>', 'only apply if the page rev still matches (optimistic concurrency)')
    .option('--agent <name>', 'agent source label for this change')
    .option('--json', 'output JSON')
    .action(async (ref: string, opts, command: Command) => {
      const loc: TableLocator = {
        caption: opts.caption,
        tableIndex: parseTableIndex(opts.tableIndex),
      }
      try {
        const page = await withDb(dbOptsFrom(command), async (db) => {
          const col = await resolveCliColumn(db, ref, loc, opts.col)
          return tableDeleteColumn(db, ref, loc, col, {
            ifRev: opts.ifRev,
            agentSource: resolveAgent(opts.agent),
          })
        })
        console.log(
          opts.json
            ? JSON.stringify(page, null, 2)
            : `Deleted column from "${page.title}" (rev ${page.rev})`,
        )
      } catch (e) {
        if (!reportTableError(e)) throw e
      }
    })

  locatorOpts(table.command('rename-col <ref>'))
    .description('Rename a column header (--col names the current header or a 0-based index).')
    .requiredOption('--col <name>', 'current column header name (or a 0-based index)')
    .requiredOption('--name <text>', 'the new column header')
    .option('--if-rev <rev>', 'only apply if the page rev still matches (optimistic concurrency)')
    .option('--agent <name>', 'agent source label for this change')
    .option('--json', 'output JSON')
    .action(async (ref: string, opts, command: Command) => {
      const loc: TableLocator = {
        caption: opts.caption,
        tableIndex: parseTableIndex(opts.tableIndex),
      }
      try {
        const page = await withDb(dbOptsFrom(command), async (db) => {
          const col = await resolveCliColumn(db, ref, loc, opts.col)
          return tableRenameColumn(db, ref, loc, col, opts.name, {
            ifRev: opts.ifRev,
            agentSource: resolveAgent(opts.agent),
          })
        })
        console.log(
          opts.json
            ? JSON.stringify(page, null, 2)
            : `Renamed column to "${opts.name}" in "${page.title}" (rev ${page.rev})`,
        )
      } catch (e) {
        if (!reportTableError(e)) throw e
      }
    })

  return table
}

/** Resolve a column reference (header name or ordinal) to an index for CLI column ops. */
async function resolveCliColumn(
  db: Parameters<typeof tableGet>[0],
  ref: string,
  loc: TableLocator,
  colRef: string,
): Promise<number> {
  const view = await tableGet(db, ref, loc)
  const col = columnIndex(view, colRef)
  if (col < 0) {
    throw new TableError(`no column "${colRef}" (headers: ${view.header.join(', ') || '<none>'})`)
  }
  return col
}
