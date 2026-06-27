import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createContext } from '../src/core/contexts'
import { buildStudioApp } from '../src/studio/server'
import { staticProvider } from '../src/studio/stores'
import { freshDb } from './_db'

/** A stand-in for the built dist/studio (avoids needing a vite build in CI). */
function fakeStudioDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bctx-studio-'))
  writeFileSync(join(dir, 'index.html'), '<!doctype html><div id="root">poc</div>')
  return dir
}

describe('studio server', () => {
  it('serves health, index, SPA fallback, API 404, and seeded contexts', async () => {
    const db = await freshDb()
    await createContext(db, { body: 'Prefer pnpm over npm', kind: 'rule', tags: ['tooling'] })
    const app = buildStudioApp(staticProvider(db), { staticDir: fakeStudioDir() })

    const health = await app.request('/api/health')
    expect(health.status).toBe(200)
    expect(((await health.json()) as { status: string }).status).toBe('ok')

    const index = await app.request('/')
    expect(index.status).toBe(200)
    expect(index.headers.get('content-type')).toContain('text/html')
    expect(await index.text()).toContain('id="root"')

    // Unknown client route → history fallback to index.html (not a 404).
    const fallback = await app.request('/some/client/route')
    expect(fallback.status).toBe(200)
    expect(await fallback.text()).toContain('id="root"')

    // Unknown API route → JSON 404, never the SPA shell.
    const missing = await app.request('/api/nope')
    expect(missing.status).toBe(404)

    const ctxs = await app.request('/api/contexts')
    expect(ctxs.status).toBe(200)
    const rows = (await ctxs.json()) as Array<{ body: string }>
    expect(rows.length).toBe(1)
    expect(rows[0]?.body).toBe('Prefer pnpm over npm')

    await db.destroy()
  })
})
