import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { ObjectStore, StoreFactory } from '../src/core/storage/s3'
import { buildStudioApp } from '../src/studio/server'
import { staticProvider } from '../src/studio/stores'
import { freshDb } from './_db'

function fakeStudioDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bctx-studio-'))
  writeFileSync(join(dir, 'index.html'), '<!doctype html><div id="root">poc</div>')
  return dir
}

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
      return `https://fake.bucket.example/${key}?disp=${opts.disposition}`
    },
    async test() {},
  }
  const factory: StoreFactory = async () => store
  return { blobs, factory }
}

async function newApp(): Promise<{ app: Hono; blobs: Map<string, Uint8Array> }> {
  const db = await freshDb()
  const { blobs, factory } = fakeStore()
  const app = buildStudioApp(staticProvider(db), {
    staticDir: fakeStudioDir(),
    filesStoreFactory: factory,
  })
  return { app, blobs }
}

const CONFIG = {
  endpoint: 'https://acc.r2.cloudflarestorage.com',
  bucket: 'notes',
  accessKeyId: 'AKIA1234EXAMPLE99',
  secretAccessKey: 'super-secret-value',
  prefix: 'bctx',
}

const putJson = (body: unknown) => ({
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

interface StatusJson {
  configured: boolean
  bucket?: string
  code?: string
}
interface MetaJson {
  id: string
  filename: string
  mime: string
  size: number
  objectKey: string
}
const jsonOf = <T>(res: Response): Promise<T> => res.json() as Promise<T>

async function configure(app: Hono): Promise<void> {
  const res = await app.request('/api/files/config', putJson(CONFIG))
  expect(res.status).toBe(200)
}

function uploadForm(name: string, bytes: number[]): FormData {
  const form = new FormData()
  form.append('file', new File([new Uint8Array(bytes)], name, { type: '' }))
  return form
}

describe('files API: config + status', () => {
  it('reports unconfigured, accepts config, and NEVER echoes the secret', async () => {
    const { app } = await newApp()
    const before = await jsonOf<StatusJson>(await app.request('/api/files/status'))
    expect(before).toEqual({ configured: false })

    const saved = await app.request('/api/files/config', putJson(CONFIG))
    expect(saved.status).toBe(200)
    expect(JSON.stringify(await jsonOf<StatusJson>(saved))).not.toContain(CONFIG.secretAccessKey)

    const after = await app.request('/api/files/status')
    const status = await jsonOf<StatusJson>(after)
    expect(status.configured).toBe(true)
    expect(status.bucket).toBe('notes')
    expect(JSON.stringify(status)).not.toContain(CONFIG.secretAccessKey)
    expect(JSON.stringify(status)).not.toContain(CONFIG.accessKeyId) // masked, not raw
  })

  it('keeps the stored secret when a config edit omits it', async () => {
    const { app } = await newApp()
    await configure(app)
    const { secretAccessKey: _omit, ...rest } = CONFIG
    await app.request('/api/files/config', putJson({ ...rest, bucket: 'renamed' }))
    const status = await jsonOf<StatusJson>(await app.request('/api/files/status'))
    expect(status.configured).toBe(true)
    expect(status.bucket).toBe('renamed')
  })

  it('validates the config body', async () => {
    const { app } = await newApp()
    const bad = await app.request('/api/files/config', putJson({ endpoint: 'not-a-url' }))
    expect(bad.status).toBe(400)
  })

  it('tests the connection (400 when unconfigured, ok with the fake store)', async () => {
    const { app } = await newApp()
    const unconfigured = await app.request('/api/files/config/test', { method: 'POST' })
    expect(unconfigured.status).toBe(400)
    expect((await jsonOf<StatusJson>(unconfigured)).code).toBe('not_configured')
    await configure(app)
    const ok = await app.request('/api/files/config/test', { method: 'POST' })
    expect(ok.status).toBe(200)
  })
})

describe('files API: upload / list / meta / delete / content', () => {
  it('refuses uploads with a clear code when storage is unconfigured', async () => {
    const { app } = await newApp()
    const res = await app.request('/api/files', { method: 'POST', body: uploadForm('a.png', [1]) })
    expect(res.status).toBe(409)
    expect((await jsonOf<StatusJson>(res)).code).toBe('not_configured')
  })

  it('uploads multipart, stores the blob, and serves metadata', async () => {
    const { app, blobs } = await newApp()
    await configure(app)
    const res = await app.request('/api/files', {
      method: 'POST',
      body: uploadForm('pic.png', [1, 2, 3]),
    })
    expect(res.status).toBe(201)
    const meta = await jsonOf<MetaJson>(res)
    expect(meta.mime).toBe('image/png')
    expect(meta.size).toBe(3)
    expect(blobs.has(meta.objectKey)).toBe(true)

    const list = await jsonOf<MetaJson[]>(await app.request('/api/files'))
    expect(list.map((f: { id: string }) => f.id)).toEqual([meta.id])
    const one = await app.request(`/api/files/${meta.id}`)
    expect(one.status).toBe(200)
    expect((await jsonOf<MetaJson>(one)).filename).toBe('pic.png')
  })

  it('rejects oversized uploads by content-length before reading the body', async () => {
    const { app } = await newApp()
    await configure(app)
    const res = await app.request('/api/files', {
      method: 'POST',
      headers: { 'content-length': String(200 * 1024 * 1024) },
      body: uploadForm('big.bin', [1]),
    })
    expect(res.status).toBe(413)
  })

  it('302-redirects content to a presigned URL with no-store caching', async () => {
    const { app } = await newApp()
    await configure(app)
    const up = await app.request('/api/files', {
      method: 'POST',
      body: uploadForm('doc.pdf', [1]),
    })
    const meta = await jsonOf<MetaJson>(up)
    const res = await app.request(`/api/files/${meta.id}/content`)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toContain('https://fake.bucket.example/')
    expect(res.headers.get('location')).toContain('disp=inline')
    expect(res.headers.get('cache-control')).toBe('no-store')
    const dl = await app.request(`/api/files/${meta.id}/content?disposition=attachment`)
    expect(dl.headers.get('location')).toContain('disp=attachment')
  })

  it('deletes the file (blob + metadata) and 404s afterwards', async () => {
    const { app, blobs } = await newApp()
    await configure(app)
    const up = await app.request('/api/files', { method: 'POST', body: uploadForm('x.png', [1]) })
    const meta = await jsonOf<MetaJson>(up)
    const del = await app.request(`/api/files/${meta.id}`, { method: 'DELETE' })
    expect(del.status).toBe(200)
    expect(blobs.size).toBe(0)
    expect((await app.request(`/api/files/${meta.id}`)).status).toBe(404)
    expect((await app.request(`/api/files/${meta.id}/content`)).status).toBe(404)
  })
})
