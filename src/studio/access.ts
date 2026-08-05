import { randomBytes } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'
import type { Kysely } from 'kysely'
import { createSessionResolver, type SessionResolver } from '../core/access/cache'
import type { Capability } from '../core/access/capabilities'
import { AccessDeniedError } from '../core/access/errors'
import { authorize } from '../core/access/gate'
import { runWithSession, type SessionResult } from '../core/access/session'
import type { Database } from '../core/types'
import type { StoreProvider } from './stores'

export const SESSION_COOKIE = 'bctx_sid'

/**
 * Which capability an API request needs.
 *
 * Rule-based rather than a route table: Studio's routes are conventional (GET
 * reads, other verbs write), so a table would be 60 lines that drift the moment a
 * route is added. The tail default is the safe one — an unrecognized path is
 * treated as ordinary store data.
 */
export function capabilityFor(method: string, path: string): Capability | null {
  const p = path.replace(/^\/api/, '') || '/'
  const mutating = method !== 'GET' && method !== 'HEAD'

  // Ungated: liveness, the login endpoints themselves, and local registry
  // navigation (the CLI's `project use`/`project list` are ungated for the same
  // reason — they select WHICH store to open, and that store enforces its own rules).
  if (p === '/health') return null
  if (p === '/auth' || p.startsWith('/auth/')) return null
  if (p === '/projects' || p === '/project' || p === '/project/switch') return null

  if (p === '/project/sync' || p === '/version') return 'read'
  if (p === '/access' || p.startsWith('/access/')) return 'users.manage'

  if (p === '/files/status') return 'config.read'
  if (p === '/files/config') return mutating ? 'config.write' : 'config.read'
  if (p === '/files/config/test') return 'files.write'
  if (p === '/files' || p.startsWith('/files/')) return mutating ? 'files.write' : 'files.read'

  if (method === 'DELETE') return 'delete'
  return mutating ? 'write' : 'read'
}

/**
 * Browser sessions for Studio. In-process and non-persistent: the server is a
 * single short-lived local process, so a restart logging everyone out is correct
 * behavior, not a limitation.
 *
 * Session resolution is cached per (store handle, key). Keying on the handle means
 * switching projects at runtime re-verifies against the new store automatically —
 * a key issued by project A must not silently authenticate against project B.
 */
export interface StudioSessions {
  login(key: string): string
  logout(sid: string): void
  keyFor(sid: string | undefined): string | undefined
  resolve(db: Kysely<Database>, key: string | null | undefined): Promise<SessionResult>
}

export function createStudioSessions(): StudioSessions {
  const keysBySid = new Map<string, string>()
  const resolvers = new WeakMap<Kysely<Database>, Map<string, SessionResolver>>()

  return {
    login(key) {
      const sid = randomBytes(24).toString('base64url')
      keysBySid.set(sid, key)
      return sid
    },
    logout(sid) {
      keysBySid.delete(sid)
    },
    keyFor(sid) {
      return sid ? keysBySid.get(sid) : undefined
    },
    resolve(db, key) {
      let perDb = resolvers.get(db)
      if (!perDb) {
        perDb = new Map()
        resolvers.set(db, perDb)
      }
      const cacheKey = key ?? ''
      let resolver = perDb.get(cacheKey)
      if (!resolver) {
        resolver = createSessionResolver(db, key)
        perDb.set(cacheKey, resolver)
      }
      return resolver()
    },
  }
}

export interface AccessGuardOptions {
  provider: StoreProvider
  sessions: StudioSessions
  /**
   * The key this machine already holds for the served project, adopted when a
   * request carries no session cookie. It is why the admin who ran `bctx studio`
   * never sees a login screen: they are already authenticated at the CLI level,
   * and the browser is just another view of that same identity.
   */
  localKey?: string | null
}

/** The key a request presents: its session cookie, else the local machine's key. */
export function keyForRequest(
  sessions: StudioSessions,
  cookie: string | undefined,
  localKey: string | null | undefined,
): string | null {
  return sessions.keyFor(cookie) ?? localKey ?? null
}

/**
 * Enforce access control on `/api/*`. Mounted directly after `localOnlyGuard`, so
 * a request has already passed the DNS-rebinding and CSRF checks by the time
 * identity is considered.
 *
 * Handlers run inside `runWithSession`, which is what lets `provider.db()` hand
 * back a write-rejecting handle to a reader and lets core/ stamp `principal_id`.
 */
export function accessGuard(opts: AccessGuardOptions): MiddlewareHandler {
  return async (c, next) => {
    if (!c.req.path.startsWith('/api')) return next()

    const key = keyForRequest(opts.sessions, getCookie(c, SESSION_COOKIE), opts.localKey)
    // The RAW handle: audit rows must be writable even for a read-only principal.
    const db = opts.provider.db()
    const result = await opts.sessions.resolve(db, key)
    if (!result.enabled) return next()

    const capability = capabilityFor(c.req.method, c.req.path)
    if (capability) {
      try {
        await authorize(db, result, {
          requires: capability,
          action: `${c.req.method} ${c.req.path}`,
          surface: 'studio',
        })
      } catch (err) {
        if (err instanceof AccessDeniedError) {
          return c.json(
            { error: err.message, code: err.code, capability },
            err.unauthenticated ? 401 : 403,
          )
        }
        throw err
      }
    }
    return runWithSession(result.ok ? result.session : null, () => next())
  }
}
