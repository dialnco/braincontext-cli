import type { Kysely } from 'kysely'
import { describe, expect, it } from 'vitest'
import {
  deleteFile,
  fileReferences,
  fileRefIds,
  getFile,
  listFiles,
  mimeFor,
  objectKeyFor,
  presignFileUrl,
  StorageNotConfiguredError,
  sanitizeFilename,
  uploadFile,
} from '../src/core/files'
import type { ObjectStore, StoreFactory } from '../src/core/storage/s3'
import { setStorageConfig } from '../src/core/storeConfig'
import type { Database } from '../src/core/types'
import { createPage } from '../src/core/wiki'
import { freshDb } from './_db'

/** Map-backed ObjectStore so the core file flow runs without any network. */
function fakeStore() {
  const blobs = new Map<string, Uint8Array>()
  const store: ObjectStore = {
    async put(key, body) {
      blobs.set(key, body)
    },
    async delete(key) {
      blobs.delete(key)
    },
    async presignGet(key, opts) {
      return `https://fake.bucket.example/${key}?disp=${opts.disposition}&ttl=${opts.ttlSeconds}`
    },
    async test() {},
  }
  const factory: StoreFactory = async () => store
  return { blobs, factory }
}

async function configuredDb(): Promise<Kysely<Database>> {
  const db = await freshDb()
  await setStorageConfig(db, {
    endpoint: 'https://acc.r2.cloudflarestorage.com',
    bucket: 'notes',
    accessKeyId: 'AKIA1234EXAMPLE99',
    secretAccessKey: 'shh',
    prefix: 'bctx',
  })
  return db
}

describe('filename / key helpers', () => {
  it('sanitizes traversal, separators, unicode and empties', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd')
    expect(sanitizeFilename('a\\b\\c.png')).toBe('c.png')
    expect(sanitizeFilename('café photo (1).PNG')).toBe('caf-photo-1-.PNG')
    expect(sanitizeFilename('...')).toBe('file')
    expect(sanitizeFilename('')).toBe('file')
    const long = `${'x'.repeat(300)}.pdf`
    const out = sanitizeFilename(long)
    expect(out.length).toBeLessThanOrEqual(120)
    expect(out.endsWith('.pdf')).toBe(true)
  })

  it('builds prefixed object keys', () => {
    expect(objectKeyFor('bctx/', 'ID', 'a.png')).toBe('bctx/files/ID/a.png')
    expect(objectKeyFor(undefined, 'ID', 'a.png')).toBe('files/ID/a.png')
  })

  it('maps extensions to mime types with a safe fallback', () => {
    expect(mimeFor('x.png')).toBe('image/png')
    expect(mimeFor('x.PDF')).toBe('application/pdf')
    expect(mimeFor('x.weird')).toBe('application/octet-stream')
  })
})

describe('fileRefIds', () => {
  it('finds both syntaxes and dedups', () => {
    const id = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
    const body = `intro ![pic](bctx-file://${id})\n\n![[file:${id}|doc.pdf]]\n\n[[file:${id}|x]]`
    expect(fileRefIds(body)).toEqual([id])
  })

  it('ignores non-file refs and malformed ids', () => {
    expect(fileRefIds('![x](https://evil) [[Page]] ![[Table]] ![y](bctx-file://short)')).toEqual([])
  })
})

describe('uploadFile / listFiles / deleteFile / presignFileUrl', () => {
  it('requires storage config', async () => {
    const db = await freshDb()
    const { factory } = fakeStore()
    await expect(
      uploadFile(db, { data: new Uint8Array([1]), filename: 'a.png' }, factory),
    ).rejects.toBeInstanceOf(StorageNotConfiguredError)
  })

  it('uploads blob first, records metadata, lists and fetches', async () => {
    const db = await configuredDb()
    const { blobs, factory } = fakeStore()
    const meta = await uploadFile(
      db,
      { data: new Uint8Array([1, 2, 3]), filename: 'pic.png', agentSource: 'test' },
      factory,
    )
    expect(meta.mime).toBe('image/png')
    expect(meta.size).toBe(3)
    expect(meta.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(meta.objectKey).toBe(`bctx/files/${meta.id}/pic.png`)
    expect(blobs.has(meta.objectKey)).toBe(true)
    expect((await listFiles(db)).map((f) => f.id)).toEqual([meta.id])
    expect((await getFile(db, meta.id))?.filename).toBe('pic.png')
  })

  it('deletes the blob and soft-deletes the row', async () => {
    const db = await configuredDb()
    const { blobs, factory } = fakeStore()
    const meta = await uploadFile(db, { data: new Uint8Array([1]), filename: 'a.pdf' }, factory)
    expect(await deleteFile(db, meta.id, factory)).toBe(true)
    expect(blobs.size).toBe(0)
    expect(await getFile(db, meta.id)).toBeNull()
    expect(await listFiles(db)).toEqual([])
    expect(await deleteFile(db, meta.id, factory)).toBe(false) // already gone
  })

  it('honors inline only for display-safe mimes', async () => {
    const db = await configuredDb()
    const { factory } = fakeStore()
    const img = await uploadFile(db, { data: new Uint8Array([1]), filename: 'a.png' }, factory)
    const zip = await uploadFile(db, { data: new Uint8Array([1]), filename: 'a.zip' }, factory)
    const svg = await uploadFile(db, { data: new Uint8Array([1]), filename: 'a.svg' }, factory)
    const inlineImg = await presignFileUrl(db, img.id, { disposition: 'inline' }, factory)
    expect(inlineImg?.url).toContain('disp=inline')
    // Non-displayable and scriptable types are forced to attachment.
    const inlineZip = await presignFileUrl(db, zip.id, { disposition: 'inline' }, factory)
    expect(inlineZip?.url).toContain('disp=attachment')
    const inlineSvg = await presignFileUrl(db, svg.id, { disposition: 'inline' }, factory)
    expect(inlineSvg?.url).toContain('disp=attachment')
  })
})

describe('fileReferences', () => {
  it('returns live pages whose body references the file', async () => {
    const db = await configuredDb()
    const { factory } = fakeStore()
    const meta = await uploadFile(db, { data: new Uint8Array([1]), filename: 'a.png' }, factory)
    await createPage(db, {
      title: 'Uses it',
      pageType: 'concept',
      body: `hello ![a](bctx-file://${meta.id})`,
    })
    await createPage(db, { title: 'Unrelated', pageType: 'concept', body: 'nothing' })
    // A page merely containing the raw id (not a file ref) must not count.
    await createPage(db, { title: 'Mentions id', pageType: 'concept', body: `id: ${meta.id}` })
    const refs = await fileReferences(db, meta.id)
    expect(refs.map((r) => r.title)).toEqual(['Uses it'])
  })
})
