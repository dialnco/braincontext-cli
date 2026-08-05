import { createHash } from 'node:crypto'
import type { Kysely } from 'kysely'
import { describe, expect, it } from 'vitest'
import { listAccessLog } from '../src/core/access/audit'
import { parseCapabilitySpec, resolveCapabilities } from '../src/core/access/capabilities'
import { AccessDeniedError, AccessError } from '../src/core/access/errors'
import { enterGate } from '../src/core/access/gate'
import { decodeJoinCode, encodeJoinCode } from '../src/core/access/joincode'
import { generateKey, parseKey, verifyKey, verifySecret } from '../src/core/access/keys'
import {
  createPrincipal,
  deletePrincipal,
  issueKey,
  listKeys,
  revokeKey,
  updatePrincipal,
} from '../src/core/access/principals'
import { resolveSession } from '../src/core/access/session'
import { setAccessEnabled } from '../src/core/access/settings'
import { accessStatus } from '../src/core/access/status'
import {
  createContext,
  getContext,
  listContexts,
  listHistory,
  searchContexts,
} from '../src/core/contexts'
import { dataVersion } from '../src/core/db'
import { queryPages } from '../src/core/query'
import type { Database } from '../src/core/types'
import { backlinks, createPage, listPages, wikiGraph } from '../src/core/wiki'
import { freshDb } from './_db'

/** A store with access control on, one owner, and one key for `handle`/`role`. */
async function storeWith(role: 'owner' | 'admin' | 'writer' | 'reader', handle = 'member') {
  const db = await freshDb()
  await createPrincipal(db, { handle: 'boss', role: 'owner' })
  const principal = await createPrincipal(db, { handle, role })
  const issued = await issueKey(db, handle)
  await setAccessEnabled(db, true)
  return { db, principal, key: issued.key, keyId: issued.record.id }
}

describe('keys', () => {
  it('round-trips a generated secret and rejects a wrong one', async () => {
    const generated = await generateKey()
    const parsed = parseKey(generated.key)
    expect(parsed?.prefix).toBe(generated.prefix)
    expect(await verifySecret(parsed?.secret as string, generated.secretHash)).toBe(true)
    expect(await verifySecret('not-the-secret', generated.secretHash)).toBe(false)
  })

  it('never stores the secret itself', async () => {
    const { db, key } = await storeWith('writer')
    const rows = await db.selectFrom('principal_keys').selectAll().execute()
    const secret = parseKey(key)?.secret as string
    expect(JSON.stringify(rows)).not.toContain(secret)
    await db.destroy()
  })

  it('authenticates a valid key', async () => {
    const { db, key } = await storeWith('writer', 'ana')
    const result = await verifyKey(db, key)
    expect(result.ok).toBe(true)
    expect(result.ok && result.principal.handle).toBe('ana')
    await db.destroy()
  })

  it.each([
    ['malformed', 'not-a-key'],
    ['unknown', 'bctxk.aaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
  ])('rejects a %s key', async (reason, candidate) => {
    const { db } = await storeWith('writer')
    const result = await verifyKey(db, candidate)
    expect(result).toEqual({ ok: false, reason })
    await db.destroy()
  })

  it('rejects a revoked key', async () => {
    const { db, key, keyId } = await storeWith('writer')
    await revokeKey(db, keyId)
    expect(await verifyKey(db, key)).toEqual({ ok: false, reason: 'revoked' })
    await db.destroy()
  })

  it('rejects an expired key', async () => {
    const db = await freshDb()
    await createPrincipal(db, { handle: 'temp', role: 'reader' })
    const issued = await issueKey(db, 'temp', {
      expiresAt: new Date(Date.now() + 50).toISOString(),
    })
    await new Promise((r) => setTimeout(r, 80))
    expect(await verifyKey(db, issued.key)).toEqual({ ok: false, reason: 'expired' })
    await db.destroy()
  })

  it('rejects a key belonging to a disabled user', async () => {
    const { db, key } = await storeWith('writer', 'ana')
    await updatePrincipal(db, 'ana', { status: 'disabled' })
    expect(await verifyKey(db, key)).toEqual({ ok: false, reason: 'disabled' })
    await db.destroy()
  })

  it('refuses an expiry in the past', async () => {
    const db = await freshDb()
    await createPrincipal(db, { handle: 'x', role: 'reader' })
    await expect(issueKey(db, 'x', { expiresAt: '2000-01-01T00:00:00Z' })).rejects.toThrow(
      /must be in the future/,
    )
    await db.destroy()
  })
})

describe('capabilities', () => {
  it('gives each role its documented set', () => {
    expect([...resolveCapabilities('owner')]).toContain('users.manage')
    expect([...resolveCapabilities('writer')]).toContain('write')
    expect(resolveCapabilities('writer').has('users.manage')).toBe(false)
    expect(resolveCapabilities('reader').has('write')).toBe(false)
    expect(resolveCapabilities('reader').has('read')).toBe(true)
  })

  it('layers overrides over the role defaults', () => {
    const caps = resolveCapabilities('writer', parseCapabilitySpec('-delete,+users.manage'))
    expect(caps.has('delete')).toBe(false)
    expect(caps.has('users.manage')).toBe(true)
    expect(caps.has('write')).toBe(true)
  })

  it('rejects an unknown capability rather than ignoring it', () => {
    expect(() => parseCapabilitySpec('+wrte')).toThrow(/Unknown capability/)
  })
})

describe('principal policy', () => {
  it('refuses to remove the last active owner', async () => {
    const db = await freshDb()
    await createPrincipal(db, { handle: 'solo', role: 'owner' })
    await expect(deletePrincipal(db, 'solo')).rejects.toThrow(/last active owner/)
    await expect(updatePrincipal(db, 'solo', { role: 'reader' })).rejects.toThrow(
      /last active owner/,
    )
    await expect(updatePrincipal(db, 'solo', { status: 'disabled' })).rejects.toThrow(
      /last active owner/,
    )
    await db.destroy()
  })

  it('allows demoting an owner once another owner exists', async () => {
    const db = await freshDb()
    await createPrincipal(db, { handle: 'a', role: 'owner' })
    await createPrincipal(db, { handle: 'b', role: 'owner' })
    expect((await updatePrincipal(db, 'b', { role: 'writer' })).role).toBe('writer')
    await db.destroy()
  })

  it('stops an admin from modifying an owner or another admin', async () => {
    const db = await freshDb()
    const owner = await createPrincipal(db, { handle: 'boss', role: 'owner' })
    const admin = await createPrincipal(db, { handle: 'adm', role: 'admin' })
    await createPrincipal(db, { handle: 'adm2', role: 'admin' })
    await expect(updatePrincipal(db, 'boss', { role: 'reader' }, admin)).rejects.toThrow(
      /Only an owner/,
    )
    await expect(deletePrincipal(db, 'adm2', admin)).rejects.toThrow(/Only an owner/)
    // The owner may.
    expect((await updatePrincipal(db, 'adm2', { role: 'writer' }, owner)).role).toBe('writer')
    await db.destroy()
  })

  it('rejects duplicate handles case-insensitively', async () => {
    const db = await freshDb()
    await createPrincipal(db, { handle: 'Ana', role: 'writer' })
    await expect(createPrincipal(db, { handle: 'ana', role: 'reader' })).rejects.toThrow(
      AccessError,
    )
    await db.destroy()
  })

  it('keeps the access log when a user is deleted', async () => {
    const { db, principal } = await storeWith('writer', 'ana')
    await enterGate(db, {
      key: null,
      requires: 'write',
      action: 'wiki new',
      surface: 'cli',
    }).catch(() => undefined)
    await deletePrincipal(db, 'ana')
    expect(await listKeys(db, principal.id)).toEqual([]) // keys cascade
    expect((await listAccessLog(db)).length).toBeGreaterThan(0) // history does not
    await db.destroy()
  })
})

describe('enterGate', () => {
  const gate = (db: Kysely<Database>, key: string | null, requires: 'read' | 'write' | 'delete') =>
    enterGate(db, { key, requires, action: `test ${requires}`, surface: 'cli' })

  it('permits everything when access control is off', async () => {
    const db = await freshDb()
    const result = await gate(db, null, 'write')
    expect(result.result.enabled).toBe(false)
    expect(result.session).toBeNull()
    expect(await listAccessLog(db)).toEqual([]) // a disabled project logs nothing
    await db.destroy()
  })

  it('lets a writer write and a reader read', async () => {
    const w = await storeWith('writer')
    await expect(gate(w.db, w.key, 'write')).resolves.toBeTruthy()
    await w.db.destroy()

    const r = await storeWith('reader')
    await expect(gate(r.db, r.key, 'read')).resolves.toBeTruthy()
    await r.db.destroy()
  })

  it('denies a reader a write, and records the denial', async () => {
    const { db, key } = await storeWith('reader', 'ana')
    await expect(gate(db, key, 'write')).rejects.toThrow(AccessDeniedError)
    const denials = await listAccessLog(db, { denyOnly: true })
    expect(denials).toHaveLength(1)
    expect(denials[0]?.handle).toBe('ana')
    expect(denials[0]?.action).toBe('test write')
    await db.destroy()
  })

  it('denies an unauthenticated caller with a way out', async () => {
    const { db } = await storeWith('reader')
    await expect(gate(db, null, 'read')).rejects.toThrow(/bctx project join/)
    await db.destroy()
  })

  it('hands a reader a handle that physically refuses writes', async () => {
    const { db, key } = await storeWith('reader')
    const readOnly = (await gate(db, key, 'read')).db
    await expect(listContexts(readOnly, {})).resolves.toEqual([])
    // The capability check already refused the operation; this is the backstop for
    // any path that forgot to ask.
    await expect(createContext(readOnly, { body: 'sneaky', kind: 'note' })).rejects.toThrow(
      /read-only/,
    )
    await db.destroy()
  })

  it('does not restrict a writer handle', async () => {
    const { db, key } = await storeWith('writer')
    const handle = (await gate(db, key, 'write')).db
    await expect(createContext(handle, { body: 'ok', kind: 'note' })).resolves.toBeTruthy()
    await db.destroy()
  })

  it('leaves every read path a reader uses working', async () => {
    // The read-only plugin inspects raw SQL, so a careless rule would reject
    // legitimate reads — FTS5 search and `PRAGMA data_version` (which Studio polls
    // every 2.5s) are both raw. A false positive here would silently break search
    // for every reader, so exercise the real query paths, not just the ORM ones.
    const db = await freshDb()
    const ctx = await createContext(db, { body: 'pnpm over npm', kind: 'rule', title: 'Pkg' })
    const page = await createPage(db, {
      title: 'Alpha',
      pageType: 'concept',
      body: 'see [[Beta]]',
      metadata: { props: { status: 'active' } },
    })
    await createPrincipal(db, { handle: 'r', role: 'reader' })
    const issued = await issueKey(db, 'r')
    await setAccessEnabled(db, true)
    const readOnly = (await gate(db, issued.key, 'read')).db

    expect((await searchContexts(readOnly, 'pnpm')).map((c) => c.id)).toEqual([ctx.id])
    expect(await dataVersion(readOnly)).toBeTypeOf('number')
    expect((await getContext(readOnly, ctx.id))?.id).toBe(ctx.id)
    expect((await listHistory(readOnly, ctx.id)).length).toBeGreaterThan(0)
    expect((await listPages(readOnly, {})).length).toBe(1)
    expect((await queryPages(readOnly, { where: { status: 'active' } })).length).toBe(1)
    await expect(wikiGraph(readOnly, {})).resolves.toBeTruthy()
    await expect(backlinks(readOnly, page.id)).resolves.toBeTruthy()
    await db.destroy()
  })

  it('logs allowed writes but not allowed reads by default', async () => {
    const { db, key } = await storeWith('writer')
    await gate(db, key, 'read')
    expect(await listAccessLog(db)).toEqual([])
    await gate(db, key, 'write')
    const log = await listAccessLog(db)
    expect(log).toHaveLength(1)
    expect(log[0]?.decision).toBe('allow')
    await db.destroy()
  })
})

describe('attribution', () => {
  it('stamps the authenticated principal on rows it writes', async () => {
    const { db, key, principal } = await storeWith('writer', 'ana')
    const { runWithSession } = await import('../src/core/access/session')
    const session = await resolveSession(db, key)
    if (!session.enabled || !session.ok) throw new Error('expected a session')

    const ctx = await runWithSession(session.session, () =>
      createContext(db, { body: 'authored', kind: 'note' }),
    )
    const row = await db
      .selectFrom('contexts')
      .select('principal_id')
      .where('id', '=', ctx.id)
      .executeTakeFirst()
    expect(row?.principal_id).toBe(principal.id)

    const history = await db
      .selectFrom('context_history')
      .select('principal_id')
      .where('context_id', '=', ctx.id)
      .executeTakeFirst()
    expect(history?.principal_id).toBe(principal.id)
    await db.destroy()
  })

  it('leaves principal_id null when access control is off', async () => {
    const db = await freshDb()
    const ctx = await createContext(db, { body: 'anon', kind: 'note' })
    const row = await db
      .selectFrom('contexts')
      .select('principal_id')
      .where('id', '=', ctx.id)
      .executeTakeFirst()
    expect(row?.principal_id).toBeNull()
    await db.destroy()
  })
})

describe('accessStatus', () => {
  it('reports counts and never leaks key material', async () => {
    const { db, key } = await storeWith('writer', 'ana')
    const session = await resolveSession(db, key)
    const status = await accessStatus(db, session.enabled && session.ok ? session.session : null)
    expect(status.enabled).toBe(true)
    expect(status.mode).toBe('advisory')
    expect(status.userCount).toBe(2)
    expect(status.activeKeyCount).toBe(1)
    expect(status.me?.handle).toBe('ana')
    const serialized = JSON.stringify(status)
    expect(serialized).not.toContain(parseKey(key)?.secret as string)
    expect(serialized).not.toContain('scrypt$')
    await db.destroy()
  })
})

describe('join codes', () => {
  it('round-trips a payload', () => {
    const payload = {
      v: 1 as const,
      n: 'work',
      u: 'libsql://example.turso.io',
      t: 'tok',
      k: 'bctxk.aaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      h: 'ana',
    }
    expect(decodeJoinCode(encodeJoinCode(payload))).toEqual(payload)
  })

  it('detects a body that lost characters, instead of failing obscurely', () => {
    const code = encodeJoinCode({
      v: 1,
      n: 'work',
      k: 'bctxk.aaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    })
    // A code mangled in transit but still shaped like one: the checksum is what
    // turns this into an actionable message rather than a JSON parse error.
    const [scheme, body, sum] = code.split('.') as [string, string, string]
    const damaged = `${scheme}.${body.slice(0, -5)}.${sum}`
    expect(() => decodeJoinCode(damaged)).toThrow(/truncated or corrupted/)
  })

  it('rejects something that is not a join code', () => {
    expect(() => decodeJoinCode('hello')).toThrow(/Not a join code/)
    // A code cut off before its checksum no longer has three segments.
    const code = encodeJoinCode({
      v: 1,
      n: 'work',
      k: 'bctxk.aaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    })
    expect(() => decodeJoinCode(code.slice(0, code.length - 12))).toThrow(/Not a join code/)
  })

  it('rejects a payload without a usable key', () => {
    const body = Buffer.from(JSON.stringify({ v: 1, n: 'work', k: 'nope' })).toString('base64url')
    // Checksum recomputed, so it is the KEY that fails validation, not the framing.
    const sum = createHash('sha256').update(body).digest('base64url').slice(0, 8)
    expect(() => decodeJoinCode(`bctxj.${body}.${sum}`)).toThrow(/no valid access key/)
  })
})
