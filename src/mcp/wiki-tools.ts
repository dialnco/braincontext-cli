import { type McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Kysely } from 'kysely'
import { z } from 'zod'
import { AUTHORED_PAGE_TYPES, type Database, LINK_TYPES } from '../core/types'
import {
  addLink,
  appendLog,
  backlinks,
  createPage,
  getPage,
  ingestStatus,
  lint,
  listPages,
  outboundLinks,
  pageFreshness,
  pagePeek,
  recordSource,
  removeLink,
  resolvePageRef,
  searchPages,
  updatePage,
  verifyPage,
  wikiGraph,
} from '../core/wiki'
import { truncateAtTokens } from '../lib/outline'
import { estimateTokens, formatTokens } from '../lib/tokens'
import { driftFindings, snapshotSourceHashes } from '../wiki/drift'

function ok(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] }
}
function fail(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true }
}
async function resolveRef(db: Kysely<Database>, ref: string) {
  return resolvePageRef(db, ref)
}

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
        'Fetch a wiki page (by id, slug, or title). detail:"peek" returns outline + excerpt + links + token cost instead of the body — use it to decide whether the full page is worth its tokenEstimate. maxTokens truncates a full body at a paragraph boundary.',
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
      },
    },
    async ({ ref, detail, maxTokens }) => {
      const page = await resolveRef(db, ref)
      if (!page) return fail(`No wiki page matching "${ref}"`)
      if (detail === 'peek') {
        const peek = await pagePeek(db, page.id)
        return peek ? ok(peek) : fail(`No wiki page matching "${ref}"`)
      }
      const [outbound, back] = await Promise.all([
        outboundLinks(db, page.id),
        backlinks(db, page.id),
      ])
      let body = page.body
      if (maxTokens) {
        const t = truncateAtTokens(page.body, maxTokens)
        if (t.truncated) {
          body = `${t.text}\n\n[truncated at ~${t.returnedTokens} of ~${t.totalTokens} tokens — call wiki_get without maxTokens for the rest]`
        }
      }
      return ok({
        page: { ...page, body },
        tokenEstimate: estimateTokens(page.body),
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
        agent: z.string().optional(),
      },
    },
    async ({ title, type, body, namespace, tags, sources, agent }) =>
      ok(
        await createPage(db, {
          title,
          pageType: type,
          body,
          namespace,
          tags,
          agentSource: agent,
          metadata: sources && sources.length > 0 ? { sources } : undefined,
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
        agent: z.string().optional(),
      },
    },
    async ({ ref, title, body, addTags, removeTags, sources, agent }) => {
      const page = await resolveRef(db, ref)
      if (!page) return fail(`No wiki page matching "${ref}"`)
      try {
        const updated = await updatePage(db, page.id, {
          title,
          body,
          addTags,
          removeTags,
          setMetadata: sources !== undefined ? { sources } : undefined,
          agentSource: agent,
        })
        return updated ? ok(updated) : fail(`No wiki page matching "${ref}"`)
      } catch (e) {
        // updatePage throws on source pages ('source pages are immutable').
        return fail((e as Error).message)
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
        'Return the wiki link graph — pages (nodes, with degree) and their typed edges — for navigation and overview. Optionally scope to a namespace; on large wikis use minDegree/limit to get the well-connected core instead of thousands of nodes.',
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
