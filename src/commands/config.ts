import { Command } from 'commander'
import { withDb } from '../core/db'
import {
  getConfigPrefix,
  maskKey,
  STORAGE_CONFIG_KEYS,
  type StorageConfigKey,
  setConfigValue,
} from '../core/storeConfig'
import { dbOptsFrom } from './_shared'

/** Keys whose values must never be printed in full. */
const SENSITIVE = new Set<StorageConfigKey>(['storage.accessKeyId', 'storage.secretAccessKey'])

function requireKnownKey(key: string): StorageConfigKey {
  if (!(STORAGE_CONFIG_KEYS as readonly string[]).includes(key)) {
    throw new Error(
      `Unknown config key: "${key}". Valid keys:\n  ${STORAGE_CONFIG_KEYS.join('\n  ')}`,
    )
  }
  return key as StorageConfigKey
}

function display(key: string, value: string): string {
  if (key === 'storage.secretAccessKey') return '(set)'
  if (SENSITIVE.has(key as StorageConfigKey)) return maskKey(value)
  return value
}

/**
 * Per-store config stored IN the project DB (table `store_config`), so it travels
 * with the store — including to replica/remote (Turso) clients. Currently scoped to
 * the `storage.*` namespace (S3/R2 file storage for `bctx file` and the studio wiki).
 */
export function configCommand(): Command {
  const config = new Command('config').description(
    'Per-store configuration, kept in the project DB so every client sees it.\n' +
      `Keys: ${STORAGE_CONFIG_KEYS.join(', ')}`,
  )

  config
    .command('set <key> <value>')
    .description(
      'Set a config key (e.g. storage.endpoint https://<account>.r2.cloudflarestorage.com).',
    )
    .action(async (key: string, value: string, _opts, command: Command) => {
      const k = requireKnownKey(key)
      await withDb(dbOptsFrom(command), (db) => setConfigValue(db, k, value))
      console.log(`${k} = ${display(k, value)}`)
    })

  config
    .command('get [key]')
    .description('Show one config key, or all storage config (secrets masked).')
    .action(async (key: string | undefined, _opts, command: Command) => {
      const kv = await withDb(dbOptsFrom(command), (db) => getConfigPrefix(db, 'storage.'))
      if (key) {
        const k = requireKnownKey(key)
        const v = kv[k]
        console.log(v === undefined ? `${k} is not set` : `${k} = ${display(k, v)}`)
        return
      }
      if (Object.keys(kv).length === 0) {
        console.log('No storage config set. Start with:\n  bctx config set storage.endpoint <url>')
        return
      }
      for (const k of STORAGE_CONFIG_KEYS) {
        const v = kv[k]
        if (v !== undefined) console.log(`${k} = ${display(k, v)}`)
      }
    })

  config
    .command('unset <key>')
    .description('Remove a config key.')
    .action(async (key: string, _opts, command: Command) => {
      const k = requireKnownKey(key)
      await withDb(dbOptsFrom(command), (db) => setConfigValue(db, k, null))
      console.log(`${k} unset`)
    })

  return config
}
