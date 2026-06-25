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
})
