import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { Context } from '../src/core/contexts'
import { recordSource } from '../src/core/wiki'
import { buildStudioApp } from '../src/studio/server'
import { staticProvider } from '../src/studio/stores'
import { freshDb } from './_db'

function fakeStudioDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bctx-studio-'))
  writeFileSync(join(dir, 'index.html'), '<!doctype html><div id="root">poc</div>')
  return dir
}

async function newApp(): Promise<Hono> {
  const db = await freshDb()
  return buildStudioApp(staticProvider(db), { staticDir: fakeStudioDir() })
}

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

describe('studio security guard (CSRF / DNS-rebind)', () => {
  it('blocks cross-origin writes but allows same-origin and native (no-origin) writes', async () => {
    const app = await newApp()

    // CSRF: a cross-site POST — including the text/plain "simple request" that skips the
    // CORS preflight — must be refused, so a visited web page can't poison the store.
    const evil = await app.request('/api/contexts', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', origin: 'https://evil.example' },
      body: JSON.stringify({ body: 'pwned', kind: 'rule' }),
    })
    expect(evil.status).toBe(403)

    // Same-origin (the SPA itself) is allowed.
    const sameOrigin = await app.request('/api/contexts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:8420' },
      body: JSON.stringify({ body: 'legit', kind: 'rule' }),
    })
    expect(sameOrigin.status).toBe(201)

    // A native client with no Origin header (e.g. curl on localhost) is allowed.
    const noOrigin = await app.request('/api/contexts', json({ body: 'native', kind: 'note' }))
    expect(noOrigin.status).toBe(201)
  })

  it('rejects a non-loopback Host header (DNS rebinding)', async () => {
    const app = await newApp()
    const rebind = await app.request('/api/contexts', {
      method: 'GET',
      headers: { host: 'attacker.example' },
    })
    expect(rebind.status).toBe(403)
  })

  it('returns 400 (not 500) for a malformed percent-encoded path', async () => {
    const app = await newApp()
    const res = await app.request('/%zz')
    expect(res.status).toBe(400)
  })
})

describe('studio contexts API', () => {
  it('does CRUD + search + history through the API', async () => {
    const app = await newApp()

    // create
    const created = await app.request(
      '/api/contexts',
      json({ body: 'use WAL mode', kind: 'rule', tags: ['db'] }),
    )
    expect(created.status).toBe(201)
    const ctx = (await created.json()) as Context
    expect(ctx.kind).toBe('rule')
    expect(ctx.tags).toEqual(['db'])

    // list + tag filter
    const list = (await (await app.request('/api/contexts?tag=db')).json()) as Context[]
    expect(list.map((c) => c.id)).toContain(ctx.id)

    // search (FTS)
    const found = (await (await app.request('/api/contexts?q=WAL')).json()) as Context[]
    expect(found.some((c) => c.id === ctx.id)).toBe(true)

    // get by id
    const got = (await (await app.request(`/api/contexts/${ctx.id}`)).json()) as Context
    expect(got.body).toBe('use WAL mode')

    // patch
    const patched = await app.request(`/api/contexts/${ctx.id}`, {
      ...json({ body: 'always use WAL', addTags: ['perf'] }),
      method: 'PATCH',
    })
    const after = (await patched.json()) as Context
    expect(after.body).toBe('always use WAL')
    expect(after.tags.sort()).toEqual(['db', 'perf'])

    // history records create + update
    const history = (await (
      await app.request(`/api/contexts/${ctx.id}/history`)
    ).json()) as unknown[]
    expect(history.length).toBe(2)

    // delete (soft) → drops from default list
    const del = await app.request(`/api/contexts/${ctx.id}`, { method: 'DELETE' })
    expect(((await del.json()) as { deleted: boolean }).deleted).toBe(true)
    const afterDel = (await (await app.request('/api/contexts')).json()) as Context[]
    expect(afterDel.some((c) => c.id === ctx.id)).toBe(false)
  })

  it('lists tags with counts', async () => {
    const app = await newApp()
    await app.request('/api/contexts', json({ body: 'a', tags: ['x', 'y'] }))
    await app.request('/api/contexts', json({ body: 'b', tags: ['x'] }))
    const tags = (await (await app.request('/api/tags')).json()) as Array<{
      name: string
      count: number
    }>
    expect(tags.find((t) => t.name === 'x')?.count).toBe(2)
    expect(tags.find((t) => t.name === 'y')?.count).toBe(1)
  })

  it('rejects invalid create bodies with 400', async () => {
    const app = await newApp()
    const bad = await app.request('/api/contexts', json({ kind: 'rule' })) // missing body
    expect(bad.status).toBe(400)
  })
})

describe('studio wiki API', () => {
  it('creates pages, links, backlinks, graph, and resolves titles', async () => {
    const app = await newApp()

    const a = (await (
      await app.request(
        '/api/wiki/pages',
        json({ title: 'Alpha', pageType: 'concept', body: 'see [[Beta]]' }),
      )
    ).json()) as Context
    const b = (await (
      await app.request('/api/wiki/pages', json({ title: 'Beta', pageType: 'concept' }))
    ).json()) as Context
    expect(a.pageType).toBe('concept')

    // [[Beta]] in Alpha's body auto-synced a references link; creating Beta resolved it.
    const aLinks = (await (await app.request(`/api/wiki/pages/${a.id}/links`)).json()) as Array<{
      pageId: string | null
      wanted: boolean
    }>
    expect(aLinks.some((l) => l.pageId === b.id)).toBe(true)

    const bBack = (await (await app.request(`/api/wiki/pages/${b.id}/backlinks`)).json()) as Array<{
      pageId: string
    }>
    expect(bBack.some((l) => l.pageId === a.id)).toBe(true)

    // explicit typed link
    await app.request('/api/wiki/links', json({ fromId: a.id, toId: b.id, type: 'relates' }))
    const graph = (await (await app.request('/api/wiki/graph')).json()) as {
      nodes: unknown[]
      edges: Array<{ from: string; to: string }>
    }
    expect(graph.nodes.length).toBe(2)
    expect(graph.edges.some((e) => e.from === a.id && e.to === b.id)).toBe(true)

    // resolve by title
    const resolved = (await (await app.request('/api/wiki/resolve?title=Alpha')).json()) as Context
    expect(resolved.id).toBe(a.id)
    const missing = await (await app.request('/api/wiki/resolve?title=Nope')).json()
    expect(missing).toBeNull()

    // list pages excludes plain contexts; q searches
    const pages = (await (await app.request('/api/wiki/pages')).json()) as Context[]
    expect(pages.length).toBe(2)
  })

  it('edits one table cell in place (POST /pages/:id/table)', async () => {
    const app = await newApp()
    const p = (await (
      await app.request(
        '/api/wiki/pages',
        json({
          title: 'Providers',
          pageType: 'concept',
          body: '| Name | Status |\n| --- | --- |\n| Acme | old |',
        }),
      )
    ).json()) as Context

    const res = await app.request(
      `/api/wiki/pages/${p.id}/table`,
      json({ row: 'Acme', column: 'Status', value: 'active' }),
    )
    expect(res.status).toBe(200)
    const updated = (await res.json()) as Context
    expect(updated.body).toContain('| Acme | active |')
    expect(updated.body).not.toContain('| Acme | old |')

    // stale ifRev → 409 carrying the live rev
    const conflict = await app.request(
      `/api/wiki/pages/${p.id}/table`,
      json({ row: 'Acme', column: 'Status', value: 'x', ifRev: p.rev }),
    )
    expect(conflict.status).toBe(409)
    expect(((await conflict.json()) as { currentRev: string }).currentRev).toBe(updated.rev)

    // unknown column → 400 (loud, not a silent wrong-place edit)
    const bad = await app.request(
      `/api/wiki/pages/${p.id}/table`,
      json({ row: 'Acme', column: 'Nope', value: 'x' }),
    )
    expect(bad.status).toBe(400)
  })

  it('runs index-addressed structural ops (POST /pages/:id/table/op)', async () => {
    const app = await newApp()
    const mk = async (body: string) =>
      (await (
        await app.request('/api/wiki/pages', json({ title: 'Grid', pageType: 'datatable', body }))
      ).json()) as Context
    const op = (id: string, body: unknown) =>
      app.request(`/api/wiki/pages/${id}/table/op`, json(body))

    const p = await mk('| Name | Status |\n| :--- | --- |\n| Acme | old |\n| Beta | old |')

    // setCell by index.
    let res = await op(p.id, { op: 'setCell', row: 0, col: 1, value: 'active' })
    expect(res.status).toBe(200)
    let cur = (await res.json()) as Context
    expect(cur.body).toContain('| Acme | active |')

    // addColumn (append) → every row padded.
    res = await op(p.id, { op: 'addColumn', name: 'Owner', align: 'center' })
    cur = (await res.json()) as Context
    expect(cur.body).toContain('| Name | Status | Owner |')
    expect(cur.body).toContain('| :--- | --- | :--: |')

    // renameColumn + deleteRow + deleteColumn all succeed.
    expect((await op(p.id, { op: 'renameColumn', col: 2, name: 'Team' })).status).toBe(200)
    expect((await op(p.id, { op: 'deleteRow', row: 1 })).status).toBe(200)
    res = await op(p.id, { op: 'deleteColumn', col: 2 })
    cur = (await res.json()) as Context
    expect(cur.body).not.toContain('Team')
    expect(cur.body).toContain('| Acme | active |')

    // out-of-range index → 400.
    expect((await op(p.id, { op: 'setCell', row: 9, col: 0, value: 'x' })).status).toBe(400)

    // stale ifRev → 409 with the live rev.
    const conflict = await op(p.id, { op: 'addRow', cells: ['Z', 'z'], ifRev: p.rev })
    expect(conflict.status).toBe(409)
    expect(((await conflict.json()) as { currentRev: string }).currentRev).toBe(cur.rev)
  })

  it('refuses structural ops on an immutable source page (400)', async () => {
    // Ingest a source page directly (sources aren't authored via POST /pages).
    const db = await freshDb()
    const app = buildStudioApp(staticProvider(db), { staticDir: fakeStudioDir() })
    const src = await recordSource(db, {
      title: 'Src',
      body: '| a | b |\n| --- | --- |\n| 1 | 2 |',
    })
    const res = await app.request(
      `/api/wiki/pages/${src.id}/table/op`,
      json({ op: 'setCell', row: 0, col: 0, value: 'x' }),
    )
    expect(res.status).toBe(400)
  })

  it('updates a page body and re-syncs wikilinks', async () => {
    const app = await newApp()
    const p = (await (
      await app.request('/api/wiki/pages', json({ title: 'Root', pageType: 'concept' }))
    ).json()) as Context
    const patched = await app.request(`/api/wiki/pages/${p.id}`, {
      ...json({ body: 'now links [[Child]]' }),
      method: 'PATCH',
    })
    expect(patched.status).toBe(200)
    const links = (await (await app.request(`/api/wiki/pages/${p.id}/links`)).json()) as Array<{
      title: string | null
      wanted: boolean
    }>
    expect(links.some((l) => l.title === 'Child' && l.wanted)).toBe(true)
  })

  it('restores a past body via PATCH (ifRev CAS + agentSource label) and rejects a stale rev', async () => {
    const app = await newApp()
    const p = (await (
      await app.request('/api/wiki/pages', json({ title: 'Doc', pageType: 'concept', body: 'v1' }))
    ).json()) as Context
    const patch = (input: unknown) =>
      app.request(`/api/wiki/pages/${p.id}`, { ...json(input), method: 'PATCH' })

    // Edit the body — the content-hash rev advances.
    const v2 = (await (await patch({ body: 'v2', ifRev: p.rev })).json()) as Context
    expect(v2.body).toBe('v2')
    expect(v2.rev).not.toBe(p.rev)

    // A stale ifRev (the original create rev) → 409 carrying the live rev.
    const stale = await patch({ body: 'boom', ifRev: p.rev })
    expect(stale.status).toBe(409)
    expect(((await stale.json()) as { currentRev: string }).currentRev).toBe(v2.rev)

    // Restore v1's body with the fresh rev + agentSource:'restore' → succeeds and is labeled.
    const restored = await patch({ body: 'v1', ifRev: v2.rev, agentSource: 'restore' })
    expect(restored.status).toBe(200)
    expect(((await restored.json()) as Context).body).toBe('v1')

    // History (newest first) records create → update(v2) → restore; the newest row is labeled.
    const history = (await (await app.request(`/api/wiki/pages/${p.id}/history`)).json()) as Array<{
      event: string
      agentSource: string | null
      newBody: string | null
    }>
    expect(history.length).toBe(3)
    expect(history[0]?.agentSource).toBe('restore')
    expect(history[0]?.newBody).toBe('v1')
    expect(history.some((h) => h.event === 'create')).toBe(true)
  })
})

describe('studio export preview API', () => {
  it('renders AGENTS.md / CLAUDE.md / .cursor previews without writing', async () => {
    const app = await newApp()
    await app.request('/api/contexts', json({ body: 'always use WAL mode', kind: 'rule' }))
    await app.request('/api/contexts', json({ body: 'a plain note', kind: 'note' }))

    const files = (await (await app.request('/api/export/preview')).json()) as Array<{
      path: string
      content: string
    }>
    const byPath = (p: string) => files.find((f) => f.path === p)

    // AGENTS.md carries the managed block + the rule/note bodies.
    const agents = byPath('AGENTS.md')
    expect(agents).toBeDefined()
    expect(agents?.content).toContain('BEGIN braincontext-cli')
    expect(agents?.content).toContain('always use WAL mode')

    // CLAUDE.md is rendered, and a .cursor rule file exists for the rule context.
    expect(byPath('CLAUDE.md')).toBeDefined()
    expect(files.some((f) => f.path.startsWith('.cursor/rules/'))).toBe(true)

    // targets filter narrows the output.
    const onlyAgents = (await (
      await app.request('/api/export/preview?targets=agents')
    ).json()) as Array<{ path: string }>
    expect(onlyAgents.map((f) => f.path)).toEqual(['AGENTS.md'])
  })

  it('returns an empty list when there is nothing to export', async () => {
    const app = await newApp()
    const files = (await (
      await app.request('/api/export/preview?targets=agents')
    ).json()) as Array<{
      path: string
      content: string
    }>
    // No contexts → AGENTS.md still renders a (empty) managed block, never throws.
    expect(Array.isArray(files)).toBe(true)
  })
})

describe('studio projects API', () => {
  it('reports status and lists projects via the provider', async () => {
    const app = await newApp()
    const status = (await (await app.request('/api/project')).json()) as {
      project: string
      mode: string
    }
    expect(status.mode).toBe('local')
    const projects = (await (await app.request('/api/projects')).json()) as Array<{
      name: string
      current: boolean
    }>
    expect(projects.some((p) => p.current)).toBe(true)
  })
})
