import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@libsql/client'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { Kysely } from 'kysely'
import { describe, expect, it } from 'vitest'
import { kyselyFor } from '../src/core/db'
import { migrateToLatest } from '../src/core/migrate'
import type { Database } from '../src/core/types'
import {
  addLink,
  createPage,
  ingestStatus,
  recordSource,
  updatePage,
  verifyPage,
  wikiGraph,
} from '../src/core/wiki'
import { buildServer } from '../src/mcp/server'
import { buildStudioApp } from '../src/studio/server'
import { staticProvider } from '../src/studio/stores'
import { driftFindings, snapshotSourceHashes } from '../src/wiki/drift'
import { renderIndexMarkdown } from '../src/wiki/export'
import { freshDb } from './_db'

async function connectMcp(db: Kysely<Database>): Promise<Client> {
  const server = buildServer(db)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return client
}

function payload(result: any): any {
  return JSON.parse(result.content[0].text)
}

describe('live refresh (/api/version)', () => {
  it('data_version changes after a write from ANOTHER connection', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bctx-ver-'))
    const file = join(dir, 'test.db')
    const db1 = kyselyFor(createClient({ url: `file:${file}` }))
    await migrateToLatest(db1)

    const staticDir = mkdtempSync(join(tmpdir(), 'bctx-studio-'))
    writeFileSync(join(staticDir, 'index.html'), '<!doctype html>ok')
    const app = buildStudioApp(staticProvider(db1), { staticDir })

    const v1 = ((await (await app.request('/api/version')).json()) as { dataVersion: number })
      .dataVersion
    expect(typeof v1).toBe('number')

    // Write through a completely separate connection (the agent/CLI case).
    const db2 = kyselyFor(createClient({ url: `file:${file}` }))
    await createPage(db2, { title: 'External', pageType: 'concept', body: 'from elsewhere' })
    await db2.destroy()

    const v2 = ((await (await app.request('/api/version')).json()) as { dataVersion: number })
      .dataVersion
    expect(v2).not.toBe(v1)
    await db1.destroy()
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('budget-aware index', () => {
  it('drops sources first, states omissions, and fits the budget', async () => {
    const db = await freshDb()
    for (let i = 0; i < 6; i++) {
      await createPage(db, {
        title: `Concept ${i}`,
        pageType: 'concept',
        body: `concept body ${i} `.repeat(20),
      })
    }
    await recordSource(db, { title: 'Big Source', body: 'raw '.repeat(500) })
    const { listPages } = await import('../src/core/wiki')
    const pages = await listPages(db)

    const full = renderIndexMarkdown(pages)
    expect(full).toContain('Big Source')
    expect(full).not.toContain('omitted')

    const capped = renderIndexMarkdown(pages, { budget: 120 })
    expect(capped).toContain('omitted to fit the ~120 token budget')
    // Sources are the first to go.
    expect(capped).not.toContain('Big Source')
    expect(Math.ceil(capped.length / 4)).toBeLessThanOrEqual(140) // small tolerance over budget
    await db.destroy()
  })
})

describe('code↔doc drift', () => {
  it('flags not-baselined, changed, and missing source files', async () => {
    const db = await freshDb()
    const root = mkdtempSync(join(tmpdir(), 'bctx-drift-'))
    writeFileSync(join(root, 'a.ts'), 'export const a = 1\n')
    writeFileSync(join(root, 'b.ts'), 'export const b = 1\n')

    const page = await createPage(db, {
      title: 'Module A',
      pageType: 'entity',
      body: 'documents a.ts and b.ts',
      metadata: { sources: ['a.ts', 'b.ts'] },
    })

    // Declared but never snapshotted → not baselined.
    const before = await driftFindings(db, root)
    expect(before.filter((f) => f.kind === 'drift').length).toBe(2)
    expect(before[0]!.detail).toContain('not baselined')

    // Baseline (what `wiki verify` does), then everything is clean.
    const hashes = await snapshotSourceHashes(db, page.id, root)
    expect(hashes && Object.keys(hashes).length).toBe(2)
    expect(await driftFindings(db, root)).toEqual([])

    // Mutate one file, delete the other.
    writeFileSync(join(root, 'a.ts'), 'export const a = 2\n')
    rmSync(join(root, 'b.ts'))
    const after = await driftFindings(db, root)
    expect(after.some((f) => f.detail === 'a.ts: changed since last verify')).toBe(true)
    expect(after.some((f) => f.detail === 'b.ts: file missing')).toBe(true)

    rmSync(root, { recursive: true, force: true })
    await db.destroy()
  })

  it('CLI-style verify snapshots hashes via verifyPage + snapshotSourceHashes', async () => {
    const db = await freshDb()
    const root = mkdtempSync(join(tmpdir(), 'bctx-drift-'))
    writeFileSync(join(root, 'x.ts'), 'x')
    const page = await createPage(db, {
      title: 'X',
      pageType: 'concept',
      body: 'x docs',
      metadata: { sources: ['x.ts'] },
    })
    await verifyPage(db, page.id, { agent: 'test' })
    await snapshotSourceHashes(db, page.id, root)
    expect(await driftFindings(db, root)).toEqual([])
    rmSync(root, { recursive: true, force: true })
    await db.destroy()
  })
})

describe('resumable ingest status', () => {
  it('derives step completion from the graph across the whole cascade', async () => {
    const db = await freshDb()
    const source = await recordSource(db, { title: 'Paper', body: 'raw paper text' })

    let s = await ingestStatus(db, source.id)
    expect(s).not.toBeNull()
    expect(s!.complete).toBe(false)
    expect(s!.steps.find((x) => x.step === 'summary')!.done).toBe(false)

    // Write the summary and link it to the source.
    const summary = await createPage(db, {
      title: 'Paper Summary',
      pageType: 'summary',
      body: 'summary of [[Paper]]',
    })
    await addLink(db, summary.id, { toId: source.id, type: 'source' })
    s = await ingestStatus(db, source.id)
    expect(s!.steps.find((x) => x.step === 'summary')!.done).toBe(true)
    expect(s!.steps.find((x) => x.step === 'verified')!.done).toBe(false)

    // Update a related page + verify the summary → all derivable steps done.
    await createPage(db, { title: 'Related', pageType: 'concept', body: 'ties in' })
    await verifyPage(db, summary.id)
    s = await ingestStatus(db, source.id)
    expect(s!.steps.find((x) => x.step === 'pages-updated')!.done).toBe(true)
    expect(s!.steps.find((x) => x.step === 'verified')!.done).toBe(true)
    expect(s!.complete).toBe(true) // no index page in store → step not applicable

    // Non-source refs are rejected.
    expect(await ingestStatus(db, summary.id)).toBeNull()
    await db.destroy()
  })

  it('is exposed over MCP as wiki_ingest_status', async () => {
    const db = await freshDb()
    const client = await connectMcp(db)
    const ingest = payload(
      await client.callTool({
        name: 'wiki_ingest',
        arguments: { source: 'raw', title: 'Doc' },
      }),
    )
    const status = payload(
      await client.callTool({ name: 'wiki_ingest_status', arguments: { ref: ingest.sourceId } }),
    )
    expect(status.complete).toBe(false)
    expect(status.steps.map((s: any) => s.step)).toContain('summary')
    await db.destroy()
  })
})

describe('graph pruning', () => {
  it('minDegree and limit keep the well-connected core with pruned edges', async () => {
    const db = await freshDb()
    const hub = await createPage(db, { title: 'Hub', pageType: 'concept', body: '' })
    for (let i = 0; i < 3; i++) {
      const spoke = await createPage(db, { title: `Spoke ${i}`, pageType: 'concept', body: '' })
      await addLink(db, spoke.id, { toId: hub.id, type: 'relates' })
    }
    await createPage(db, { title: 'Isolated', pageType: 'concept', body: '' })

    const all = await wikiGraph(db)
    expect(all.nodes.length).toBe(5)

    const connected = await wikiGraph(db, { minDegree: 1 })
    expect(connected.nodes.length).toBe(4)
    expect(connected.nodes.some((n) => n.title === 'Isolated')).toBe(false)

    const core = await wikiGraph(db, { limit: 1 })
    expect(core.nodes.length).toBe(1)
    expect(core.nodes[0]!.title).toBe('Hub')
    expect(core.edges).toEqual([]) // spokes pruned → their edges go too
    await db.destroy()
  })
})

describe('wiki page history route', () => {
  it('serves the audit trail for a wiki page (firewalled from /api/contexts)', async () => {
    const db = await freshDb()
    const staticDir = mkdtempSync(join(tmpdir(), 'bctx-studio-'))
    writeFileSync(join(staticDir, 'index.html'), '<!doctype html>ok')
    const app = buildStudioApp(staticProvider(db), { staticDir })

    const page = await createPage(db, { title: 'P', pageType: 'concept', body: 'v1' })
    await updatePage(db, page.id, { body: 'v2', agentSource: 'claude' })

    const res = await app.request(`/api/wiki/pages/${page.id}/history`)
    expect(res.status).toBe(200)
    const rows = (await res.json()) as any[]
    expect(rows.length).toBe(2)
    expect(rows[0].event).toBe('update')
    expect(rows[0].agentSource).toBe('claude')

    const missing = await app.request('/api/wiki/pages/nope/history')
    expect(missing.status).toBe(404)
    await db.destroy()
  })
})
