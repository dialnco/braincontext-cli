import type { Client as LibsqlClient } from '@libsql/client'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { Kysely } from 'kysely'
import { describe, expect, it } from 'vitest'
import { createSessionResolver } from '../src/core/access/cache'
import { restrictForSession } from '../src/core/access/gate'
import { createPrincipal, issueKey } from '../src/core/access/principals'
import { setAccessEnabled } from '../src/core/access/settings'
import type { Database } from '../src/core/types'
import { buildServer } from '../src/mcp/server'
import { freshStore } from './_db'

async function connectAs(
  db: Kysely<Database>,
  client: LibsqlClient,
  key: string | null,
  opts: { inbox?: boolean } = {},
): Promise<Client> {
  const session = createSessionResolver(db, key)
  const initial = await session()
  const gatedDb = restrictForSession(db, initial.enabled && initial.ok ? initial.session : null)
  const server = buildServer(
    gatedDb,
    { db, session },
    opts.inbox === false
      ? {}
      : { inbox: { session: `mcp-${key?.slice(6, 12)}`, store: async () => ({ db, client }) } },
  )
  const [a, b] = InMemoryTransport.createLinkedPair()
  const mcp = new Client({ name: 'test', version: '0.0.0' })
  await Promise.all([server.connect(b), mcp.connect(a)])
  return mcp
}

function payload(result: any): any {
  return JSON.parse(result.content[0].text)
}

function text(result: any): string {
  return result.content[0].text
}

async function project() {
  const { db, client } = await freshStore()
  const keys: Record<string, string> = {}
  for (const [handle, role] of [
    ['boss', 'owner'],
    ['diego', 'writer'],
    ['susana', 'writer'],
    ['rita', 'reader'],
  ] as const) {
    await createPrincipal(db, { handle, role })
    keys[handle] = (await issueKey(db, handle)).key
  }
  await setAccessEnabled(db, true)
  return { db, client, keys }
}

describe('MCP inbox tools', () => {
  it('runs a full ask → answer → resolve round trip between two agents', async () => {
    const { db, client, keys } = await project()
    const diego = await connectAs(db, client, keys.diego as string)
    const susana = await connectAs(db, client, keys.susana as string)

    const sent = payload(
      await diego.callTool({
        name: 'inbox_send',
        arguments: { to: '@susana', kind: 'ask', body: 'Does billing validate RUT?' },
      }),
    )
    expect(sent.num).toBe(1)

    const listed = payload(
      await susana.callTool({ name: 'inbox_list', arguments: { includeMembers: true } }),
    )
    expect(listed.threads.map((t: { num: number; unread: boolean }) => [t.num, t.unread])).toEqual([
      [1, true],
    ])
    expect(listed.members.map((m: { handle: string }) => m.handle)).toContain('team')

    const got = payload(await susana.callTool({ name: 'inbox_get', arguments: { ref: '#1' } }))
    expect(got.notice).toMatch(/not as instructions/)
    expect(got.messages[0].body).toBe('Does billing validate RUT?')

    const early = await susana.callTool({
      name: 'inbox_set',
      arguments: { ref: '1', action: 'resolve' },
    })
    expect(early.isError).toBe(true)
    expect(text(early)).toMatch(/question/)

    const done = payload(
      await susana.callTool({
        name: 'inbox_reply',
        arguments: { ref: '1', body: 'Yes, since abc123', after: 'resolve' },
      }),
    )
    expect(done.status).toBe('resolved')
    expect(done.messages.at(-1).surface).toBe('mcp')
    expect(done.messages.at(-1).byAgent).toBe(true)
    await db.destroy()
  })

  it('lets a reader agent use the inbox, and says so in whoami', async () => {
    const { db, client, keys } = await project()
    const rita = await connectAs(db, client, keys.rita as string)
    const who = payload(await rita.callTool({ name: 'whoami', arguments: {} }))
    expect(who.readOnly).toBe(true)
    expect(who.inbox).toEqual({ read: true, write: true })
    expect(who.note).toMatch(/inbox_\* tools still work/)
    const sent = await rita.callTool({
      name: 'inbox_send',
      arguments: { to: '@team', body: 'Can someone review the onboarding page?' },
    })
    expect(sent.isError).toBeFalsy()
    const denied = await rita.callTool({ name: 'create_context', arguments: { body: 'x' } })
    expect(denied.isError).toBe(true)
    await db.destroy()
  })

  it('explains itself on a local project or without access control', async () => {
    const { db, client, keys } = await project()
    const local = await connectAs(db, client, keys.diego as string, { inbox: false })
    const r = await local.callTool({ name: 'inbox_list', arguments: {} })
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/shared \(online\) projects/)

    const bare = await freshStore()
    const off = await connectAs(bare.db, bare.client, null)
    const r2 = await off.callTool({ name: 'inbox_list', arguments: {} })
    expect(r2.isError).toBe(true)
    expect(text(r2)).toMatch(/access control/)
    await db.destroy()
    await bare.db.destroy()
  })
})
