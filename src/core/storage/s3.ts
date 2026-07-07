import type { StorageConfig } from '../storeConfig'

/**
 * The only module that touches the AWS SDK, and only via dynamic import so `bctx`
 * cold-start never pays for it unless a file operation actually runs. Works against
 * any S3-compatible endpoint; tuned for Cloudflare R2 (`region: 'auto'`, path-style).
 */

export interface PresignOpts {
  ttlSeconds: number
  filename: string
  disposition: 'inline' | 'attachment'
  contentType?: string
}

export interface ObjectStore {
  put(key: string, body: Uint8Array, opts: { contentType: string }): Promise<void>
  delete(key: string): Promise<void>
  presignGet(key: string, opts: PresignOpts): Promise<string>
  /** Round-trip a probe object (R2 tokens often lack HeadBucket permission). */
  test(): Promise<void>
}

export type StoreFactory = (cfg: StorageConfig) => Promise<ObjectStore>

/** RFC 5987 encoding so unicode filenames survive Content-Disposition. */
function contentDisposition(disposition: 'inline' | 'attachment', filename: string): string {
  // ASCII fallback for legacy parsers: printable ASCII minus quote/backslash.
  const fallback = Array.from(filename, (ch) => {
    const code = ch.charCodeAt(0)
    return code >= 0x20 && code < 0x7f && ch !== '"' && ch !== '\\' ? ch : '_'
  }).join('')
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

export const createS3Store: StoreFactory = async (cfg) => {
  const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = await import(
    '@aws-sdk/client-s3'
  )
  const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner')

  const client = new S3Client({
    region: cfg.region || 'auto',
    endpoint: cfg.endpoint,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    forcePathStyle: true,
  })

  return {
    async put(key, body, opts) {
      await client.send(
        new PutObjectCommand({
          Bucket: cfg.bucket,
          Key: key,
          Body: body,
          ContentType: opts.contentType,
        }),
      )
    },

    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }))
    },

    async presignGet(key, opts) {
      const cmd = new GetObjectCommand({
        Bucket: cfg.bucket,
        Key: key,
        ResponseContentDisposition: contentDisposition(opts.disposition, opts.filename),
        ...(opts.contentType ? { ResponseContentType: opts.contentType } : {}),
      })
      return getSignedUrl(client, cmd, { expiresIn: opts.ttlSeconds })
    },

    async test() {
      const prefix = cfg.prefix ? `${cfg.prefix.replace(/\/+$/, '')}/` : ''
      const key = `${prefix}.bctx-connection-test`
      await client.send(
        new PutObjectCommand({
          Bucket: cfg.bucket,
          Key: key,
          Body: new Uint8Array([0x62, 0x63, 0x74, 0x78]),
          ContentType: 'application/octet-stream',
        }),
      )
      await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }))
    },
  }
}
