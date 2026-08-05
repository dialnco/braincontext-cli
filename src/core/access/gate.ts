import type { Kysely } from 'kysely'
import { resolveAgent } from '../../lib/agent'
import type { Database } from '../types'
import { logAccess, type Surface } from './audit'
import type { Capability } from './capabilities'
import type { CommandCapability } from './commands'
import { readOnlyPlugin } from './readonly'
import {
  type AccessSession,
  requireCapability,
  resolveSession,
  type SessionResult,
} from './session'
import { logReadsEnabled } from './settings'

/** Capabilities whose ALLOW decisions are always logged (see logReadsEnabled). */
const ALWAYS_LOGGED: ReadonlySet<Capability> = new Set<Capability>([
  'write',
  'delete',
  'files.write',
  'config.write',
  'users.manage',
  'project.manage',
])

export interface GateOptions {
  /** The presented access key, if any. */
  key?: string | null
  /** Capability to enforce; `null` runs the operation ungated. */
  requires?: CommandCapability
  /** What was attempted, for the audit log (a command path or a route). */
  action: string
  surface: Surface
  targetType?: string | null
  targetId?: string | null
}

export interface Gate {
  /**
   * The handle to hand downstream. Identical to the input unless the caller
   * authenticated as a read-only principal, in which case it carries the
   * write-rejecting plugin.
   */
  db: Kysely<Database>
  /** The authenticated session, or null (access off, or no valid key). */
  session: AccessSession | null
  result: SessionResult
}

/**
 * Enforce one capability against an already-resolved session, and record the
 * decision. The single place all three surfaces (CLI, Studio, MCP) agree on what a
 * permission check means.
 *
 * Throws {@link AccessDeniedError} when the capability is missing — after writing
 * the deny to the access log, so a refused attempt is never invisible.
 *
 * Takes a resolved `SessionResult` rather than a key because the long-lived
 * surfaces authenticate once and check many times: re-verifying a key costs an
 * scrypt hash, which is right per CLI invocation and wrong per MCP tool call.
 */
export async function authorize(
  db: Kysely<Database>,
  result: SessionResult,
  opts: Omit<GateOptions, 'key'>,
): Promise<void> {
  // Access control is off: no checks, no log rows. This is the
  // backwards-compatibility contract for every project that never opts in.
  if (!result.enabled) return
  const capability = opts.requires
  if (!capability) return

  const session = result.ok ? result.session : null
  const base = {
    principalId: session?.principal.id ?? null,
    handle: session?.principal.handle ?? null,
    agentSource: resolveAgent(),
    surface: opts.surface,
    action: opts.action,
    targetType: opts.targetType ?? null,
    targetId: opts.targetId ?? null,
  }
  try {
    requireCapability(result, capability)
  } catch (err) {
    await logAccess(db, {
      ...base,
      decision: 'deny',
      detail: { capability, reason: result.ok ? 'missing_capability' : result.reason },
    })
    throw err
  }
  if (ALWAYS_LOGGED.has(capability) || (await logReadsEnabled(db))) {
    await logAccess(db, { ...base, decision: 'allow', detail: { capability } })
  }
}

/** One read-only wrapper per underlying handle — `db()` is called per request. */
const readOnlyHandles = new WeakMap<Kysely<Database>, Kysely<Database>>()

/**
 * Wrap a handle so an authenticated read-only principal physically cannot write.
 *
 * Only an AUTHENTICATED read-only principal gets it. An unauthenticated caller is
 * already blocked by the capability check; wrapping it too would break
 * `bctx access recover`, whose whole purpose is to write to a store it cannot
 * authenticate against.
 */
export function restrictForSession(
  db: Kysely<Database>,
  session: AccessSession | null | undefined,
): Kysely<Database> {
  if (!session?.readOnly) return db
  const cached = readOnlyHandles.get(db)
  if (cached) return cached
  const wrapped = db.withPlugin(readOnlyPlugin)
  readOnlyHandles.set(db, wrapped)
  return wrapped
}

/** Authenticate with a key, enforce a capability, and return a suitable handle. */
export async function enterGate(db: Kysely<Database>, opts: GateOptions): Promise<Gate> {
  const result = await resolveSession(db, opts.key)
  await authorize(db, result, opts)
  const session = result.enabled && result.ok ? result.session : null
  return { db: restrictForSession(db, session), session, result }
}
