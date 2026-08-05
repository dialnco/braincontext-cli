import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Kysely } from 'kysely'
import type { SessionResolver } from '../core/access/cache'
import type { Capability } from '../core/access/capabilities'
import { AccessDeniedError } from '../core/access/errors'
import { authorize } from '../core/access/gate'
import { runWithSession } from '../core/access/session'
import type { Database } from '../core/types'

/**
 * Capability required by each MCP tool. Mirrors COMMAND_CAPABILITIES for the CLI —
 * `test/mcp-access.test.ts` asserts every registered tool appears here.
 */
export const MCP_TOOL_CAPABILITIES: Record<string, Capability> = {
  // Contexts.
  search_contexts: 'read',
  get_context: 'read',
  list_contexts: 'read',
  create_context: 'write',
  update_context: 'write',
  // Soft-delete over MCP, but still the `delete` capability: a writer denied
  // `-delete` must not be able to route around it through an agent.
  delete_context: 'delete',

  // Wiki — reads.
  wiki_search: 'read',
  wiki_get: 'read',
  wiki_query: 'read',
  wiki_list_properties: 'read',
  wiki_lint: 'read',
  wiki_graph: 'read',
  wiki_related: 'read',
  wiki_path: 'read',
  wiki_table_get: 'read',
  wiki_ingest_status: 'read',

  // Wiki — writes.
  wiki_new: 'write',
  wiki_update: 'write',
  wiki_patch_section: 'write',
  wiki_replace: 'write',
  wiki_link: 'write',
  wiki_unlink: 'write',
  wiki_ingest: 'write',
  wiki_verify: 'write',
  wiki_set_prop: 'write',
  wiki_datatable_new: 'write',
  wiki_view_new: 'write',
  wiki_table_set_cell: 'write',
  wiki_table_add_row: 'write',
  wiki_table_delete_row: 'write',
  wiki_table_add_column: 'write',
  wiki_table_delete_column: 'write',
  wiki_table_rename_column: 'write',
}

export interface McpAccessContext {
  /** The UNWRAPPED store handle — audit rows must be writable even for a reader. */
  db: Kysely<Database>
  session: SessionResolver
}

/**
 * Gate every tool and resource this server exposes.
 *
 * Implemented by wrapping `registerTool`/`registerResource` before anything is
 * registered, rather than by touching 33 handlers: one interception point means a
 * tool added later is gated automatically, and an unmapped name fails closed on
 * `project.manage` instead of silently becoming public.
 *
 * Call this BEFORE registering tools.
 */
export function installAccessGate(server: McpServer, ctx: McpAccessContext): void {
  const registerTool = server.registerTool.bind(server)
  const registerResource = server.registerResource.bind(server)

  const check = async (action: string, capability: Capability) => {
    const result = await ctx.session()
    await authorize(ctx.db, result, { requires: capability, action, surface: 'mcp' })
    return result.enabled && result.ok ? result.session : null
  }

  server.registerTool = ((name: string, config: unknown, handler: (...a: never[]) => unknown) =>
    registerTool(
      name as never,
      config as never,
      (async (...args: never[]) => {
        const capability = MCP_TOOL_CAPABILITIES[name] ?? 'project.manage'
        let session: Awaited<ReturnType<typeof check>>
        try {
          session = await check(name, capability)
        } catch (err) {
          // An agent gets a readable refusal it can act on, not a protocol error.
          if (err instanceof AccessDeniedError) {
            return { content: [{ type: 'text' as const, text: err.message }], isError: true }
          }
          throw err
        }
        return runWithSession(session, async () => handler(...args))
      }) as never,
    )) as typeof server.registerTool

  server.registerResource = ((name: string, ...rest: unknown[]) => {
    const handler = rest.pop() as (...a: never[]) => unknown
    return registerResource(name as never, ...(rest as [never, never]), (async (
      ...args: never[]
    ) => {
      // Resource reads have no error shape of their own; throwing surfaces as a
      // protocol error, which is the honest outcome for a refused read.
      const session = await check(`resource:${name}`, 'read')
      return runWithSession(session, async () => handler(...args))
    }) as never)
  }) as typeof server.registerResource
}
