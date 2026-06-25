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
  getPageByTitle,
  lint,
  listPages,
  outboundLinks,
  recordSource,
  searchPages,
} from '../core/wiki'

function ok(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] }
}
function fail(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true }
}
async function resolveRef(db: Kysely<Database>, ref: string) {
  return (await getPage(db, ref)) ?? (await getPageByTitle(db, ref))
}

/** Register the wiki tool surface + a wiki resource on an existing MCP server. */
export function registerWikiTools(server: McpServer, db: Kysely<Database>): void {
  server.registerTool(
    'wiki_search',
    {
      title: 'Search wiki',
      description: 'Full-text search (FTS5/BM25) across wiki pages.',
      inputSchema: {
        query: z.string(),
        type: z.enum(AUTHORED_PAGE_TYPES).optional(),
        namespace: z.string().optional(),
        limit: z.number().int().positive().optional(),
      },
    },
    async ({ query, type, namespace, limit }) =>
      ok(await searchPages(db, query, { pageType: type, namespace, limit })),
  )

  server.registerTool(
    'wiki_get',
    {
      title: 'Get wiki page',
      description: 'Fetch a wiki page (by id or title) with its outbound links and backlinks.',
      inputSchema: { ref: z.string().describe('page id or title') },
    },
    async ({ ref }) => {
      const page = await resolveRef(db, ref)
      if (!page) return fail(`No wiki page matching "${ref}"`)
      const [outbound, back] = await Promise.all([
        outboundLinks(db, page.id),
        backlinks(db, page.id),
      ])
      return ok({ page, outbound, backlinks: back })
    },
  )

  server.registerTool(
    'wiki_new',
    {
      title: 'Create wiki page',
      description: 'Create a wiki page. Use [[Title]] in the body to cross-link other pages.',
      inputSchema: {
        title: z.string(),
        type: z.enum(AUTHORED_PAGE_TYPES),
        body: z.string().optional(),
        namespace: z.string().optional(),
        tags: z.array(z.string()).optional(),
        agent: z.string().optional(),
      },
    },
    async ({ title, type, body, namespace, tags, agent }) =>
      ok(
        await createPage(db, { title, pageType: type, body, namespace, tags, agentSource: agent }),
      ),
  )

  server.registerTool(
    'wiki_link',
    {
      title: 'Link wiki pages',
      description:
        'Add a typed link between pages (target may be a not-yet-created title => a wanted link).',
      inputSchema: {
        from: z.string().describe('source page id or title'),
        to: z.string().describe('target page id or title'),
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
          'Update ~5–15 related entity/concept pages, weaving in [[links]]',
          'Run wiki_lint to check health',
        ],
      })
    },
  )

  server.registerTool(
    'wiki_lint',
    {
      title: 'Lint the wiki',
      description:
        'Report wiki health issues (orphans, dangling/wanted links, ambiguous titles, ...).',
      inputSchema: {},
    },
    async () => ok(await lint(db)),
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
            description: String(p.pageType),
            mimeType: 'application/json',
          })),
        }
      },
    }),
    { title: 'Wiki pages', description: 'Browse wiki pages as resources.' },
    async (uri, { id }) => {
      const page = await getPage(db, String(id))
      return {
        contents: [
          { uri: uri.href, mimeType: 'application/json', text: JSON.stringify(page, null, 2) },
        ],
      }
    },
  )
}
