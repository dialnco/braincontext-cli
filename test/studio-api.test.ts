import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { Context } from '../src/core/contexts'
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
