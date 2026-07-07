import type { Kysely } from 'kysely'
import type { Database } from './types'

/**
 * Per-store key-value settings, kept IN the store DB (not in ~/.braincontext) so any
 * client that opens this store — local file, embedded replica, or fully remote — sees
 * the same configuration. Keys are namespaced (`storage.*` for S3/R2 file storage).
 *
 * Note: values sync with the DB, so for replica/remote stores the storage credentials
 * reach the remote primary too. That is the point (config travels with the project),
 * but it means the R2 token should be bucket-scoped, not account-wide.
 */

export async function getConfigValue(db: Kysely<Database>, key: string): Promise<string | null> {
  const row = await db
    .selectFrom('store_config')
    .select('value')
    .where('key', '=', key)
    .executeTakeFirst()
  return row?.value ?? null
}

/** Set a config value; `null` deletes the key. */
export async function setConfigValue(
  db: Kysely<Database>,
  key: string,
  value: string | null,
): Promise<void> {
  if (value === null) {
    await db.deleteFrom('store_config').where('key', '=', key).execute()
    return
  }
  const updatedAt = new Date().toISOString()
  await db
    .insertInto('store_config')
    .values({ key, value, updated_at: updatedAt })
    .onConflict((oc) => oc.column('key').doUpdateSet({ value, updated_at: updatedAt }))
    .execute()
}

/** All keys under a prefix (e.g. `storage.`) as a plain record. */
export async function getConfigPrefix(
  db: Kysely<Database>,
  prefix: string,
): Promise<Record<string, string>> {
  const rows = await db
    .selectFrom('store_config')
    .select(['key', 'value'])
    .where('key', 'like', `${prefix}%`)
    .execute()
  return Object.fromEntries(rows.map((r) => [r.key, r.value]))
}

// ---------------------------------------------------------------------------
// S3/R2 file-storage config (the `storage.*` namespace)
// ---------------------------------------------------------------------------

export const STORAGE_CONFIG_KEYS = [
  'storage.endpoint',
  'storage.region',
  'storage.bucket',
  'storage.accessKeyId',
  'storage.secretAccessKey',
  'storage.prefix',
] as const
export type StorageConfigKey = (typeof STORAGE_CONFIG_KEYS)[number]

export interface StorageConfig {
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  prefix?: string
}

const REQUIRED: StorageConfigKey[] = [
  'storage.endpoint',
  'storage.bucket',
  'storage.accessKeyId',
  'storage.secretAccessKey',
]

/** The full storage config, or null unless every required key is set. */
export async function getStorageConfig(db: Kysely<Database>): Promise<StorageConfig | null> {
  const kv = await getConfigPrefix(db, 'storage.')
  const endpoint = kv['storage.endpoint']
  const bucket = kv['storage.bucket']
  const accessKeyId = kv['storage.accessKeyId']
  const secretAccessKey = kv['storage.secretAccessKey']
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null
  return {
    endpoint,
    region: kv['storage.region'] || 'auto',
    bucket,
    accessKeyId,
    secretAccessKey,
    prefix: kv['storage.prefix'] || undefined,
  }
}

/**
 * Merge a partial config: omitted keys are left untouched (so the settings form can
 * skip the secret when editing), empty-string values delete the key.
 */
export async function setStorageConfig(
  db: Kysely<Database>,
  patch: Partial<StorageConfig>,
): Promise<void> {
  const entries: Array<[StorageConfigKey, string | undefined]> = [
    ['storage.endpoint', patch.endpoint],
    ['storage.region', patch.region],
    ['storage.bucket', patch.bucket],
    ['storage.accessKeyId', patch.accessKeyId],
    ['storage.secretAccessKey', patch.secretAccessKey],
    ['storage.prefix', patch.prefix],
  ]
  for (const [key, value] of entries) {
    if (value === undefined) continue
    await setConfigValue(db, key, value === '' ? null : value)
  }
}

export interface StorageStatus {
  configured: boolean
  endpoint?: string
  region?: string
  bucket?: string
  prefix?: string
  /** First 4 + last 4 chars of the access key id; NEVER the secret. */
  accessKeyIdMasked?: string
}

export function maskKey(key: string): string {
  if (key.length <= 8) return '****'
  return `${key.slice(0, 4)}…${key.slice(-4)}`
}

/** Safe-to-serve view of the storage config: no secret, key id masked. */
export async function storageStatus(db: Kysely<Database>): Promise<StorageStatus> {
  const kv = await getConfigPrefix(db, 'storage.')
  const configured = REQUIRED.every((k) => Boolean(kv[k]))
  if (!configured && !kv['storage.endpoint'] && !kv['storage.bucket']) return { configured: false }
  return {
    configured,
    endpoint: kv['storage.endpoint'] || undefined,
    region: kv['storage.region'] || 'auto',
    bucket: kv['storage.bucket'] || undefined,
    prefix: kv['storage.prefix'] || undefined,
    accessKeyIdMasked: kv['storage.accessKeyId'] ? maskKey(kv['storage.accessKeyId']) : undefined,
  }
}
