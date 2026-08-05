import { Hono } from 'hono'
import { z } from 'zod'
import { listAccessLog } from '../../core/access/audit'
import { CAPABILITIES, type CapabilityOverrides } from '../../core/access/capabilities'
import { AccessDeniedError, AccessError } from '../../core/access/errors'
import {
  encodeJoinCode,
  type JoinPayload,
  joinCodeWarning,
  LOCAL_JOIN_CODE_NOTE,
} from '../../core/access/joincode'
import {
  createPrincipal,
  deletePrincipal,
  getPrincipalByHandle,
  issueKey,
  listKeys,
  listPrincipals,
  revokeKey,
  updatePrincipal,
} from '../../core/access/principals'
import { currentSession } from '../../core/access/session'
import { accessStatus } from '../../core/access/status'
import { getProject, resolveToken } from '../../core/registry'
import { ROLES } from '../../core/types'
import { intQuery, readJson, strQuery } from '../http'
import type { StoreProvider } from '../stores'

const overrides = z.record(z.enum(CAPABILITIES), z.boolean()).optional()

const createBody = z.object({
  handle: z.string().min(1),
  role: z.enum(ROLES),
  displayName: z.string().nullable().optional(),
  capabilities: overrides,
  expiresAt: z.string().nullable().optional(),
})

const updateBody = z.object({
  role: z.enum(ROLES).optional(),
  displayName: z.string().nullable().optional(),
  capabilities: overrides,
  status: z.enum(['active', 'disabled']).optional(),
})

const issueBody = z.object({
  label: z.string().nullable().optional(),
  expiresAt: z.string().nullable().optional(),
})

/**
 * Users, keys, and the access log for the Studio settings panel. Every route here
 * needs `users.manage` (see capabilityFor), so the handlers assume the caller is
 * already authorized and only apply the actor-relative rules (an admin may not
 * touch an owner) that core/access enforces.
 *
 * Issued secrets are returned EXACTLY ONCE, in the response that creates them.
 * Nothing else in this module can read a key back out.
 */
export function accessRoutes(provider: StoreProvider): Hono {
  const app = new Hono()

  // Domain error → status. `owner_required` is a permission refusal, not bad input;
  // `last_owner` is a well-formed request that would break an invariant.
  const STATUS: Record<string, 400 | 403 | 404 | 409> = {
    owner_required: 403,
    last_owner: 409,
    duplicate_handle: 409,
    no_such_principal: 404,
    no_such_key: 404,
  }
  app.onError((err, c) => {
    if (err instanceof AccessDeniedError) return c.json({ error: err.message, code: err.code }, 403)
    if (err instanceof AccessError) {
      return c.json({ error: err.message, code: err.code }, STATUS[err.code] ?? 400)
    }
    throw err
  })

  app.get('/status', async (c) => c.json(await accessStatus(provider.db(), currentSession())))

  app.get('/users', async (c) => c.json({ users: await listPrincipals(provider.db()) }))

  app.post('/users', async (c) => {
    const parsed = await readJson(c, createBody)
    if (!parsed.ok) return parsed.res
    const db = provider.db()
    const actor = currentSession()?.principal ?? null
    const { role } = parsed.data
    if (actor && actor.role !== 'owner' && (role === 'owner' || role === 'admin')) {
      return c.json({ error: `Only an owner can create an ${role}.`, code: 'owner_required' }, 403)
    }
    const principal = await createPrincipal(db, {
      handle: parsed.data.handle,
      role,
      displayName: parsed.data.displayName ?? null,
      overrides: (parsed.data.capabilities ?? {}) as CapabilityOverrides,
      createdBy: actor?.id ?? null,
    })
    const issued = await issueKey(db, principal.handle, {
      expiresAt: parsed.data.expiresAt ?? null,
      createdBy: actor?.id ?? null,
    })
    return c.json(
      { user: principal, ...secretPayload(provider, principal.handle, issued.key) },
      201,
    )
  })

  app.patch('/users/:handle', async (c) => {
    const parsed = await readJson(c, updateBody)
    if (!parsed.ok) return parsed.res
    const user = await updatePrincipal(
      provider.db(),
      c.req.param('handle'),
      {
        role: parsed.data.role,
        displayName: parsed.data.displayName,
        overrides: parsed.data.capabilities as CapabilityOverrides | undefined,
        status: parsed.data.status,
      },
      currentSession()?.principal ?? null,
    )
    return c.json({ user })
  })

  app.delete('/users/:handle', async (c) => {
    const removed = await deletePrincipal(
      provider.db(),
      c.req.param('handle'),
      currentSession()?.principal ?? null,
    )
    return c.json({ removed })
  })

  app.get('/users/:handle/keys', async (c) => {
    const user = await requireUser(provider, c.req.param('handle'))
    return c.json({ keys: await listKeys(provider.db(), user.id) })
  })

  app.post('/users/:handle/keys', async (c) => {
    const parsed = await readJson(c, issueBody)
    if (!parsed.ok) return parsed.res
    const handle = c.req.param('handle')
    await requireUser(provider, handle)
    const issued = await issueKey(provider.db(), handle, {
      label: parsed.data.label ?? null,
      expiresAt: parsed.data.expiresAt ?? null,
      createdBy: currentSession()?.principal.id ?? null,
    })
    return c.json({ record: issued.record, ...secretPayload(provider, handle, issued.key) }, 201)
  })

  app.delete('/keys/:id', async (c) => {
    const record = await revokeKey(provider.db(), c.req.param('id'))
    return c.json({ record })
  })

  app.get('/log', async (c) =>
    c.json({
      entries: await listAccessLog(provider.db(), {
        limit: intQuery(c, 'limit') ?? 50,
        handle: strQuery(c, 'user'),
        denyOnly: c.req.query('denyOnly') === 'true',
      }),
    }),
  )

  return app
}

async function requireUser(provider: StoreProvider, handle: string) {
  const user = await getPrincipalByHandle(provider.db(), handle)
  if (!user) throw new AccessError(`No such user: "${handle}".`, 'no_such_principal')
  return user
}

/**
 * The one-time secret payload: the raw key plus, when the project has a remote, a
 * ready-to-send join code and the warning that must accompany it.
 */
function secretPayload(
  provider: StoreProvider,
  handle: string,
  key: string,
): { key: string; joinCode: string | null; warning: string } {
  const project = provider.status().project
  const entry = project ? getProject(project) : undefined
  if (!project || !entry) return { key, joinCode: null, warning: LOCAL_JOIN_CODE_NOTE }
  const payload: JoinPayload = {
    v: 1,
    n: project,
    u: entry.syncUrl,
    t: entry.syncUrl ? resolveToken(project) : undefined,
    k: key,
    h: handle,
  }
  return { key, joinCode: encodeJoinCode(payload), warning: joinCodeWarning(payload) }
}
