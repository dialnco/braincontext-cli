import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Kysely } from 'kysely'
import { z } from 'zod'
import { describeFailure, resolveSession } from '../core/access/session'
import {
  createContext,
  deleteContext,
  getContext,
  listContexts,
  RevConflictError,
  searchContexts,
  updateContext,
} from '../core/contexts'
import { type Database, KINDS, SCOPES } from '../core/types'
import { getVersion } from '../lib/pkg'
import { installAccessGate, type McpAccessContext } from './access'
import { registerWikiTools } from './wiki-tools'

function ok(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] }
}

function fail(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true }
}

/** Usage guidance returned to agents at MCP connect time (initialize result). */
const INSTRUCTIONS = `braincontext (bctx) — a shared, local-first context store for AI agents.

Preferred workflow: build a linked knowledge wiki with the wiki_* tools for durable,
interlinked knowledge; use the context tools (search/get/list/create/update/delete_context)
for individual entries. Wiki pages are deliberately hidden from the plain context tools.

Read progressively to protect your context window: wiki_search returns compact hits
(snippet + tokenEstimate, no bodies) → wiki_get {detail:"peek"} for outline/excerpt/links/cost
→ wiki_get full (optionally maxTokens) only for pages you will actually use. After checking
a page against reality, mark it with wiki_verify so freshness tracking stays honest.

Concurrency is safe by default: multiple agents/sessions/devices can read and write the
same store at once. Writes are serialized and conflict-free; concurrent edits to different
entries merge, and edits to the same entry are last-writer-wins with prior values kept in
append-only history. delete_context is soft-delete only (recoverable).

Permissions: a shared store may restrict what this session may do. Tools you lack the
capability for return an error starting "Permission denied" — that is final, so do NOT
retry it or try to route around it with another tool. Call whoami to see your role and
capabilities (it always works, even when everything else is refused), then tell the user
what you could not do and which capability it needed. A read-only session should plan
read-only work rather than drafting writes it cannot save.

Online projects (a libSQL/Turso replica): reads are local-fast; writes go to the shared
primary and propagate to all members, so they REQUIRE connectivity. This server owns its
local replica file — while it is running, do not also run \`bctx\` CLI writes against the
same online project on this machine; route writes through these tools (the single writer)
or use a separate device/replica.`

/**
 * Build an MCP server exposing the store. Full CRUD by default; delete is
 * soft-only (never a hard delete over MCP — history keeps it recoverable).
 *
 * `access` gates every tool and resource against the identity the server started
 * with. Omitting it leaves the server ungated, which is what the tests and any
 * caller on a store without access control want.
 */
export function buildServer(db: Kysely<Database>, access?: McpAccessContext): McpServer {
  const server = new McpServer(
    { name: 'bctx', version: getVersion() },
    { instructions: INSTRUCTIONS },
  )

  // Before any registration: the gate works by wrapping the register* methods.
  if (access) installAccessGate(server, access)

  server.registerTool(
    'whoami',
    {
      title: 'Who am I',
      description:
        'Your identity and permissions on this store. Call this when a tool is refused with "Permission denied" — it tells you which capabilities you actually hold, so you can stop retrying and report accurately instead. Always allowed, even when other tools are not.',
      inputSchema: {},
    },
    async () => {
      // Falls back to an unauthenticated probe when the server was built without an
      // access context, so the answer is honest either way.
      const result = access ? await access.session() : await resolveSession(db, null)
      if (!result.enabled) {
        return ok({
          accessControl: 'off',
          note: 'This store has no access control — every tool is available.',
        })
      }
      if (!result.ok) {
        return ok({
          accessControl: 'on',
          authenticated: false,
          reason: result.reason,
          message: describeFailure(result.reason),
        })
      }
      const { principal, readOnly } = result.session
      return ok({
        accessControl: 'on',
        authenticated: true,
        handle: principal.handle,
        role: principal.role,
        capabilities: principal.capabilities,
        readOnly,
        note: readOnly
          ? 'Read-only: every write tool will be refused. Do not retry them.'
          : undefined,
      })
    },
  )

  server.registerTool(
    'search_contexts',
    {
      title: 'Search contexts',
      description: 'Full-text search (FTS5/BM25) across stored context titles and bodies.',
      inputSchema: {
        query: z.string().describe('FTS5 query, e.g. "pnpm" or "deploy*"'),
        namespace: z.string().optional(),
        kind: z.enum(KINDS).optional(),
        tag: z.string().optional(),
        limit: z.number().int().positive().optional(),
      },
    },
    async ({ query, namespace, kind, tag, limit }) =>
      ok(await searchContexts(db, query, { namespace, kind, tag, limit })),
  )

  server.registerTool(
    'get_context',
    {
      title: 'Get context',
      description: 'Fetch a single stored context by id (ULID).',
      inputSchema: { id: z.string().describe('Context id (ULID)') },
    },
    async ({ id }) => {
      const ctx = await getContext(db, id)
      if (!ctx || ctx.pageType !== null) return fail(`No context with id ${id}`)
      return ok(ctx)
    },
  )

  server.registerTool(
    'list_contexts',
    {
      title: 'List contexts',
      description: 'List stored contexts (newest first) with optional filters.',
      inputSchema: {
        namespace: z.string().optional(),
        kind: z.enum(KINDS).optional(),
        scope: z.enum(SCOPES).optional(),
        tag: z.string().optional(),
        agent: z.string().optional(),
        limit: z.number().int().positive().optional(),
      },
    },
    async ({ namespace, kind, scope, tag, agent, limit }) =>
      ok(await listContexts(db, { namespace, kind, scope, tag, agentSource: agent, limit })),
  )

  server.registerTool(
    'create_context',
    {
      title: 'Create context',
      description: 'Save a new context entry (note/rule/snippet/decision/skill).',
      inputSchema: {
        body: z.string().describe('The content to store'),
        title: z.string().optional(),
        kind: z.enum(KINDS).optional(),
        namespace: z.string().optional(),
        scope: z.enum(SCOPES).optional(),
        tags: z.array(z.string()).optional(),
        agent: z.string().optional(),
      },
    },
    async ({ body, title, kind, namespace, scope, tags, agent }) =>
      ok(
        await createContext(db, { body, title, kind, namespace, scope, tags, agentSource: agent }),
      ),
  )

  server.registerTool(
    'update_context',
    {
      title: 'Update context',
      description: 'Update a stored context: title, body, tags, or metadata.',
      inputSchema: {
        id: z.string(),
        title: z.string().optional(),
        body: z.string().optional(),
        addTags: z.array(z.string()).optional(),
        removeTags: z.array(z.string()).optional(),
        setMetadata: z.record(z.string(), z.unknown()).optional(),
        ifRev: z
          .string()
          .optional()
          .describe('rev from your last read; the edit is rejected if the entry changed since'),
        agent: z.string().optional(),
      },
    },
    async ({ id, title, body, addTags, removeTags, setMetadata, ifRev, agent }) => {
      const existing = await getContext(db, id)
      if (!existing || existing.pageType !== null) return fail(`No context with id ${id}`)
      try {
        const ctx = await updateContext(db, id, {
          title,
          body,
          addTags,
          removeTags,
          setMetadata,
          ifRev,
          agentSource: agent,
        })
        return ctx ? ok(ctx) : fail(`No context with id ${id}`)
      } catch (e) {
        if (e instanceof RevConflictError) {
          return fail(JSON.stringify({ error: 'rev_conflict', currentRev: e.currentRev }, null, 2))
        }
        throw e
      }
    },
  )

  server.registerTool(
    'delete_context',
    {
      title: 'Delete context (soft)',
      description: 'Soft-delete a stored context (recoverable; never a hard delete over MCP).',
      inputSchema: { id: z.string(), agent: z.string().optional() },
    },
    async ({ id, agent }) => {
      const existing = await getContext(db, id)
      if (!existing || existing.pageType !== null) return fail(`No context with id ${id}`)
      const deleted = await deleteContext(db, id, { hard: false, agentSource: agent })
      return ok({ deleted, id })
    },
  )

  server.registerResource(
    'context',
    new ResourceTemplate('bctx://context/{id}', {
      list: async () => {
        const items = await listContexts(db, { limit: 1000 })
        return {
          resources: items.map((c) => ({
            uri: `bctx://context/${c.id}`,
            name: c.title ?? c.id,
            description: c.kind,
            mimeType: 'application/json',
          })),
        }
      },
    }),
    { title: 'Stored contexts', description: 'Browse stored contexts as resources.' },
    async (uri, { id }) => {
      const ctx = await getContext(db, String(id))
      const visible = ctx && ctx.pageType === null && ctx.deletedAt === null ? ctx : null
      return {
        contents: [
          { uri: uri.href, mimeType: 'application/json', text: JSON.stringify(visible, null, 2) },
        ],
      }
    },
  )

  registerWikiTools(server, db)

  return server
}
