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

describe('mcp wiki tools', () => {
  it('exposes wiki tools and runs new → search → lint; pages stay out of list_contexts', async () => {
    const db = await freshDb()
    const client = await connect(db)

    const names = (await client.listTools()).tools.map((t) => t.name)
    for (const n of [
      'wiki_new',
      'wiki_search',
      'wiki_link',
      'wiki_ingest',
      'wiki_lint',
      'wiki_get',
    ]) {
      expect(names).toContain(n)
    }

    const page = payload(
      await client.callTool({
        name: 'wiki_new',
        arguments: { title: 'Gateway', type: 'entity', body: 'edge service [[OAuth2]]' },
      }),
    )
    expect(page.pageType).toBe('entity')

    const hits = payload(
      await client.callTool({ name: 'wiki_search', arguments: { query: 'edge' } }),
    )
    expect(hits.length).toBe(1)

    const report = payload(await client.callTool({ name: 'wiki_lint', arguments: {} }))
    expect(report.findings.some((f: any) => f.kind === 'wanted')).toBe(true)

    // regression: wiki page is NOT visible via the context list tool
    const list = payload(await client.callTool({ name: 'list_contexts', arguments: {} }))
    expect(list.length).toBe(0)

    await db.destroy()
  })

  it('wiki_get resolves a page by its slug', async () => {
    const db = await freshDb()
    const client = await connect(db)

    const page = payload(
      await client.callTool({
        name: 'wiki_new',
        arguments: { title: 'Active Clients Roster', type: 'entity', body: 'x' },
      }),
    )
    expect(page.slug).toBe('active-clients-roster')

    const got = payload(await client.callTool({ name: 'wiki_get', arguments: { ref: page.slug } }))
    expect(got.page.id).toBe(page.id)

    await db.destroy()
  })

  it('wiki_update/unlink/graph are registered; update edits in place and refuses source pages', async () => {
    const db = await freshDb()
    const client = await connect(db)

    const names = (await client.listTools()).tools.map((t) => t.name)
    for (const n of ['wiki_update', 'wiki_unlink', 'wiki_graph']) expect(names).toContain(n)

    await client.callTool({
      name: 'wiki_new',
      arguments: { title: 'Gateway', type: 'entity', body: 'v1' },
    })
    const updated = payload(
      await client.callTool({
        name: 'wiki_update',
        arguments: { ref: 'Gateway', body: 'v2 body' },
      }),
    )
    expect(updated.body).toContain('v2 body')

    // edit-in-place, not a duplicate: only one page matches
    const hits = payload(await client.callTool({ name: 'wiki_search', arguments: { query: 'v2' } }))
    expect(hits.length).toBe(1)

    // source pages stay immutable through MCP too
    const src = payload(
      await client.callTool({ name: 'wiki_ingest', arguments: { source: 'raw', title: 'Src' } }),
    )
    const res = (await client.callTool({
      name: 'wiki_update',
      arguments: { ref: src.sourceId, body: 'nope' },
    })) as { isError?: boolean }
    expect(res.isError).toBe(true)

    await db.destroy()
  })
})
