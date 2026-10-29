import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { createPrincipal, issueKey } from '../src/core/access/principals'
import { setAccessEnabled } from '../src/core/access/settings'
import { capabilityFor, SESSION_COOKIE } from '../src/studio/access'
import { buildStudioApp } from '../src/studio/server'
import { staticProvider } from '../src/studio/stores'
import { freshStore } from './_db'

function fakeStudioDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bctx-studio-inbox-'))
  writeFileSync(join(dir, 'index.html'), '<!doctype html><div id="root"></div>')
  return dir
}

const json = (method: string, body: unknown, cookie?: string) => ({
  method,
  headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
  body: JSON.stringify(body),
})

async function body(res: Response | Promise<Response>): Promise<any> {
  return (await res).json()
}

async function login(app: Hono, key: string): Promise<string> {
  const res = await app.request('/api/auth/login', json('POST', { key }))
  expect(res.status).toBe(200)
  const value = /bctx_sid=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1]
  return `${SESSION_COOKIE}=${value}`
}

/** Studio over a "shared" store (the provider is handed its client) with access on. */
async function fixture(opts: { shared?: boolean; access?: boolean } = {}) {
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
  if (opts.access !== false) await setAccessEnabled(db, true)
  const app = buildStudioApp(staticProvider(db, opts.shared === false ? undefined : client), {
    staticDir: fakeStudioDir(),
    localKey: keys.diego,
  })
  return { app, db, keys }
}

describe('capabilityFor — inbox', () => {
  it('maps inbox routes ahead of the generic rules', () => {
    expect(capabilityFor('GET', '/api/inbox/status')).toBeNull()
    expect(capabilityFor('GET', '/api/inbox/threads')).toBe('inbox.read')
    expect(capabilityFor('POST', '/api/inbox/threads/1/reply')).toBe('inbox.write')
    expect(capabilityFor('DELETE', '/api/inbox/threads/1')).toBe('inbox.write')
    // A lookalike path is not the inbox.
    expect(capabilityFor('GET', '/api/inboxes')).toBe('read')
  })
})

describe('Studio inbox API', () => {
  it('sends as the local member and lets the recipient resolve it', async () => {
    const { app, keys } = await fixture()
    const sent = await app.request(
      '/api/inbox/threads',
      json('POST', { to: '@susana', body: 'Review the pricing page?', kind: 'ask' }),
    )
    expect(sent.status).toBe(201)
    const t = await body(sent)
    expect(t.from.handle).toBe('diego')

    const susana = await login(app, keys.susana as string)
    const summary = await body(app.request('/api/inbox/summary', { headers: { cookie: susana } }))
    expect(summary.unread).toBe(1)

    const early = await app.request(
      `/api/inbox/threads/${t.num}/action`,
      json('POST', { action: 'resolve' }, susana),
    )
    expect(early.status).toBe(400)
    expect((await body(early)).code).toBe('answer_required')

    const done = await app.request(
      `/api/inbox/threads/${t.num}/action`,
      json('POST', { action: 'resolve', note: 'Looks good' }, susana),
    )
    expect(done.status).toBe(200)
    const view = await body(done)
    expect(view.status).toBe('resolved')
    expect(view.messages.at(-1).surface).toBe('studio')
    expect(view.messages.at(-1).byAgent).toBe(false)

    const again = await app.request(
      `/api/inbox/threads/${t.num}/action`,
      json('POST', { action: 'resolve', note: 'x' }, susana),
    )
    expect(again.status).toBe(409)
  })

  it('lists members (handle + name only) and threads for the board', async () => {
    const { app } = await fixture()
    const members = await body(app.request('/api/inbox/members'))
    expect(members.map((m: { handle: string }) => m.handle)).toEqual([
      'boss',
      'diego',
      'rita',
      'susana',
    ])
    expect(Object.keys(members[0]).sort()).toEqual(['displayName', 'handle'])
    await app.request('/api/inbox/threads', json('POST', { to: '@team', body: 'anyone?' }))
    const list = await body(app.request('/api/inbox/threads?box=team'))
    expect(list.length).toBe(1)
  })

  it('a muted member is refused writes', async () => {
    const { app, db } = await fixture()
    const { updatePrincipal } = await import('../src/core/access/principals')
    await updatePrincipal(db, 'diego', { overrides: { 'inbox.write': false } })
    const res = await app.request('/api/inbox/threads', json('POST', { to: '@susana', body: 'x' }))
    expect(res.status).toBe(403)
  })

  it('reports why the inbox is unavailable', async () => {
    const local = await fixture({ shared: false })
    const s1 = await body(local.app.request('/api/inbox/status'))
    expect(s1).toMatchObject({ available: false, reason: 'local_project' })
    expect(s1.steps).toMatch(/access init/)
    const r = await local.app.request('/api/inbox/threads')
    expect(r.status).toBe(412)

    const off = await fixture({ access: false })
    const s2 = await body(off.app.request('/api/inbox/status'))
    expect(s2).toMatchObject({ available: false, reason: 'access_off' })

    const ok = await fixture()
    expect(await body(ok.app.request('/api/inbox/status'))).toMatchObject({
      available: true,
    })
  })
})
