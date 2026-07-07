import { describe, expect, it } from 'vitest'
import {
  getConfigPrefix,
  getConfigValue,
  getStorageConfig,
  maskKey,
  setConfigValue,
  setStorageConfig,
  storageStatus,
} from '../src/core/storeConfig'
import { freshDb } from './_db'

describe('store_config key-value', () => {
  it('sets, gets, overwrites and unsets values', async () => {
    const db = await freshDb()
    expect(await getConfigValue(db, 'storage.bucket')).toBeNull()
    await setConfigValue(db, 'storage.bucket', 'notes')
    expect(await getConfigValue(db, 'storage.bucket')).toBe('notes')
    await setConfigValue(db, 'storage.bucket', 'notes2')
    expect(await getConfigValue(db, 'storage.bucket')).toBe('notes2')
    await setConfigValue(db, 'storage.bucket', null)
    expect(await getConfigValue(db, 'storage.bucket')).toBeNull()
  })

  it('lists keys by prefix', async () => {
    const db = await freshDb()
    await setConfigValue(db, 'storage.bucket', 'b')
    await setConfigValue(db, 'storage.endpoint', 'e')
    await setConfigValue(db, 'other.key', 'x')
    const kv = await getConfigPrefix(db, 'storage.')
    expect(kv).toEqual({ 'storage.bucket': 'b', 'storage.endpoint': 'e' })
  })
})

describe('storage config', () => {
  const full = {
    endpoint: 'https://acc.r2.cloudflarestorage.com',
    bucket: 'notes',
    accessKeyId: 'AKIA1234EXAMPLE99',
    secretAccessKey: 'shh-secret',
  }

  it('is null until every required key is present', async () => {
    const db = await freshDb()
    expect(await getStorageConfig(db)).toBeNull()
    await setStorageConfig(db, { endpoint: full.endpoint, bucket: full.bucket })
    expect(await getStorageConfig(db)).toBeNull()
    await setStorageConfig(db, {
      accessKeyId: full.accessKeyId,
      secretAccessKey: full.secretAccessKey,
    })
    const cfg = await getStorageConfig(db)
    expect(cfg).not.toBeNull()
    expect(cfg?.region).toBe('auto') // default when unset
    expect(cfg?.secretAccessKey).toBe('shh-secret')
  })

  it('merges patches: omitted keys untouched, empty string deletes', async () => {
    const db = await freshDb()
    await setStorageConfig(db, full)
    // Editing without the secret keeps the stored one (write-only form flow).
    await setStorageConfig(db, { bucket: 'other' })
    const cfg = await getStorageConfig(db)
    expect(cfg?.bucket).toBe('other')
    expect(cfg?.secretAccessKey).toBe('shh-secret')
    // Empty string deletes → config becomes incomplete.
    await setStorageConfig(db, { secretAccessKey: '' })
    expect(await getStorageConfig(db)).toBeNull()
  })

  it('storageStatus never exposes the secret and masks the key id', async () => {
    const db = await freshDb()
    expect((await storageStatus(db)).configured).toBe(false)
    await setStorageConfig(db, full)
    const status = await storageStatus(db)
    expect(status.configured).toBe(true)
    expect(status.bucket).toBe('notes')
    expect(JSON.stringify(status)).not.toContain('shh-secret')
    expect(status.accessKeyIdMasked).toBe('AKIA…LE99')
  })

  it('maskKey never leaks short keys', () => {
    expect(maskKey('abc')).toBe('****')
    expect(maskKey('12345678')).toBe('****')
    expect(maskKey('AKIA1234EXAMPLE99')).toBe('AKIA…LE99')
  })
})
