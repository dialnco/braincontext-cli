import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { Kysely } from 'kysely'
import { describe, expect, it } from 'vitest'
import { listAccessLog } from '../src/core/access/audit'
import { createSessionResolver } from '../src/core/access/cache'
import { restrictForSession } from '../src/core/access/gate'
import { createPrincipal, issueKey } from '../src/core/access/principals'
import { resolveSession } from '../src/core/access/session'
import { setAccessEnabled } from '../src/core/access/settings'
import type { Database } from '../src/core/types'
import { MCP_TOOL_CAPABILITIES } from '../src/mcp/access'
import { buildServer } from '../src/mcp/server'
import { freshDb } from './_db'

/** Mirror of runMcpStdio's startup: authenticate once, gate the server with it. */
async function connectAs(db: Kysely<Database>, key: string | null): Promise<Client> {
  const session = createSessionResolver(db, key)
  const initial = await session()
  const gatedDb = restrictForSession(db, initial.enabled && initial.ok ? initial.session : null)
  const server = buildServer(gatedDb, { db, session })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return client
}

async function storeWith(role: 'writer' | 'reader') {
  const db = await freshDb()
  await createPrincipal(db, { handle: 'boss', role: 'owner' })
  await createPrincipal(db, { handle: 'member', role })
  const issued = await issueKey(db, 'member')
  await setAccessEnabled(db, true)
  return { db, key: issued.key }
}

describe('MCP access gate', () => {
  it('maps every registered tool to a capability', async () => {
    const db = await freshDb()
    const client = await connectAs(db, null)
    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names.length).toBeGreaterThan(30)
    // An unmapped tool falls back to `project.manage`, locking out everyone but an
    // admin. That is the fail-closed backstop, not the intended configuration.
    expect(names.filter((n) => !MCP_TOOL_CAPABILITIES[n])).toEqual([])
    // And no stale entries for tools that no longer exist.
    const live = new Set(names)
    expect(Object.keys(MCP_TOOL_CAPABILITIES).filter((n) => !live.has(n))).toEqual([])
    await db.destroy()
  })

  it('lets a writer create and a reader read', async () => {
    const w = await storeWith('writer')
    const writer = await connectAs(w.db, w.key)
    const created = await writer.callTool({
      name: 'create_context',
      arguments: { body: 'from an agent', kind: 'note' },
    })
    expect(created.isError).toBeFalsy()
    await w.db.destroy()

    const r = await storeWith('reader')
    const reader = await connectAs(r.db, r.key)
    const listed = await reader.callTool({ name: 'list_contexts', arguments: {} })
    expect(listed.isError).toBeFalsy()
    await r.db.destroy()
  })

  it('refuses a reader a write tool, with a message the agent can act on', async () => {
    const { db, key } = await storeWith('reader')
    const client = await connectAs(db, key)
    const result = await client.callTool({
      name: 'create_context',
      arguments: { body: 'should not land', kind: 'note' },
    })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toMatch(/Permission denied/)
    expect(await db.selectFrom('contexts').selectAll().execute()).toEqual([])
    const denials = await listAccessLog(db, { denyOnly: true })
    expect(denials[0]?.action).toBe('create_context')
    expect(denials[0]?.surface).toBe('mcp')
    await db.destroy()
  })

  it('refuses an unauthenticated caller once access control is on', async () => {
    const { db } = await storeWith('writer')
    const client = await connectAs(db, null)
    const result = await client.callTool({ name: 'list_contexts', arguments: {} })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toMatch(/requires an access key/)
    await db.destroy()
  })

  it('stays fully open when access control is off', async () => {
    const db = await freshDb()
    const client = await connectAs(db, null)
    const created = await client.callTool({
      name: 'create_context',
      arguments: { body: 'no gate here', kind: 'note' },
    })
    expect(created.isError).toBeFalsy()
    expect(await listAccessLog(db)).toEqual([])
    await db.destroy()
  })

  it('attributes an agent write to the authenticated principal', async () => {
    const { db, key } = await storeWith('writer')
    const client = await connectAs(db, key)
    await client.callTool({
      name: 'create_context',
      arguments: { body: 'attributed', kind: 'note' },
    })
    const session = await resolveSession(db, key)
    const row = await db.selectFrom('contexts').select('principal_id').executeTakeFirst()
    expect(row?.principal_id).toBe(
      session.enabled && session.ok ? session.session.principal.id : null,
    )
    await db.destroy()
  })
})
