import type { Kysely } from 'kysely'
import { getConfigValue, setConfigValue } from '../storeConfig'
import type { Database } from '../types'

/**
 * Access-control settings live in `store_config` (the `access.*` namespace) so they
 * travel with the project to every replica, exactly like `storage.*`.
 *
 * They are deliberately NOT in `STORAGE_CONFIG_KEYS`, so `bctx config set` cannot
 * reach them: turning enforcement off is a privileged operation that goes through
 * `bctx access disable` and its owner check.
 */
export const ACCESS_ENABLED_KEY = 'access.enabled'
export const ACCESS_MODE_KEY = 'access.mode'
export const ACCESS_LOG_READS_KEY = 'access.logReads'

/**
 * How the project expects its permissions to be enforced. Only `advisory` is
 * implemented; the key exists so a store written today is readable by the
 * hard-enforcement modes without another migration.
 *  - `advisory` — enforced by the bctx CLI/Studio/MCP surfaces only.
 *  - `token`    — plus per-user libSQL tokens (read-only tokens for readers).
 *  - `relay`    — writes must go through a server that holds the real credentials.
 */
export const ACCESS_MODES = ['advisory', 'token', 'relay'] as const
export type AccessMode = (typeof ACCESS_MODES)[number]

export async function isAccessEnabled(db: Kysely<Database>): Promise<boolean> {
  return (await getConfigValue(db, ACCESS_ENABLED_KEY)) === '1'
}

export async function setAccessEnabled(db: Kysely<Database>, enabled: boolean): Promise<void> {
  await setConfigValue(db, ACCESS_ENABLED_KEY, enabled ? '1' : null)
}

export async function getAccessMode(db: Kysely<Database>): Promise<AccessMode> {
  const raw = await getConfigValue(db, ACCESS_MODE_KEY)
  return (ACCESS_MODES as readonly string[]).includes(raw ?? '') ? (raw as AccessMode) : 'advisory'
}

export async function setAccessMode(db: Kysely<Database>, mode: AccessMode): Promise<void> {
  await setConfigValue(db, ACCESS_MODE_KEY, mode)
}

/**
 * Whether allowed READS are written to the access log. Off by default: on a busy
 * store the log would be dominated by routine reads, and every entry is a write to
 * the remote primary. Denials and allowed writes are always logged.
 */
export async function logReadsEnabled(db: Kysely<Database>): Promise<boolean> {
  return (await getConfigValue(db, ACCESS_LOG_READS_KEY)) === '1'
}

export async function setLogReads(db: Kysely<Database>, on: boolean): Promise<void> {
  await setConfigValue(db, ACCESS_LOG_READS_KEY, on ? '1' : null)
}
