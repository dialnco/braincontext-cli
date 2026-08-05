import { createHash } from 'node:crypto'
import { AccessError } from './errors'
import { parseKey } from './keys'

/** Marker segment, so a pasted code is self-identifying. */
export const JOIN_SCHEME = 'bctxj'

/**
 * Everything a new member needs, in one paste.
 *
 * SECURITY: in `advisory` mode `t` is the project's SHARED libSQL token — whoever
 * holds this code can reach the database directly, with any SQLite client, and is
 * bound by these permissions only for as long as they choose to use bctx. Every
 * command that prints a join code must say so. The field is reserved for the
 * per-user token that `token` mode will mint, which is what makes that upgrade a
 * value change rather than a format change.
 */
export interface JoinPayload {
  v: 1
  /** Project name to register locally. */
  n: string
  /** Remote primary URL. Absent for a local-only project. */
  u?: string
  /** libSQL auth token for `u`. */
  t?: string
  /** The member's bctx access key. */
  k: string
  /** The member's handle. Display only — the key is what establishes identity. */
  h?: string
}

function checksum(body: string): string {
  return createHash('sha256').update(body).digest('base64url').slice(0, 8)
}

export function encodeJoinCode(payload: JoinPayload): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return `${JOIN_SCHEME}.${body}.${checksum(body)}`
}

/**
 * Parse and validate a join code. The trailing checksum exists to turn the most
 * common failure — a code truncated by a chat client or a line wrap — into a
 * precise message instead of a JSON parse error.
 */
export function decodeJoinCode(code: string): JoinPayload {
  const bad = (msg: string): never => {
    throw new AccessError(msg, 'invalid_join_code')
  }
  const parts = code.trim().split('.')
  if (parts.length !== 3 || parts[0] !== JOIN_SCHEME) {
    return bad('Not a join code (expected `bctxj.<payload>.<checksum>`).')
  }
  const [, body, sum] = parts as [string, string, string]
  if (checksum(body) !== sum) {
    return bad('Join code is truncated or corrupted — copy the whole line and try again.')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return bad('Join code payload is unreadable.')
  }
  if (!parsed || typeof parsed !== 'object') return bad('Join code payload is unreadable.')

  const p = parsed as Partial<JoinPayload>
  if (p.v !== 1) return bad(`Unsupported join code version: ${String(p.v)}. Upgrade bctx.`)
  if (typeof p.n !== 'string' || !p.n) return bad('Join code has no project name.')
  if (typeof p.k !== 'string' || !parseKey(p.k)) return bad('Join code has no valid access key.')
  if (p.u !== undefined && typeof p.u !== 'string') return bad('Join code has an invalid sync URL.')
  if (p.t !== undefined && typeof p.t !== 'string') return bad('Join code has an invalid token.')

  return {
    v: 1,
    n: p.n,
    u: p.u,
    t: p.t,
    k: p.k,
    h: typeof p.h === 'string' ? p.h : undefined,
  }
}

/** Shown when the code carries the shared database token — the honest disclosure. */
export const JOIN_CODE_WARNING =
  "This code contains the project's database token. Anyone who has it can read and\n" +
  'write the remote database directly, bypassing bctx permissions. Send it over a\n' +
  'private channel and treat it like a password.'

/** Shown for a local project, whose code carries a key but no way to reach a database. */
export const LOCAL_JOIN_CODE_NOTE =
  'This project has no remote, so the code carries only the access key — it works\n' +
  'for someone who already has a copy of this store. Treat it like a password.'

/**
 * The disclosure that belongs with a given code. Which one applies depends on
 * whether a database token is actually embedded, so no surface has to guess (and
 * none can warn about a token that is not there).
 */
export function joinCodeWarning(payload: JoinPayload): string {
  return payload.t ? JOIN_CODE_WARNING : LOCAL_JOIN_CODE_NOTE
}
