import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { Kysely } from 'kysely'
import { describe, expect, it } from 'vitest'
import type { Database } from '../src/core/types'
import { buildServer } from '../src/mcp/server'
import { freshDb } from './_db'

async function connect(db: Kysely<Database>): Promise<Client> {
  const server = buildServer(db)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return client
}

function payload(result: any): any {
  return JSON.parse(result.content[0].text)
}

describe('mcp server', () => {
  it('registers the full CRUD tool surface', async () => {
    const db = await freshDb()
    const client = await connect(db)
    const names = (await client.listTools()).tools.map((t) => t.name)
    for (const n of [
      'create_context',
      'delete_context',
      'get_context',
      'list_contexts',
      'search_contexts',
      'update_context',
    ]) {
      expect(names).toContain(n)
    }
    await db.destroy()
  })

  it('create → get → search → soft-delete round-trips through core', async () => {
    const db = await freshDb()
    const client = await connect(db)

    const created = payload(
      await client.callTool({
        name: 'create_context',
        arguments: { body: 'Prefer pnpm over npm', kind: 'rule', tags: ['tooling'] },
      }),
    )
    expect(created.id).toBeTruthy()

    const got = payload(
      await client.callTool({ name: 'get_context', arguments: { id: created.id } }),
    )
    expect(got.body).toBe('Prefer pnpm over npm')

    const hits = payload(
      await client.callTool({ name: 'search_contexts', arguments: { query: 'pnpm' } }),
    )
    expect(hits.length).toBe(1)

    const del = payload(
      await client.callTool({ name: 'delete_context', arguments: { id: created.id } }),
    )
    expect(del.deleted).toBe(true)

    // soft-delete: hidden from list, but the row still exists (recoverable)
    const list = payload(await client.callTool({ name: 'list_contexts', arguments: {} }))
    expect(list.find((c: any) => c.id === created.id)).toBeUndefined()
    const after = payload(
      await client.callTool({ name: 'get_context', arguments: { id: created.id } }),
    )
    expect(after.deletedAt).toBeTruthy()

    await db.destroy()
  })

  it('exposes contexts as resources', async () => {
    const db = await freshDb()
    const client = await connect(db)
    await client.callTool({ name: 'create_context', arguments: { body: 'a note', title: 'N' } })
    const { resources } = await client.listResources()
    expect(resources.length).toBe(1)
    expect(resources[0]?.uri.startsWith('bctx://context/')).toBe(true)
    await db.destroy()
  })
})
