import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Kysely } from 'kysely'
import { z } from 'zod'
import {
  createContext,
  deleteContext,
  getContext,
  listContexts,
  searchContexts,
  updateContext,
} from '../core/contexts'
import { type Database, KINDS, SCOPES } from '../core/types'
import { getVersion } from '../lib/pkg'
import { registerWikiTools } from './wiki-tools'

function ok(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] }
}

function fail(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true }
}

/**
 * Build an MCP server exposing the store. Full CRUD by default; delete is
 * soft-only (never a hard delete over MCP — history keeps it recoverable).
 */
export function buildServer(db: Kysely<Database>): McpServer {
  const server = new McpServer({ name: 'bctx', version: getVersion() })

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
      return ctx ? ok(ctx) : fail(`No context with id ${id}`)
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
        agent: z.string().optional(),
      },
    },
    async ({ id, title, body, addTags, removeTags, setMetadata, agent }) => {
      const ctx = await updateContext(db, id, {
        title,
        body,
        addTags,
        removeTags,
        setMetadata,
        agentSource: agent,
      })
      return ctx ? ok(ctx) : fail(`No context with id ${id}`)
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
      return {
        contents: [
          { uri: uri.href, mimeType: 'application/json', text: JSON.stringify(ctx, null, 2) },
        ],
      }
    },
  )

  registerWikiTools(server, db)

  return server
}
