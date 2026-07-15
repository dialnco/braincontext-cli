import { type McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Kysely } from 'kysely'
import { z } from 'zod'
import { RevConflictError } from '../core/contexts'
import { createDatatable, expandTransclusions } from '../core/datatable'
import { EditError, editPage, getPageSection, patchPageSection } from '../core/edit'
import { listProperties, queryPages, renderView, type WhereClause } from '../core/query'
import {
  TableError,
  tableAddColumn,
  tableAddRow,
  tableDeleteColumn,
  tableDeleteRow,
  tableGet,
  tableRenameColumn,
  tableSetCell,
} from '../core/tables'
import {
  AUTHORED_PAGE_TYPES,
  type Database,
  EMBEDS_LINK,
  LINK_TYPES,
  REFERENCES_LINK,
} from '../core/types'
import {
  addLink,
  appendLog,
  backlinks,
  createPage,
  createView,
  getPage,
  ingestStatus,
  linkPath,
  lint,
  listPages,
  outboundLinks,
  pageFreshness,
  pagePeek,
  recordSource,
  relatedPages,
  removeLink,
  resolvePageRef,
  searchPages,
  setPageProps,
  updatePage,
  verifyPage,
  wikiGraph,
} from '../core/wiki'
import { columnIndex } from '../lib/mdtable'
import { truncateAtTokens } from '../lib/outline'
import { estimateTokens, formatTokens } from '../lib/tokens'
import { driftFindings, snapshotSourceHashes } from '../wiki/drift'

function ok(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] }
}
function fail(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true }
}
/** Map a table op's expected failures (bad locator; stale-rev conflict) to error results. */
function tableFail(e: unknown) {
  if (e instanceof RevConflictError) {
    return fail(JSON.stringify({ error: 'rev_conflict', currentRev: e.currentRev }, null, 2))
  }
  if (e instanceof TableError) return fail(e.message)
  throw e
}
/** Resolve a column reference (header name or ordinal) to an index for the column ops. */
async function resolveMcpColumn(
  db: Parameters<typeof tableGet>[0],
  ref: string,
  loc: Parameters<typeof tableGet>[2],
  colRef: string,
): Promise<number> {
  const view = await tableGet(db, ref, loc)
  const col = columnIndex(view, colRef)
  if (col < 0) {
    throw new TableError(`no column "${colRef}" (headers: ${view.header.join(', ') || '<none>'})`)
  }
  return col
}
/** Map a section/find edit's expected failures (missing/ambiguous anchor; CAS) to results. */
function editFail(e: unknown) {
  if (e instanceof RevConflictError) {
    return fail(JSON.stringify({ error: 'rev_conflict', currentRev: e.currentRev }, null, 2))
  }
  if (e instanceof EditError) return fail(e.message)
  throw e
}
async function resolveRef(db: Kysely<Database>, ref: string) {
  return resolvePageRef(db, ref)
}

const scalarSchema = z.union([z.string(), z.number(), z.boolean()])
/** A per-key comparison for wiki_query (mirrors core/query.ts Comparison). */
const comparisonSchema = z
  .object({
    eq: scalarSchema.optional(),
    ne: scalarSchema.optional(),
    lt: z.number().optional(),
    gt: z.number().optional(),
    lte: z.number().optional(),
    gte: z.number().optional(),
    contains: z.string().optional(),
    in: z.array(scalarSchema).optional(),
    exists: z.boolean().optional(),
  })
  .strict()
/** where: each key ANDed; value is a scalar (implicit eq) or a comparison object. */
const whereSchema = z.record(z.string(), z.union([scalarSchema, comparisonSchema]))
/** props: typed scalar properties set on a page (null deletes on wiki_update). */
const propsSchema = z.record(z.string(), z.union([scalarSchema, z.null()]))

/** Register the wiki tool surface + a wiki resource on an existing MCP server. */
export function registerWikiTools(server: McpServer, db: Kysely<Database>): void {
  server.registerTool(
    'wiki_search',
    {
      title: 'Search wiki',
      description:
        'Full-text search (FTS5/BM25) across wiki pages. Returns compact hits — snippet + tokenEstimate, no bodies — so results are cheap: follow up with wiki_get {detail:"peek"} on promising hits, then fetch full only the pages you will actually use. After synthesizing a worthwhile answer, file it back so the exploration compounds: prefer wiki_update on the most relevant existing page, or wiki_new {type:"analysis"} when there is no home for it yet.',
      inputSchema: {
        query: z.string(),
        type: z.enum(AUTHORED_PAGE_TYPES).optional(),
        namespace: z.string().optional(),
        limit: z.number().int().positive().optional(),
      },
    },
    async ({ query, type, namespace, limit }) => {
      const hits = await searchPages(db, query, { pageType: type, namespace, limit })
      return ok(
        hits.map((p) => ({
          id: p.id,
          slug: p.slug,
          title: p.title,
          pageType: p.pageType,
          tags: p.tags,
          tokenEstimate: estimateTokens(p.body),
          snippet: p.snippet ?? null,
          updatedAt: p.updatedAt,
        })),
      )
    },
  )

  server.registerTool(
    'wiki_get',
    {
      title: 'Get wiki page',
      description:
        'Fetch a wiki page (by id, slug, or title). detail:"peek" returns outline + excerpt + links + token cost instead of the body — use it to decide whether the full page is worth its tokenEstimate. maxTokens truncates a full body at a paragraph boundary. Pass ifChangedSince with a rev you already have to get a tiny NOT_MODIFIED sentinel (instead of re-reading the body) when the page is unchanged.',
      inputSchema: {
        ref: z.string().describe('page id, slug, or title'),
        detail: z
          .enum(['peek', 'full'])
          .default('full')
          .describe('peek = outline/excerpt/links/cost only (no body)'),
        maxTokens: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('truncate the body to ~this many tokens (detail:"full" only)'),
        ifChangedSince: z
          .string()
          .optional()
          .describe('a rev from a prior read; returns NOT_MODIFIED when the page is unchanged'),
        section: z
          .string()
          .optional()
          .describe('return only this heading-anchored section (heading text, no #) + rev'),
        embed: z
          .boolean()
          .default(true)
          .describe('inline ![[Title]] transclusions with the embedded page body (detail:"full")'),
      },
    },
    async ({ ref, detail, maxTokens, ifChangedSince, section, embed }) => {
      const page = await resolveRef(db, ref)
      if (!page) return fail(`No wiki page matching "${ref}"`)
      if (ifChangedSince !== undefined && ifChangedSince === page.rev) {
        return ok({ status: 'NOT_MODIFIED', id: page.id, rev: page.rev })
      }
      // A single section is the cheapest read: just that heading's slice + rev (no full body).
      if (section !== undefined) {
        try {
          return ok(await getPageSection(db, ref, section))
        } catch (e) {
          return editFail(e)
        }
      }
      if (detail === 'peek') {
        const peek = await pagePeek(db, page.id)
        return peek ? ok(peek) : fail(`No wiki page matching "${ref}"`)
      }
      const [outbound, back] = await Promise.all([
        outboundLinks(db, page.id),
        backlinks(db, page.id),
      ])
      // A `view` renders live from its saved query; otherwise `![[Title]]` embeds inline the
      // referenced page (a datatable, typically) so one source reflects into every consumer.
      // The stored body is untouched; `rev` still tracks this page's own edits.
      let body: string
      if (page.pageType === 'view') body = await renderView(db, page.metadata)
      else body = embed ? await expandTransclusions(db, page.body) : page.body
      const fullTokens = estimateTokens(body)
      if (maxTokens) {
        const t = truncateAtTokens(body, maxTokens)
        if (t.truncated) {
          body = `${t.text}\n\n[truncated at ~${t.returnedTokens} of ~${t.totalTokens} tokens — call wiki_get without maxTokens for the rest]`
        }
      }
      return ok({
        page: { ...page, body },
        tokenEstimate: fullTokens,
        freshness: pageFreshness(page),
        outbound,
        backlinks: back,
      })
    },
  )

  server.registerTool(
    'wiki_new',
    {
      title: 'Create wiki page',
      description:
        'Create a wiki page. Use [[Title]] in the body to cross-link other pages. Declare the source files the page documents via `sources` so agents can find the relevant files and drift can be detected.',
      inputSchema: {
        title: z.string(),
        type: z.enum(AUTHORED_PAGE_TYPES),
        body: z.string().optional(),
        namespace: z.string().optional(),
        tags: z.array(z.string()).optional(),
        sources: z
          .array(z.string())
          .optional()
          .describe('repo-relative source files this page documents'),
        props: propsSchema
          .optional()
          .describe('typed properties for wiki_query, e.g. {status:"active", priority:2}'),
        agent: z.string().optional(),
      },
    },
    async ({ title, type, body, namespace, tags, sources, props, agent }) => {
      const metadata: Record<string, unknown> = {}
      if (sources && sources.length > 0) metadata.sources = sources
      if (props) {
        const clean: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(props)) if (v !== null) clean[k] = v
        if (Object.keys(clean).length > 0) metadata.props = clean
      }
      return ok(
        await createPage(db, {
          title,
          pageType: type,
          body,
          namespace,
          tags,
          agentSource: agent,
          metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
        }),
      )
    },
  )

  server.registerTool(
    'wiki_datatable_new',
    {
      title: 'Create datatable',
      description:
        'Create a datatable: a wiki page whose body is a single canonical GFM table. Give columns (and optional rows). Other pages embed it with ![[Title]], so one table backs many pages — edit it once with wiki_table_set_cell/add_row and every consumer reflects the change. Use this (not wiki_new + a hand-written table) when the data is filtered, queried per-row, or reused across pages.',
      inputSchema: {
        title: z.string(),
        columns: z.array(z.string()).min(1).describe('column headers'),
        rows: z
          .array(z.array(z.string()))
          .optional()
          .describe('initial rows, each an array of cell strings aligned to columns'),
        namespace: z.string().optional(),
        tags: z.array(z.string()).optional(),
        agent: z.string().optional(),
      },
    },
    async ({ title, columns, rows, namespace, tags, agent }) =>
      ok(
        await createDatatable(db, {
          title,
          columns,
          rows,
          namespace,
          tags,
          agentSource: agent,
        }),
      ),
  )

  server.registerTool(
    'wiki_query',
    {
      title: 'Query pages by property',
      description:
        'Find wiki pages by their typed properties (set via `props` on wiki_new/wiki_update, or wiki_set_prop). `where` is an object; every key is ANDed and its value is a scalar (exact match) or a condition object: {eq,ne,lt,gt,lte,gte,contains,in,exists}. Returns compact hits (no bodies). Discover property keys with wiki_list_properties first.',
      inputSchema: {
        where: whereSchema.describe('property predicate; keys ANDed'),
        sort: z
          .object({
            key: z.string(),
            dir: z.enum(['asc', 'desc']).optional(),
            numeric: z.boolean().optional().describe('compare the sort key numerically'),
          })
          .optional(),
        limit: z.number().int().positive().optional(),
      },
    },
    async ({ where, sort, limit }) => {
      const pages = await queryPages(db, { where: where as WhereClause, sort, limit })
      return ok({
        count: pages.length,
        pages: pages.map((p) => ({
          id: p.id,
          slug: p.slug,
          title: p.title,
          pageType: p.pageType,
          rev: p.rev,
          props: p.metadata.props ?? {},
        })),
      })
    },
  )

  server.registerTool(
    'wiki_list_properties',
    {
      title: 'List property keys',
      description:
        'Discover the queryable property keys across the wiki, each with how many pages carry it and its value type(s) — use before wiki_query to know what you can filter on.',
      inputSchema: {},
    },
    async () => ok({ properties: await listProperties(db) }),
  )

  server.registerTool(
    'wiki_set_prop',
    {
      title: 'Set page property',
      description:
        'Set or delete ONE typed property on a page (mirrored for wiki_query). Merges into the existing props. Pass value:null to delete the key. For several at once, use `props` on wiki_update.',
      inputSchema: {
        ref: z.string().describe('page id, slug, or title'),
        key: z.string(),
        value: z
          .union([z.string(), z.number(), z.boolean(), z.null()])
          .describe('scalar value, or null to delete the key'),
        ifRev: z.string().optional(),
        agent: z.string().optional(),
      },
    },
    async ({ ref, key, value, ifRev, agent }) => {
      const page = await resolveRef(db, ref)
      if (!page) return fail(`No wiki page matching "${ref}"`)
      try {
        const updated = await setPageProps(
          db,
          page.id,
          { [key]: value },
          { ifRev, agentSource: agent },
        )
        return updated ? ok(updated) : fail(`No wiki page matching "${ref}"`)
      } catch (e) {
        return tableFail(e)
      }
    },
  )

  server.registerTool(
    'wiki_view_new',
    {
      title: 'Create saved view',
      description:
        'Save a query as a `view` page: its body is a live GFM table of the pages matching `where`, projecting the given `columns` (property names). Re-renders on every read, so it always reflects the current graph. A "database OF pages".',
      inputSchema: {
        title: z.string(),
        where: whereSchema,
        columns: z.array(z.string()).describe('property names to show as table columns'),
        sort: z
          .object({
            key: z.string(),
            dir: z.enum(['asc', 'desc']).optional(),
            numeric: z.boolean().optional(),
          })
          .optional(),
        namespace: z.string().optional(),
        tags: z.array(z.string()).optional(),
        agent: z.string().optional(),
      },
    },
    async ({ title, where, columns, sort, namespace, tags, agent }) =>
      ok(
        await createView(db, {
          title,
          query: { where: where as WhereClause, sort },
          columns,
          namespace,
          tags,
          agentSource: agent,
        }),
      ),
  )

  server.registerTool(
    'wiki_update',
    {
      title: 'Update wiki page',
      description:
        'Edit an existing wiki page (by id, slug, or title): body, title, tags. Re-syncs [[links]] from the new body. PREFER this over wiki_new when knowledge already has a home — refine the existing page so the wiki compounds instead of accumulating duplicate-titled pages. Source pages are immutable (use wiki_ingest for new sources).',
      inputSchema: {
        ref: z.string().describe('page id, slug, or title'),
        title: z.string().optional(),
        body: z.string().optional(),
        addTags: z.array(z.string()).optional(),
        removeTags: z.array(z.string()).optional(),
        sources: z
          .array(z.string())
          .optional()
          .describe('replace the repo-relative source files this page documents'),
        props: propsSchema
          .optional()
          .describe('merge typed properties (for wiki_query); a null value deletes that key'),
        ifRev: z
          .string()
          .optional()
          .describe('rev from your last read; the edit is rejected if the page changed since'),
        agent: z.string().optional(),
      },
    },
    async ({ ref, title, body, addTags, removeTags, sources, props, ifRev, agent }) => {
      const page = await resolveRef(db, ref)
      if (!page) return fail(`No wiki page matching "${ref}"`)
      try {
        // Merge props into the page's existing props (null deletes), so the mirror reflects
        // the intended set. Passed via setMetadata.props alongside any sources replacement.
        const setMetadata: Record<string, unknown> = {}
        if (sources !== undefined) setMetadata.sources = sources
        if (props) {
          const merged: Record<string, unknown> = { ...(page.metadata.props as object) }
          for (const [k, v] of Object.entries(props)) {
            if (v === null) delete merged[k]
            else merged[k] = v
          }
          setMetadata.props = merged
        }
        const updated = await updatePage(db, page.id, {
          title,
          body,
          addTags,
          removeTags,
          setMetadata: Object.keys(setMetadata).length > 0 ? setMetadata : undefined,
          ifRev,
          agentSource: agent,
        })
        return updated ? ok(updated) : fail(`No wiki page matching "${ref}"`)
      } catch (e) {
        // Surface a stale-rev conflict with the current rev so the agent can re-read + retry.
        if (e instanceof RevConflictError) {
          return fail(JSON.stringify({ error: 'rev_conflict', currentRev: e.currentRev }, null, 2))
        }
        // updatePage throws on source pages ('source pages are immutable').
        return fail((e as Error).message)
      }
    },
  )

  server.registerTool(
    'wiki_patch_section',
    {
      title: 'Patch a section',
      description:
        'Replace ONE heading-anchored section of a page instead of re-emitting the whole body — cheaper and safer for a targeted edit. Address it by heading text (no #); `body` is spliced in verbatim, so include the heading line to keep it. Refuses if the heading is missing or matches more than one section. Read it first with wiki_get {section} and pass its rev as ifRev.',
      inputSchema: {
        ref: z.string().describe('page id, slug, or title'),
        section: z.string().describe('heading text of the section to replace (no #)'),
        body: z.string().describe('the new section markdown (include the heading line to keep it)'),
        ifRev: z.string().optional(),
        agent: z.string().optional(),
      },
    },
    async ({ ref, section, body, ifRev, agent }) => {
      try {
        return ok(await patchPageSection(db, ref, section, body, { ifRev, agentSource: agent }))
      } catch (e) {
        return editFail(e)
      }
    },
  )

  server.registerTool(
    'wiki_replace',
    {
      title: 'Anchored find/replace',
      description:
        "Fix one sentence/link/value with a small exact find→replace instead of rewriting the body. EXACT-MATCH-OR-REFUSE: with no occurrence, `find` must appear exactly once (else it refuses); if it appears N times, pass occurrence (1-based) to pick one. A miss is never a silent no-op. Ideal for prose/bullets/links a table or section op can't target.",
      inputSchema: {
        ref: z.string().describe('page id, slug, or title'),
        find: z.string().describe('exact text to find'),
        replace: z.string().describe('replacement text'),
        occurrence: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('1-based which match to replace (required when `find` occurs more than once)'),
        ifRev: z.string().optional(),
        agent: z.string().optional(),
      },
    },
    async ({ ref, find, replace, occurrence, ifRev, agent }) => {
      try {
        return ok(await editPage(db, ref, find, replace, { occurrence, ifRev, agentSource: agent }))
      } catch (e) {
        return editFail(e)
      }
    },
  )

  server.registerTool(
    'wiki_link',
    {
      title: 'Link wiki pages',
      description:
        'Add a typed link between pages (target may be a not-yet-created title => a wanted link).',
      inputSchema: {
        from: z.string().describe('source page id, slug, or title'),
        to: z.string().describe('target page id, slug, or title'),
        type: z.enum(LINK_TYPES).default('relates'),
      },
    },
    async ({ from, to, type }) => {
      const f = await resolveRef(db, from)
      if (!f) return fail(`No source page matching "${from}"`)
      const t = await resolveRef(db, to)
      await addLink(db, f.id, t ? { toId: t.id, type } : { toTitle: to, type })
      return ok({ from: f.id, to: t?.id ?? null, toTitle: t ? null : to, type, wanted: !t })
    },
  )

  server.registerTool(
    'wiki_unlink',
    {
      title: 'Unlink wiki pages',
      description:
        'Remove a typed link from a source page to a target (by id or title). Omit `type` to remove links of any type to that target.',
      inputSchema: {
        from: z.string().describe('source page id, slug, or title'),
        to: z.string().describe('target page id, slug, or title'),
        type: z.enum(LINK_TYPES).optional(),
      },
    },
    async ({ from, to, type }) => {
      const f = await resolveRef(db, from)
      if (!f) return fail(`No source page matching "${from}"`)
      const t = await resolveRef(db, to)
      await removeLink(db, f.id, t ? { toId: t.id, type } : { toTitle: to, type })
      return ok({ from: f.id, to: t?.id ?? null, toTitle: t ? null : to, type: type ?? null })
    },
  )

  server.registerTool(
    'wiki_ingest',
    {
      title: 'Ingest a source',
      description:
        'Store a raw source (immutable) and return a synthesis checklist. You then create/update pages with the other wiki tools.',
      inputSchema: {
        source: z.string().describe('the raw source text'),
        title: z.string().optional(),
        uri: z.string().optional(),
        agent: z.string().optional(),
      },
    },
    async ({ source, title, uri, agent }) => {
      const name = title ?? 'untitled source'
      const page = await recordSource(db, { title: name, body: source, uri, agentSource: agent })
      await appendLog(db, { op: 'ingest', refId: page.id, title: name, agentSource: agent })
      return ok({
        sourceId: page.id,
        checklist: [
          'Write a summary page: wiki_new {type:"summary"}',
          'Link summary→source: wiki_link {type:"source"}',
          'Update ~5–15 related entity/concept pages with wiki_update (edit in place — do NOT create duplicates), weaving in [[links]]; reconcile any contradictions',
          'Refresh the catalog so it reflects the new/updated pages (bctx wiki index --out index.md)',
          'Run wiki_lint to check health (orphans, dangling/wanted links, contradictions, data gaps)',
          'Verify the pages you touched: wiki_verify {ref} — keeps freshness tracking honest',
        ],
      })
    },
  )

  server.registerTool(
    'wiki_ingest_status',
    {
      title: 'Ingest synthesis status',
      description:
        'Report how far the post-ingest synthesis got for a source (summary written? related pages updated? index refreshed? verified?). Derived from the graph, so it is resumable across sessions — run it to pick up an interrupted ingest where it left off.',
      inputSchema: { ref: z.string().describe('source page id, slug, or title') },
    },
    async ({ ref }) => {
      const page = await resolveRef(db, ref)
      const status = page ? await ingestStatus(db, page.id) : null
      return status ? ok(status) : fail(`No source page matching "${ref}"`)
    },
  )

  server.registerTool(
    'wiki_verify',
    {
      title: 'Verify wiki page',
      description:
        'Mark a page as verified — you have just confirmed its content is still accurate. Pages not verified or updated within the stale window (default 45 days) surface as stale/never-verified in wiki_lint. Run after checking or refreshing a page.',
      inputSchema: {
        ref: z.string().describe('page id, slug, or title'),
        agent: z.string().optional(),
      },
    },
    async ({ ref, agent }) => {
      const page = await resolveRef(db, ref)
      if (!page) return fail(`No wiki page matching "${ref}"`)
      try {
        const updated = await verifyPage(db, page.id, { agent })
        if (!updated) return fail(`No wiki page matching "${ref}"`)
        // Baseline declared source files for drift detection. Paths resolve against
        // the MCP server's working directory (normally the project root).
        const sourceHashes = await snapshotSourceHashes(db, updated.id, process.cwd())
        return ok({
          id: updated.id,
          title: updated.title,
          freshness: pageFreshness(updated),
          sourceHashes,
        })
      } catch (e) {
        // verifyPage throws on source pages ('source pages are immutable').
        return fail((e as Error).message)
      }
    },
  )

  server.registerTool(
    'wiki_lint',
    {
      title: 'Lint the wiki',
      description:
        'Report wiki health issues (orphans, dangling/wanted links, ambiguous titles, stale/never-verified pages, ...). With drift:true, also flags pages whose declared source files changed since their last verify (paths resolve against the server working directory).',
      inputSchema: {
        staleDays: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('stale window in days (default 45)'),
        drift: z
          .boolean()
          .optional()
          .describe('also check declared source files for code↔doc drift'),
      },
    },
    async ({ staleDays, drift }) => {
      const report = await lint(db, { staleDays })
      if (drift) {
        const findings = await driftFindings(db, process.cwd())
        report.findings.push(...findings)
        if (findings.length > 0) report.counts.drift = findings.length
      }
      return ok(report)
    },
  )

  server.registerTool(
    'wiki_graph',
    {
      title: 'Wiki graph',
      description:
        'Return the wiki link graph — pages (nodes, with degree) and their typed edges — for navigation and overview. Optionally scope to a namespace; on large wikis use minDegree/limit to get the well-connected core instead of thousands of nodes. For the neighborhood of ONE page use wiki_related; for how two pages connect use wiki_path — both are much cheaper than the full graph.',
      inputSchema: {
        namespace: z.string().optional(),
        minDegree: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe('drop nodes with fewer connections than this'),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('keep only the N best-connected nodes'),
      },
    },
    async ({ namespace, minDegree, limit }) =>
      ok(await wikiGraph(db, { namespace, minDegree, limit })),
  )

  server.registerTool(
    'wiki_related',
    {
      title: 'Related pages',
      description:
        'The pages reachable within `depth` hops of a page in the link graph (links traversed in both directions), nearest first. Each hit says which link first reached it (type + direction + the page it came through). Cheaper and more precise than wiki_graph when you want the neighborhood of ONE page — use it to assemble context around the page you are working from.',
      inputSchema: {
        ref: z.string().describe('page id, slug, or title'),
        depth: z.number().int().positive().max(5).default(1).describe('hops to traverse'),
        types: z
          .array(z.enum([...LINK_TYPES, REFERENCES_LINK, EMBEDS_LINK]))
          .optional()
          .describe('only traverse these link types (default: all)'),
        limit: z.number().int().positive().optional().describe('max pages returned'),
      },
    },
    async ({ ref, depth, types, limit }) => {
      const page = await resolveRef(db, ref)
      if (!page) return fail(`No wiki page matching "${ref}"`)
      const related = await relatedPages(db, page.id, { depth, types, limit })
      if (!related) return fail(`No wiki page matching "${ref}"`)
      return ok({ center: { id: page.id, title: page.title }, count: related.length, related })
    },
  )

  server.registerTool(
    'wiki_path',
    {
      title: 'Path between pages',
      description:
        'The shortest chain of links connecting two pages (links traversed in both directions). Each step reports the link type and its true direction — use it to see HOW two concepts relate, not just whether they do. Returns found:false when no chain exists within maxHops.',
      inputSchema: {
        from: z.string().describe('start page id, slug, or title'),
        to: z.string().describe('end page id, slug, or title'),
        maxHops: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('give up beyond this many hops (default 10)'),
      },
    },
    async ({ from, to, maxHops }) => {
      const f = await resolveRef(db, from)
      if (!f) return fail(`No wiki page matching "${from}"`)
      const t = await resolveRef(db, to)
      if (!t) return fail(`No wiki page matching "${to}"`)
      const path = await linkPath(db, f.id, t.id, { maxHops })
      if (!path) return fail('Both endpoints must be live wiki pages')
      return ok(path)
    },
  )

  // --- table cell/row ops (edit a GFM table in a page body without rewriting it) ----------
  const tableLocator = {
    ref: z.string().describe('page id, slug, or title'),
    caption: z.string().optional().describe('heading above the table (to pick one of several)'),
    tableIndex: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('0-based table index on the page'),
  }

  server.registerTool(
    'wiki_table_get',
    {
      title: 'Read a table',
      description:
        'Read a GFM table from a wiki page as structured rows (header + rows + alignment + rev) WITHOUT the page body. Do this before editing: pass the returned rev back as ifRev on wiki_table_set_cell so a concurrent change is caught instead of clobbered. Use caption/tableIndex when a page has several tables.',
      inputSchema: tableLocator,
    },
    async ({ ref, caption, tableIndex }) => {
      try {
        const view = await tableGet(db, ref, { caption, tableIndex })
        return ok({
          ...view,
          next: [
            {
              tool: 'wiki_table_set_cell',
              args: {
                ref,
                tableIndex: view.tableIndex,
                row: '<a value from the first column>',
                column: '<a header name>',
                value: '<new value>',
                ifRev: view.rev,
              },
            },
          ],
        })
      } catch (e) {
        return tableFail(e)
      }
    },
  )

  server.registerTool(
    'wiki_table_set_cell',
    {
      title: 'Set one table cell',
      description:
        'Change ONE cell of a table in place. Do NOT wiki_get + regenerate the whole body — that wastes output tokens and risks corrupting the other rows. Address the cell by row (first-column value, or a 0-based ordinal) and column (header name, or ordinal). Pass ifRev (from wiki_table_get) to reject the edit if the page changed since.',
      inputSchema: {
        ...tableLocator,
        row: z.string().describe('first-column value of the row (or a 0-based ordinal)'),
        column: z.string().describe('column header name (or a 0-based ordinal)'),
        value: z.string(),
        ifRev: z.string().optional().describe('rev from wiki_table_get (optimistic concurrency)'),
        agent: z.string().optional(),
      },
    },
    async ({ ref, caption, tableIndex, row, column, value, ifRev, agent }) => {
      try {
        const updated = await tableSetCell(db, ref, { caption, tableIndex }, row, column, value, {
          ifRev,
          agentSource: agent,
        })
        return ok(updated)
      } catch (e) {
        return tableFail(e)
      }
    },
  )

  server.registerTool(
    'wiki_table_add_row',
    {
      title: 'Add a table row',
      description:
        'Append a row to a table. `cells` are given in header order (missing trailing cells are left blank). Edits the table in place without rewriting the page body.',
      inputSchema: {
        ...tableLocator,
        cells: z.array(z.string()).describe('cell values in header order'),
        ifRev: z.string().optional(),
        agent: z.string().optional(),
      },
    },
    async ({ ref, caption, tableIndex, cells, ifRev, agent }) => {
      try {
        const updated = await tableAddRow(db, ref, { caption, tableIndex }, cells, {
          ifRev,
          agentSource: agent,
        })
        return ok(updated)
      } catch (e) {
        return tableFail(e)
      }
    },
  )

  server.registerTool(
    'wiki_table_delete_row',
    {
      title: 'Delete a table row',
      description:
        'Delete the row matching `row` (first-column value, or a 0-based ordinal) from a table, in place.',
      inputSchema: {
        ...tableLocator,
        row: z.string().describe('first-column value of the row (or a 0-based ordinal)'),
        ifRev: z.string().optional(),
        agent: z.string().optional(),
      },
    },
    async ({ ref, caption, tableIndex, row, ifRev, agent }) => {
      try {
        const updated = await tableDeleteRow(db, ref, { caption, tableIndex }, row, {
          ifRev,
          agentSource: agent,
        })
        return ok(updated)
      } catch (e) {
        return tableFail(e)
      }
    },
  )

  server.registerTool(
    'wiki_table_add_column',
    {
      title: 'Add a table column',
      description:
        'Insert a column into a table in place (appends unless `at` is given); every existing row gets an empty cell. Do NOT regenerate the whole body to add a column. Fill the new cells afterward with wiki_table_set_cell.',
      inputSchema: {
        ...tableLocator,
        name: z.string().describe('the new column header'),
        at: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe('0-based insert position (default: append)'),
        align: z
          .enum(['left', 'right', 'center'])
          .nullable()
          .optional()
          .describe('column alignment'),
        ifRev: z.string().optional(),
        agent: z.string().optional(),
      },
    },
    async ({ ref, caption, tableIndex, name, at, align, ifRev, agent }) => {
      try {
        const updated = await tableAddColumn(
          db,
          ref,
          { caption, tableIndex },
          { name, at, align: align ?? null },
          { ifRev, agentSource: agent },
        )
        return ok(updated)
      } catch (e) {
        return tableFail(e)
      }
    },
  )

  server.registerTool(
    'wiki_table_delete_column',
    {
      title: 'Delete a table column',
      description:
        'Delete a column (by header name or a 0-based ordinal) from a table in place, dropping that cell from every row. Refuses removing the last column.',
      inputSchema: {
        ...tableLocator,
        column: z.string().describe('column header name (or a 0-based ordinal)'),
        ifRev: z.string().optional(),
        agent: z.string().optional(),
      },
    },
    async ({ ref, caption, tableIndex, column, ifRev, agent }) => {
      try {
        const loc = { caption, tableIndex }
        const col = await resolveMcpColumn(db, ref, loc, column)
        const updated = await tableDeleteColumn(db, ref, loc, col, { ifRev, agentSource: agent })
        return ok(updated)
      } catch (e) {
        return tableFail(e)
      }
    },
  )

  server.registerTool(
    'wiki_table_rename_column',
    {
      title: 'Rename a table column',
      description:
        'Rename one column header (address the current column by header name or a 0-based ordinal). Cells and alignment are untouched.',
      inputSchema: {
        ...tableLocator,
        column: z.string().describe('current column header name (or a 0-based ordinal)'),
        name: z.string().describe('the new column header'),
        ifRev: z.string().optional(),
        agent: z.string().optional(),
      },
    },
    async ({ ref, caption, tableIndex, column, name, ifRev, agent }) => {
      try {
        const loc = { caption, tableIndex }
        const col = await resolveMcpColumn(db, ref, loc, column)
        const updated = await tableRenameColumn(db, ref, loc, col, name, {
          ifRev,
          agentSource: agent,
        })
        return ok(updated)
      } catch (e) {
        return tableFail(e)
      }
    },
  )

  server.registerResource(
    'wiki',
    new ResourceTemplate('bctx://wiki/{id}', {
      list: async () => {
        const pages = (await listPages(db, { limit: 1000 })).filter((p) => p.pageType !== 'source')
        return {
          resources: pages.map((p) => ({
            uri: `bctx://wiki/${p.id}`,
            name: p.title ?? p.id,
            description: `${p.pageType} · ${formatTokens(estimateTokens(p.body))}`,
            mimeType: 'application/json',
          })),
        }
      },
    }),
    { title: 'Wiki pages', description: 'Browse wiki pages as resources.' },
    async (uri, { id }) => {
      const page = await getPage(db, String(id))
      // Hide soft-deleted pages, consistent with the context resource.
      const visible = page && page.deletedAt === null ? page : null
      return {
        contents: [
          { uri: uri.href, mimeType: 'application/json', text: JSON.stringify(visible, null, 2) },
        ],
      }
    },
  )
}
