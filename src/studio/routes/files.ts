import { Hono } from 'hono'
import { z } from 'zod'
import {
  deleteFile,
  getFile,
  listFiles,
  presignFileUrl,
  StorageNotConfiguredError,
  uploadFile,
} from '../../core/files'
import { createS3Store, type StoreFactory } from '../../core/storage/s3'
import { getStorageConfig, setStorageConfig, storageStatus } from '../../core/storeConfig'
import { readJson } from '../http'
import type { StoreProvider } from '../stores'

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024

const configBody = z.object({
  endpoint: z.url(),
  region: z.string().optional(),
  bucket: z.string().min(1),
  accessKeyId: z.string().min(1),
  // Write-only: omitted (or empty) keeps the stored secret, so editing the other
  // fields never requires re-entering it. Responses never include it.
  secretAccessKey: z.string().min(1).optional(),
  prefix: z.string().optional(),
})

/**
 * File storage surface: S3/R2 config (secrets write-only) + upload/list/delete +
 * presigned-GET redirects. Blobs never touch this server on reads — `/:id/content`
 * 302s to a short-lived presigned URL on the bucket. Mounted at /api/files.
 * The `factory` param is the test seam (inject a fake ObjectStore).
 */
export function filesRoutes(provider: StoreProvider, factory: StoreFactory = createS3Store): Hono {
  const app = new Hono()

  app.onError((err, c) => {
    if (err instanceof StorageNotConfiguredError) {
      return c.json({ error: 'file storage not configured', code: 'not_configured' }, 409)
    }
    return c.json({ error: (err as Error).message }, 500)
  })

  app.get('/status', async (c) => c.json(await storageStatus(provider.db())))

  app.put('/config', async (c) => {
    const parsed = await readJson(c, configBody)
    if (!parsed.ok) return parsed.res
    await setStorageConfig(provider.db(), parsed.data)
    return c.json(await storageStatus(provider.db()))
  })

  app.post('/config/test', async (c) => {
    const cfg = await getStorageConfig(provider.db())
    if (!cfg) {
      return c.json({ error: 'file storage not configured', code: 'not_configured' }, 400)
    }
    try {
      const store = await factory(cfg)
      await store.test()
      return c.json({ ok: true })
    } catch (e) {
      return c.json({ error: (e as Error).message }, 502)
    }
  })

  app.post('/', async (c) => {
    const len = Number(c.req.header('content-length') ?? 0)
    if (len > MAX_UPLOAD_BYTES) {
      return c.json({ error: 'file too large (max 100 MB)' }, 413)
    }
    const body = await c.req.parseBody()
    const f = body.file
    if (!(f instanceof File)) {
      return c.json({ error: 'multipart field "file" required' }, 400)
    }
    const meta = await uploadFile(
      provider.db(),
      {
        data: new Uint8Array(await f.arrayBuffer()),
        filename: f.name,
        // Multipart parts with no declared type arrive as octet-stream — treat that
        // as "unknown" so the extension mapping can produce a real MIME type.
        mime: f.type && f.type !== 'application/octet-stream' ? f.type : undefined,
        agentSource: 'studio',
      },
      factory,
    )
    return c.json(meta, 201)
  })

  app.get('/', async (c) => c.json(await listFiles(provider.db())))

  app.get('/:id', async (c) => {
    const meta = await getFile(provider.db(), c.req.param('id'))
    if (!meta) return c.json({ error: 'not found' }, 404)
    return c.json(meta)
  })

  app.delete('/:id', async (c) => {
    const ok = await deleteFile(provider.db(), c.req.param('id'), factory)
    if (!ok) return c.json({ error: 'not found' }, 404)
    return c.json({ ok: true })
  })

  app.get('/:id/content', async (c) => {
    const disposition = c.req.query('disposition') === 'attachment' ? 'attachment' : 'inline'
    const r = await presignFileUrl(
      provider.db(),
      c.req.param('id'),
      { disposition, ttlSeconds: 300 },
      factory,
    )
    if (!r) return c.json({ error: 'not found' }, 404)
    // The redirect target expires — a cached 302 would serve a dead presigned URL.
    c.header('Cache-Control', 'no-store')
    return c.redirect(r.url, 302)
  })

  return app
}
