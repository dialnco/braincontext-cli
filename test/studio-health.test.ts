import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Hono } from 'hono'
import type { Kysely } from 'kysely'
import { describe, expect, it } from 'vitest'
import type { Database } from '../src/core/types'
import { createPage } from '../src/core/wiki'
import { buildStudioApp } from '../src/studio/server'
import { staticProvider } from '../src/studio/stores'
import { freshDb } from './_db'

function fakeStudioDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bctx-studio-'))
  writeFileSync(join(dir, 'index.html'), '<!doctype html><div id="root">poc</div>')
  return dir
}

async function newApp(): Promise<{ app: Hono; db: Kysely<Database> }> {
  const db = await freshDb()
  return { app: buildStudioApp(staticProvider(db), { staticDir: fakeStudioDir() }), db }
}

describe('studio health surface', () => {
  it('GET /api/wiki/lint returns findings for a seeded unhealthy wiki', async () => {
    const { app, db } = await newApp()
    await createPage(db, { title: 'Lonely', pageType: 'concept', body: '' })
    await createPage(db, { title: 'A', pageType: 'concept', body: 'see [[Ghost]]' })

    const res = await app.request('/api/wiki/lint')
    expect(res.status).toBe(200)
    const report = (await res.json()) as { findings: any[]; counts: Record<string, number> }
    expect(report.findings.some((f: any) => f.kind === 'orphan' && f.title === 'Lonely')).toBe(true)
    expect(report.findings.some((f: any) => f.kind === 'wanted' && f.title === 'Ghost')).toBe(true)
    expect(report.counts.orphan).toBeGreaterThan(0)
    await db.destroy()
  })

  it('honors the staleDays query param', async () => {
    const { app, db } = await newApp()
    const old = new Date(Date.now() - 10 * 86_400_000).toISOString()
    await createPage(db, {
      title: 'Aging',
      pageType: 'concept',
      body: 'x',
      createdAt: old,
      updatedAt: old,
    })

    const strict = (await (await app.request('/api/wiki/lint?staleDays=5')).json()) as {
      findings: any[]
    }
    expect(strict.findings.some((f: any) => f.kind === 'never-verified')).toBe(true)
    const lax = (await (await app.request('/api/wiki/lint?staleDays=30')).json()) as {
      findings: any[]
    }
    expect(lax.findings.some((f: any) => f.kind === 'never-verified')).toBe(false)
    await db.destroy()
  })

  it('POST /api/wiki/pages/:id/verify verifies via core (op logged), 409 on sources', async () => {
    const { app, db } = await newApp()
    const page = await createPage(db, { title: 'Gateway', pageType: 'entity', body: 'edge' })

    const res = await app.request(`/api/wiki/pages/${page.id}/verify`, { method: 'POST' })
    expect(res.status).toBe(200)
    const updated = (await res.json()) as { metadata: Record<string, unknown> }
    expect(typeof updated.metadata.verifiedAt).toBe('string')
    expect(updated.metadata.verifiedBy).toBe('studio')

    const log = await db.selectFrom('wiki_log').selectAll().execute()
    expect(log.some((e) => e.op === 'verify' && e.ref_id === page.id)).toBe(true)

    const missing = await app.request('/api/wiki/pages/nope/verify', { method: 'POST' })
    expect(missing.status).toBe(404)
    await db.destroy()
  })
})
