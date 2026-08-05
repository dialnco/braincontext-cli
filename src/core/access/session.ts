import { AsyncLocalStorage } from 'node:async_hooks'
import type { Kysely } from 'kysely'
import type { Database } from '../types'
import type { Capability } from './capabilities'
import { resolveCapabilities } from './capabilities'
import { AccessDeniedError } from './errors'
import type { KeyFailure } from './keys'
import { verifyKey } from './keys'
import { type Principal, toPrincipal } from './principals'
import { isAccessEnabled } from './settings'

/** Capabilities that mutate something. A session holding none of these is read-only. */
const WRITE_CAPABILITIES: Capability[] = [
  'write',
  'delete',
  'files.write',
  'config.write',
  'users.manage',
  'project.manage',
]

export interface AccessSession {
  principal: Principal
  capabilities: Set<Capability>
  /** Id of the key that authenticated this session, for the audit log. */
  keyId: string
  /** True when the session holds no mutating capability at all. */
  readOnly: boolean
  can(cap: Capability): boolean
}

/** Why no session could be established. `missing` = the client presented no key. */
export type SessionFailure = KeyFailure | 'missing'

export type SessionResult =
  /** The project has access control switched off — every surface behaves as before. */
  | { enabled: false }
  | { enabled: true; ok: true; session: AccessSession }
  | { enabled: true; ok: false; reason: SessionFailure }

function buildSession(principal: Principal, keyId: string): AccessSession {
  const capabilities = resolveCapabilities(principal.role, principal.overrides)
  return {
    principal,
    capabilities,
    keyId,
    readOnly: !WRITE_CAPABILITIES.some((c) => capabilities.has(c)),
    can: (cap) => capabilities.has(cap),
  }
}

/**
 * Resolve who the caller is on this store.
 *
 * The `isAccessEnabled` short-circuit is what keeps this feature invisible to
 * every existing project: one indexed `store_config` read, then straight back out.
 * Only a store that ran `bctx access init` pays for key verification.
 */
export async function resolveSession(
  db: Kysely<Database>,
  key: string | null | undefined,
): Promise<SessionResult> {
  if (!(await isAccessEnabled(db))) return { enabled: false }
  if (!key?.trim()) return { enabled: true, ok: false, reason: 'missing' }

  const verified = await verifyKey(db, key.trim())
  if (!verified.ok) return { enabled: true, ok: false, reason: verified.reason }
  return {
    enabled: true,
    ok: true,
    session: buildSession(toPrincipal(verified.principal), verified.key.id),
  }
}

/** A user-facing explanation of a failed authentication, with the way out. */
export function describeFailure(reason: SessionFailure): string {
  switch (reason) {
    case 'missing':
      return 'This project requires an access key. Run `bctx project join <code>` with the code your project admin gave you.'
    case 'malformed':
      return 'Access key is malformed (expected `bctxk.<prefix>.<secret>`). Re-run `bctx project join <code>`.'
    case 'unknown':
      return 'Access key was not recognized. Ask your project admin for a new join code.'
    case 'revoked':
      return 'Your access key has been revoked. Ask your project admin for a new one.'
    case 'expired':
      return 'Your access key has expired. Ask your project admin for a new one.'
    case 'disabled':
      return 'Your account is disabled on this project. Ask your project admin to re-enable it.'
  }
}

/**
 * Enforce a capability, throwing {@link AccessDeniedError} if it is missing. A
 * disabled project (`enabled: false`) permits everything — that is the whole
 * backwards-compatibility contract.
 */
export function requireCapability(result: SessionResult, capability: Capability): void {
  if (!result.enabled) return
  if (!result.ok) {
    throw new AccessDeniedError(describeFailure(result.reason), {
      capability,
      unauthenticated: true,
    })
  }
  if (!result.session.can(capability)) {
    const { handle, role } = result.session.principal
    throw new AccessDeniedError(
      `Permission denied: "${handle}" (${role}) lacks the \`${capability}\` capability.`,
      { capability },
    )
  }
}

// ── Ambient session ────────────────────────────────────────────────────────────

/**
 * The session in scope for the current operation.
 *
 * This is `AsyncLocalStorage` rather than an explicit parameter because the only
 * consumer is attribution: `contexts.ts`, `wiki.ts`, and `files.ts` stamp
 * `principal_id` on the rows they write. Threading an actor argument through every
 * core function and its ~20 call sites would be a large, invasive change for one
 * nullable column, and every one of those call sites would be free to forget it.
 */
const storage = new AsyncLocalStorage<AccessSession>()

export function runWithSession<T>(session: AccessSession | null, fn: () => Promise<T>): Promise<T> {
  return session ? storage.run(session, fn) : fn()
}

export function currentSession(): AccessSession | undefined {
  return storage.getStore()
}

/** The authenticated author for a row being written, or null when unauthenticated. */
export function currentPrincipalId(): string | null {
  return storage.getStore()?.principal.id ?? null
}
