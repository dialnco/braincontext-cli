import { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { z } from 'zod'
import { describeFailure } from '../../core/access/session'
import { isAccessEnabled } from '../../core/access/settings'
import { toIdentity } from '../../core/access/status'
import { keyForRequest, SESSION_COOKIE, type StudioSessions } from '../access'
import { readJson } from '../http'
import type { StoreProvider } from '../stores'

const loginBody = z.object({ key: z.string().min(1) })

/**
 * Deliberate delay on a failed login. The key space is 192 bits, so this is not
 * what makes guessing infeasible — it just stops a scripted client from turning
 * the endpoint into a fast oracle.
 */
const FAILED_LOGIN_DELAY_MS = 400

/**
 * Login/logout/identity. Ungated (see capabilityFor) — these are how a caller
 * ACQUIRES an identity, so requiring one would be circular.
 */
export function authRoutes(
  provider: StoreProvider,
  sessions: StudioSessions,
  opts: { localKey?: string | null } = {},
): Hono {
  const app = new Hono()

  app.get('/auth/me', async (c) => {
    const db = provider.db()
    if (!(await isAccessEnabled(db))) {
      return c.json({ enabled: false, authenticated: false, identity: null })
    }
    const cookie = getCookie(c, SESSION_COOKIE)
    const key = keyForRequest(sessions, cookie, opts.localKey)
    const result = await sessions.resolve(db, key)
    if (!result.enabled || !result.ok) {
      return c.json({
        enabled: true,
        authenticated: false,
        identity: null,
        reason: result.enabled ? result.reason : null,
        message: result.enabled ? describeFailure(result.reason) : null,
      })
    }
    return c.json({
      enabled: true,
      authenticated: true,
      identity: toIdentity(result.session),
      // True when the identity came from this machine's stored key rather than a
      // browser login, so the UI can offer "sign in as someone else".
      adopted: !cookie,
    })
  })

  app.post('/auth/login', async (c) => {
    const parsed = await readJson(c, loginBody)
    if (!parsed.ok) return parsed.res

    const db = provider.db()
    if (!(await isAccessEnabled(db))) {
      return c.json({ error: 'access control is not enabled on this project' }, 400)
    }
    const result = await sessions.resolve(db, parsed.data.key)
    if (!result.enabled || !result.ok) {
      await new Promise((r) => setTimeout(r, FAILED_LOGIN_DELAY_MS))
      return c.json(
        {
          error: result.enabled ? describeFailure(result.reason) : 'access control is not enabled',
          reason: result.enabled ? result.reason : null,
        },
        401,
      )
    }

    const sid = sessions.login(parsed.data.key)
    setCookie(c, SESSION_COOKIE, sid, {
      httpOnly: true,
      sameSite: 'Strict',
      path: '/',
      // No `secure`: Studio is http on 127.0.0.1, where a Secure cookie is dropped.
    })
    return c.json({ enabled: true, authenticated: true, identity: toIdentity(result.session) })
  })

  app.post('/auth/logout', (c) => {
    const sid = getCookie(c, SESSION_COOKIE)
    if (sid) sessions.logout(sid)
    deleteCookie(c, SESSION_COOKIE, { path: '/' })
    return c.json({ ok: true })
  })

  return app
}
