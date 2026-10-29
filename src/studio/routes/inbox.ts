import { createHash } from 'node:crypto'
import type { Context as HonoContext } from 'hono'
import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import { z } from 'zod'
import { AccessDeniedError } from '../../core/access/errors'
import { currentSession } from '../../core/access/session'
import { isAccessEnabled } from '../../core/access/settings'
import { INBOX_HTTP_STATUS, INBOX_SETUP_STEPS, InboxError } from '../../core/inbox/errors'
import {
  actorFromSession,
  getThread,
  INBOX_ACTIONS,
  INBOX_BOXES,
  type InboxActor,
  type InboxBox,
  type InboxStore,
  inboxSession,
  inboxSummary,
  listMembers,
  listThreads,
  markRead,
  replyThread,
  type StatusFilter,
  sendThread,
  transitionThread,
} from '../../core/inbox/threads'
import { INBOX_KINDS, INBOX_STATUSES } from '../../core/types'
import { SESSION_COOKIE } from '../access'
import { enumQuery, intQuery, readJson, strQuery } from '../http'
import type { StoreProvider } from '../stores'

const sendBody = z.object({
  to: z.string().min(1),
  body: z.string().min(1),
  title: z.string().optional(),
  kind: z.enum(INBOX_KINDS).optional(),
  urgent: z.boolean().optional(),
  refs: z.array(z.string()).optional(),
})

const replyBody = z.object({
  body: z.string().min(1),
  after: z.enum(['claim', 'resolve']).optional(),
})

const actionBody = z.object({
  action: z.enum([...INBOX_ACTIONS, 'mark_read'] as unknown as [string, ...string[]]),
  note: z.string().optional(),
  to: z.string().optional(),
  force: z.boolean().optional(),
})

const STATUS_FILTERS = ['active', 'closed', 'any', ...INBOX_STATUSES] as const

/**
 * A stable, non-secret id for this browser session (claims; what a waiter treats
 * as "me"). Derived from the session cookie by hashing — the cookie itself is a
 * bearer secret and must never be written to the database.
 */
function studioSessionId(c: HonoContext): string {
  const sid = getCookie(c, SESSION_COOKIE)
  return sid
    ? `studio-${createHash('sha256').update(sid).digest('hex').slice(0, 12)}`
    : 'studio-local'
}

/**
 * The member inbox for Studio. Every route runs as the signed-in member (the
 * accessGuard already put their session in scope) against the shared primary.
 * Humans act here, so messages are stamped `surface: studio`, never as an agent.
 */
export function inboxRoutes(provider: StoreProvider): Hono {
  const app = new Hono()

  app.onError((err, c) => {
    if (err instanceof InboxError) {
      return c.json({ error: err.message, code: err.code }, INBOX_HTTP_STATUS[err.code])
    }
    if (err instanceof AccessDeniedError) return c.json({ error: err.message, code: err.code }, 403)
    throw err
  })

  const ctx = async (c: HonoContext): Promise<{ store: InboxStore; actor: InboxActor }> => {
    const session = currentSession()
    if (!session) {
      // No session in scope = access control is off (the guard 401s an unknown caller).
      inboxSession({ enabled: false })
    }
    const store = await provider.inbox()
    const actor = actorFromSession(session as NonNullable<typeof session>, {
      surface: 'studio',
      session: studioSessionId(c),
      agentSource: 'studio',
      byAgent: false,
    })
    return { store, actor }
  }

  // Never throws: tells the UI whether to show the inbox or the setup steps.
  app.get('/status', async (c) => {
    const accessOn = await isAccessEnabled(provider.db())
    let reason: string | null = null
    if (!accessOn) reason = 'access_off'
    else if (!currentSession()) reason = 'unauthenticated'
    else {
      try {
        await provider.inbox()
      } catch (e) {
        if (!(e instanceof InboxError)) throw e
        reason = 'local_project'
      }
    }
    return c.json({ available: reason === null, reason, steps: reason ? INBOX_SETUP_STEPS : null })
  })

  app.get('/summary', async (c) => {
    const { store, actor } = await ctx(c)
    return c.json(await inboxSummary(store, actor))
  })

  app.get('/members', async (c) => {
    const { store } = await ctx(c)
    return c.json(await listMembers(store.db))
  })

  app.get('/threads', async (c) => {
    const { store, actor } = await ctx(c)
    return c.json(
      await listThreads(store, actor, {
        box: enumQuery(c, 'box', INBOX_BOXES) as InboxBox | undefined,
        status: enumQuery(c, 'status', STATUS_FILTERS) as StatusFilter | undefined,
        kind: enumQuery(c, 'kind', INBOX_KINDS),
        from: strQuery(c, 'from'),
        limit: intQuery(c, 'limit'),
      }),
    )
  })

  app.get('/threads/:ref', async (c) => {
    const { store, actor } = await ctx(c)
    const since = Number(c.req.query('since') ?? 0)
    return c.json(
      await getThread(store, actor, c.req.param('ref'), {
        since: Number.isInteger(since) && since > 0 ? since : undefined,
        markRead: c.req.query('markRead') !== '0',
      }),
    )
  })

  app.post('/threads', async (c) => {
    const parsed = await readJson(c, sendBody)
    if (!parsed.ok) return parsed.res
    const { store, actor } = await ctx(c)
    return c.json(await sendThread(store, actor, parsed.data), 201)
  })

  app.post('/threads/:ref/reply', async (c) => {
    const parsed = await readJson(c, replyBody)
    if (!parsed.ok) return parsed.res
    const { store, actor } = await ctx(c)
    return c.json(
      await replyThread(store, actor, c.req.param('ref'), parsed.data.body, {
        after: parsed.data.after,
      }),
    )
  })

  app.post('/threads/:ref/action', async (c) => {
    const parsed = await readJson(c, actionBody)
    if (!parsed.ok) return parsed.res
    const { store, actor } = await ctx(c)
    const { action, note, to, force } = parsed.data
    const ref = c.req.param('ref')
    if (action === 'mark_read') return c.json({ marked: await markRead(store, actor, ref) })
    return c.json(
      await transitionThread(store, actor, ref, action as (typeof INBOX_ACTIONS)[number], {
        note,
        to,
        force,
      }),
    )
  })

  return app
}
