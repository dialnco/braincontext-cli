import type { Kysely } from 'kysely'
import type { Database } from '../types'
import type { Capability } from './capabilities'
import type { AccessSession } from './session'
import { type AccessMode, getAccessMode, isAccessEnabled, logReadsEnabled } from './settings'

/** The caller's own identity, safe to serve anywhere. */
export interface Identity {
  handle: string
  displayName: string | null
  role: string
  capabilities: Capability[]
  readOnly: boolean
}

/**
 * Safe-to-serve view of the access layer — the analogue of `storageStatus()` for
 * `storage.*`. Contains no key material of any kind: secrets are write-only, and
 * even a key's public prefix is only exposed through the explicit key listings
 * that `users.manage` gates.
 */
export interface AccessStatus {
  enabled: boolean
  mode: AccessMode
  logReads: boolean
  userCount: number
  activeKeyCount: number
  /** Null when access control is off, or when the caller is unauthenticated. */
  me: Identity | null
}

export function toIdentity(session: AccessSession): Identity {
  return {
    handle: session.principal.handle,
    displayName: session.principal.displayName,
    role: session.principal.role,
    capabilities: session.principal.capabilities,
    readOnly: session.readOnly,
  }
}

export async function accessStatus(
  db: Kysely<Database>,
  session?: AccessSession | null,
): Promise<AccessStatus> {
  const enabled = await isAccessEnabled(db)
  const [users, keys] = await Promise.all([
    db.selectFrom('principals').select('id').execute(),
    db.selectFrom('principal_keys').select(['revoked_at', 'expires_at']).execute(),
  ])
  const now = Date.now()
  return {
    enabled,
    mode: await getAccessMode(db),
    logReads: await logReadsEnabled(db),
    userCount: users.length,
    activeKeyCount: keys.filter(
      (k) => !k.revoked_at && !(k.expires_at && Date.parse(k.expires_at) <= now),
    ).length,
    me: session ? toIdentity(session) : null,
  }
}
