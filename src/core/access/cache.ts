import type { Kysely } from 'kysely'
import type { Database } from '../types'
import { resolveSession, type SessionResult } from './session'

/**
 * How long a resolved session is trusted before the key is re-verified.
 *
 * This is the revocation window for long-lived surfaces (the MCP server, a Studio
 * login). Verifying costs an scrypt hash — right once per CLI invocation, wrong on
 * every MCP tool call — so the choice is between per-call latency and how quickly
 * a revoked key stops working. A minute is well inside the time it takes a replica
 * to even learn about the revocation from its primary.
 */
export const SESSION_TTL_MS = 60_000

export type SessionResolver = (() => Promise<SessionResult>) & { invalidate: () => void }

/**
 * A memoizing session resolver for a fixed key. Concurrent callers during a
 * refresh share the one in-flight verification rather than each starting their own.
 */
export function createSessionResolver(
  db: Kysely<Database>,
  key: string | null | undefined,
  ttlMs = SESSION_TTL_MS,
  now: () => number = Date.now,
): SessionResolver {
  let cached: SessionResult | null = null
  let cachedAt = 0
  let inFlight: Promise<SessionResult> | null = null

  const resolver = (async (): Promise<SessionResult> => {
    if (cached && now() - cachedAt < ttlMs) return cached
    if (inFlight) return inFlight
    inFlight = resolveSession(db, key)
      .then((result) => {
        cached = result
        cachedAt = now()
        return result
      })
      .finally(() => {
        inFlight = null
      })
    return inFlight
  }) as SessionResolver

  /** Force the next call to re-verify (used after a key or role change). */
  resolver.invalidate = () => {
    cached = null
    cachedAt = 0
  }
  return resolver
}
