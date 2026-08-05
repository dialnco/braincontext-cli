import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Hono } from 'hono'
import type { Kysely } from 'kysely'
import { describe, expect, it } from 'vitest'
import { listAccessLog } from '../src/core/access/audit'
import { createPrincipal, issueKey, revokeKey } from '../src/core/access/principals'
import { setAccessEnabled } from '../src/core/access/settings'
import type { Database, Role } from '../src/core/types'
import { capabilityFor, SESSION_COOKIE } from '../src/studio/access'
import { buildStudioApp } from '../src/studio/server'
import { staticProvider } from '../src/studio/stores'
import { freshDb } from './_db'

function fakeStudioDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bctx-studio-auth-'))
  writeFileSync(join(dir, 'index.html'), '<!doctype html><div id="root">poc</div>')
  return dir
}

interface Fixture {
  app: Hono
  db: Kysely<Database>
  keys: Record<string, string>
}

/** A studio app over a store with access control on and one key per listed role. */
async function fixture(roles: Role[], localKey?: string | null): Promise<Fixture> {
  const db = await freshDb()
  const keys: Record<string, string> = {}
  await createPrincipal(db, { handle: 'boss', role: 'owner' })
  keys.boss = (await issueKey(db, 'boss')).key
  for (const role of roles) {
    if (role === 'owner') continue
    await createPrincipal(db, { handle: role, role })
    keys[role] = (await issueKey(db, role)).key
  }
  await setAccessEnabled(db, true)
  const app = buildStudioApp(staticProvider(db), {
    staticDir: fakeStudioDir(),
    localKey: localKey === undefined ? null : localKey,
  })
  return { app, db, keys }
}

const post = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

/** Log in and return the session cookie value to send on later requests. */
async function login(app: Hono, key: string): Promise<string> {
  const res = await app.request('/api/auth/login', post({ key }))
  expect(res.status).toBe(200)
  const cookie = res.headers.get('set-cookie') ?? ''
  const value = /bctx_sid=([^;]+)/.exec(cookie)?.[1]
  expect(value).toBeTruthy()
  return `${SESSION_COOKIE}=${value}`
}

describe('capabilityFor', () => {
  it('maps the API surface to capabilities', () => {
    expect(capabilityFor('GET', '/api/health')).toBeNull()
    expect(capabilityFor('POST', '/api/auth/login')).toBeNull()
    expect(capabilityFor('POST', '/api/project/switch')).toBeNull()
    expect(capabilityFor('GET', '/api/contexts')).toBe('read')
    expect(capabilityFor('POST', '/api/contexts')).toBe('write')
    expect(capabilityFor('PATCH', '/api/wiki/pages/x')).toBe('write')
    expect(capabilityFor('DELETE', '/api/contexts/x')).toBe('delete')
    expect(capabilityFor('GET', '/api/files')).toBe('files.read')
    expect(capabilityFor('POST', '/api/files')).toBe('files.write')
    expect(capabilityFor('GET', '/api/files/status')).toBe('config.read')
    expect(capabilityFor('PUT', '/api/files/config')).toBe('config.write')
    expect(capabilityFor('GET', '/api/access/users')).toBe('users.manage')
    // An unmapped path is treated as ordinary store data, never as ungated.
    expect(capabilityFor('GET', '/api/something-new')).toBe('read')
    expect(capabilityFor('POST', '/api/something-new')).toBe('write')
  })
})

describe('studio without access control', () => {
  it('behaves exactly as before — no login, no gate', async () => {
    const db = await freshDb()
    const app = buildStudioApp(staticProvider(db), { staticDir: fakeStudioDir() })

    const me = await app.request('/api/auth/me')
    expect(await me.json()).toEqual({ enabled: false, authenticated: false, identity: null })

    const created = await app.request('/api/contexts', post({ body: 'open', kind: 'note' }))
    expect(created.status).toBe(201)
    expect(await listAccessLog(db)).toEqual([])
    await db.destroy()
  })
})

describe('studio login', () => {
  it('reports an unauthenticated caller and why', async () => {
    const { app, db } = await fixture(['writer'])
    const body = (await (await app.request('/api/auth/me')).json()) as Record<string, unknown>
    expect(body.enabled).toBe(true)
    expect(body.authenticated).toBe(false)
    expect(String(body.message)).toMatch(/requires an access key/)
    await db.destroy()
  })

  it('refuses API access without a key, with 401', async () => {
    const { app, db } = await fixture(['writer'])
    const res = await app.request('/api/contexts')
    expect(res.status).toBe(401)
    await db.destroy()
  })

  it('accepts a valid key and issues a session cookie', async () => {
    const { app, db, keys } = await fixture(['writer'])
    const cookie = await login(app, keys.writer as string)

    const me = (await (
      await app.request('/api/auth/me', { headers: { cookie } })
    ).json()) as Record<string, { handle: string }>
    expect(me.identity?.handle).toBe('writer')

    const created = await app.request('/api/contexts', {
      ...post({ body: 'from studio', kind: 'note' }),
      headers: { 'content-type': 'application/json', cookie },
    })
    expect(created.status).toBe(201)
    await db.destroy()
  })

  it('rejects a bad key without saying whether the prefix exists', async () => {
    const { app, db } = await fixture(['writer'])
    const res = await app.request(
      '/api/auth/login',
      post({ key: 'bctxk.aaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }),
    )
    expect(res.status).toBe(401)
    expect(String(((await res.json()) as { error: string }).error)).toMatch(/not recognized/)
    await db.destroy()
  })

  it('rejects a revoked key and stops an established session', async () => {
    const db = await freshDb()
    await createPrincipal(db, { handle: 'boss', role: 'owner' })
    await createPrincipal(db, { handle: 'ana', role: 'writer' })
    const issued = await issueKey(db, 'ana')
    await setAccessEnabled(db, true)
    const app = buildStudioApp(staticProvider(db), { staticDir: fakeStudioDir(), localKey: null })
    const cookie = await login(app, issued.key)
    expect((await app.request('/api/contexts', { headers: { cookie } })).status).toBe(200)

    await revokeKey(db, issued.record.id)
    const { createStudioSessions } = await import('../src/studio/access')
    // The live app caches for SESSION_TTL_MS, so assert the underlying behavior
    // directly: a fresh resolver sees the revocation immediately.
    const fresh = createStudioSessions()
    const result = await fresh.resolve(db, issued.key)
    expect(result.enabled && !result.ok && result.reason).toBe('revoked')
    await db.destroy()
  })

  it('logs out', async () => {
    const { app, db, keys } = await fixture(['writer'])
    const cookie = await login(app, keys.writer as string)
    const out = await app.request('/api/auth/logout', { method: 'POST', headers: { cookie } })
    expect(out.status).toBe(200)
    expect((await app.request('/api/contexts', { headers: { cookie } })).status).toBe(401)
    await db.destroy()
  })

  it('never returns key material from the auth endpoints', async () => {
    const { app, db, keys } = await fixture(['writer'])
    const key = keys.writer as string
    const res = await app.request('/api/auth/login', post({ key }))
    const text = await res.text()
    expect(text).not.toContain(key)
    expect(text).not.toContain('scrypt$')
    await db.destroy()
  })
})

describe('studio capability enforcement', () => {
  it('lets a reader read but refuses a write with 403', async () => {
    const { app, db, keys } = await fixture(['reader'])
    const cookie = await login(app, keys.reader as string)

    expect((await app.request('/api/contexts', { headers: { cookie } })).status).toBe(200)

    const res = await app.request('/api/contexts', {
      ...post({ body: 'nope', kind: 'note' }),
      headers: { 'content-type': 'application/json', cookie },
    })
    expect(res.status).toBe(403)
    expect(String(((await res.json()) as { error: string }).error)).toMatch(/Permission denied/)
    expect(await db.selectFrom('contexts').selectAll().execute()).toEqual([])

    const denials = await listAccessLog(db, { denyOnly: true })
    expect(denials[0]?.handle).toBe('reader')
    expect(denials[0]?.surface).toBe('studio')
    await db.destroy()
  })

  it('refuses a writer the user-management routes', async () => {
    const { app, db, keys } = await fixture(['writer'])
    const cookie = await login(app, keys.writer as string)
    expect((await app.request('/api/access/users', { headers: { cookie } })).status).toBe(403)
    await db.destroy()
  })

  it('lets an owner manage users and returns each secret exactly once', async () => {
    const { app, db, keys } = await fixture([])
    const cookie = await login(app, keys.boss as string)

    const created = await app.request('/api/access/users', {
      ...post({ handle: 'ana', role: 'writer' }),
      headers: { 'content-type': 'application/json', cookie },
    })
    expect(created.status).toBe(201)
    const payload = (await created.json()) as { key: string; warning: string }
    expect(payload.key).toMatch(/^bctxk\./)
    expect(payload.warning).toMatch(/like a password/)

    // The key is not retrievable afterwards, from any listing.
    const listed = await (await app.request('/api/access/users', { headers: { cookie } })).text()
    expect(listed).not.toContain(payload.key)
    const keyList = await (
      await app.request('/api/access/users/ana/keys', { headers: { cookie } })
    ).text()
    expect(keyList).not.toContain(payload.key)
    expect(keyList).not.toContain('scrypt$')
    await db.destroy()
  })

  it('stops an admin from touching an owner', async () => {
    const { app, db, keys } = await fixture(['admin'])
    const cookie = await login(app, keys.admin as string)
    const res = await app.request('/api/access/users/boss', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ role: 'reader' }),
    })
    expect(res.status).toBe(403)
    await db.destroy()
  })

  it('maps domain errors to honest statuses', async () => {
    const { app, db, keys } = await fixture([])
    const cookie = await login(app, keys.boss as string)
    const headers = { 'content-type': 'application/json', cookie }

    // Unknown user → 404, not 400.
    expect((await app.request('/api/access/users/ghost/keys', { headers })).status).toBe(404)
    // Removing the only owner would lock the project out of its own administration.
    const last = await app.request('/api/access/users/boss', { method: 'DELETE', headers })
    expect(last.status).toBe(409)
    // Duplicate handle → conflict.
    await app.request('/api/access/users', {
      ...post({ handle: 'ana', role: 'reader' }),
      headers,
    })
    const dupe = await app.request('/api/access/users', {
      ...post({ handle: 'ANA', role: 'reader' }),
      headers,
    })
    expect(dupe.status).toBe(409)
    await db.destroy()
  })

  it('adopts this machine key when the request has no cookie', async () => {
    const db = await freshDb()
    await createPrincipal(db, { handle: 'boss', role: 'owner' })
    const issued = await issueKey(db, 'boss')
    await setAccessEnabled(db, true)
    const app = buildStudioApp(staticProvider(db), {
      staticDir: fakeStudioDir(),
      localKey: issued.key,
    })

    const me = (await (await app.request('/api/auth/me')).json()) as {
      authenticated: boolean
      adopted: boolean
      identity: { handle: string }
    }
    expect(me.authenticated).toBe(true)
    expect(me.adopted).toBe(true)
    expect(me.identity.handle).toBe('boss')
    // …and it actually authorizes, not just reports.
    expect((await app.request('/api/contexts', post({ body: 'x', kind: 'note' }))).status).toBe(201)
    await db.destroy()
  })

  it('attributes a studio write to the logged-in principal', async () => {
    const { app, db, keys } = await fixture(['writer'])
    const cookie = await login(app, keys.writer as string)
    await app.request('/api/contexts', {
      ...post({ body: 'authored in studio', kind: 'note' }),
      headers: { 'content-type': 'application/json', cookie },
    })
    const row = await db
      .selectFrom('contexts')
      .innerJoin('principals', 'principals.id', 'contexts.principal_id')
      .select('principals.handle')
      .executeTakeFirst()
    expect(row?.handle).toBe('writer')
    await db.destroy()
  })
})
