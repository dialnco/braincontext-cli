import { createHash } from 'node:crypto'
import type { Kysely } from 'kysely'
import { ulid } from 'ulidx'
import { currentPrincipalId } from './access/session'
import { createS3Store, type StoreFactory } from './storage/s3'
import { getStorageConfig, type StorageConfig } from './storeConfig'
import type { Database } from './types'

/**
 * File management backed by S3-compatible object storage (R2). This DB holds ONLY
 * metadata/references; blobs live exclusively in the bucket. Every operation requires
 * the `storage.*` config (see storeConfig.ts) and throws StorageNotConfiguredError
 * otherwise, so callers can gate cleanly.
 */

export class StorageNotConfiguredError extends Error {
  readonly code = 'not_configured'
  constructor() {
    super('file storage is not configured (set storage.* config keys)')
  }
}

export interface FileMeta {
  id: string
  objectKey: string
  filename: string
  mime: string
  size: number
  sha256: string | null
  agentSource: string | null
  createdAt: string
  deletedAt: string | null
}

/** Matches a ULID (Crockford base32, 26 chars) — the strict whitelist for file refs. */
export const FILE_ID_RE = /[0-9A-HJKMNP-TV-Z]{26}/

/**
 * File ids referenced by a markdown body, via either syntax:
 * images `![alt](bctx-file://<id>)` and attachments `![[file:<id>|name]]` / `[[file:<id>|name]]`.
 */
export function fileRefIds(body: string): string[] {
  const ids = new Set<string>()
  const img = /!\[[^\]\n]*\]\(bctx-file:\/\/([0-9A-HJKMNP-TV-Z]{26})\)/g
  const embed = /!?\[\[\s*file:([0-9A-HJKMNP-TV-Z]{26})[^\]]*\]\]/gi
  for (const m of body.matchAll(img)) if (m[1]) ids.add(m[1])
  for (const m of body.matchAll(embed)) if (m[1]) ids.add(m[1].toUpperCase())
  return [...ids]
}

/**
 * Keep only a safe basename: strip any path, control chars, and shell/URL-hostile
 * chars; cap length while preserving the extension. Never returns an empty string.
 */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? ''
  let clean = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+|[-]+$/g, '')
  if (clean.length > 120) {
    const dot = clean.lastIndexOf('.')
    const ext = dot > 0 && clean.length - dot <= 12 ? clean.slice(dot) : ''
    clean = clean.slice(0, 120 - ext.length) + ext
  }
  return clean || 'file'
}

export function objectKeyFor(prefix: string | undefined, id: string, filename: string): string {
  const p = prefix ? `${prefix.replace(/^\/+|\/+$/g, '')}/` : ''
  return `${p}files/${id}/${sanitizeFilename(filename)}`
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  zip: 'application/zip',
  mp4: 'video/mp4',
  mp3: 'audio/mpeg',
  // Office (OpenXML + legacy) — otherwise CLI uploads (which pass no MIME) store octet-stream.
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  doc: 'application/msword',
  xls: 'application/vnd.ms-excel',
  ppt: 'application/vnd.ms-powerpoint',
}

export function mimeFor(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop() ?? ''
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

/**
 * Rendered inline only for types a browser can display without executing anything;
 * everything else is forced to download. SVG is deliberately NOT inline (scriptable).
 */
const INLINE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'application/pdf',
  'text/plain',
])

async function requireStorage(db: Kysely<Database>): Promise<StorageConfig> {
  const cfg = await getStorageConfig(db)
  if (!cfg) throw new StorageNotConfiguredError()
  return cfg
}

function toMeta(r: {
  id: string
  object_key: string
  filename: string
  mime: string
  size: number
  sha256: string | null
  agent_source: string | null
  created_at: string
  deleted_at: string | null
}): FileMeta {
  return {
    id: r.id,
    objectKey: r.object_key,
    filename: r.filename,
    mime: r.mime,
    size: r.size,
    sha256: r.sha256,
    agentSource: r.agent_source,
    createdAt: r.created_at,
    deletedAt: r.deleted_at,
  }
}

export interface UploadInput {
  data: Uint8Array
  filename: string
  mime?: string
  agentSource?: string | null
}

/**
 * Upload to the bucket FIRST, then insert the metadata row: a failed put leaves no
 * orphan row, while an orphaned blob (row insert failing after put) is harmless and
 * overwritten on retry of the same key — but keys embed a fresh ULID, so in practice
 * it is just unreferenced garbage.
 */
export async function uploadFile(
  db: Kysely<Database>,
  input: UploadInput,
  factory: StoreFactory = createS3Store,
): Promise<FileMeta> {
  const cfg = await requireStorage(db)
  const id = ulid()
  const filename = sanitizeFilename(input.filename)
  const mime = input.mime || mimeFor(filename)
  const objectKey = objectKeyFor(cfg.prefix, id, filename)
  const sha256 = createHash('sha256').update(input.data).digest('hex')

  const store = await factory(cfg)
  await store.put(objectKey, input.data, { contentType: mime })

  const row = {
    id,
    object_key: objectKey,
    filename,
    mime,
    size: input.data.byteLength,
    sha256,
    agent_source: input.agentSource ?? null,
    metadata: '{}',
    created_at: new Date().toISOString(),
    deleted_at: null,
    principal_id: currentPrincipalId(),
  }
  await db.insertInto('files').values(row).execute()
  return toMeta(row)
}

export async function listFiles(
  db: Kysely<Database>,
  opts: { limit?: number } = {},
): Promise<FileMeta[]> {
  const rows = await db
    .selectFrom('files')
    .selectAll()
    .where('deleted_at', 'is', null)
    .orderBy('created_at', 'desc')
    .limit(opts.limit ?? 200)
    .execute()
  return rows.map(toMeta)
}

export async function getFile(db: Kysely<Database>, id: string): Promise<FileMeta | null> {
  const row = await db
    .selectFrom('files')
    .selectAll()
    .where('id', '=', id)
    .where('deleted_at', 'is', null)
    .executeTakeFirst()
  return row ? toMeta(row) : null
}

/** Delete the blob from the bucket, then soft-delete the row (id stays resolvable as "missing"). */
export async function deleteFile(
  db: Kysely<Database>,
  id: string,
  factory: StoreFactory = createS3Store,
): Promise<boolean> {
  const meta = await getFile(db, id)
  if (!meta) return false
  const cfg = await requireStorage(db)
  const store = await factory(cfg)
  await store.delete(meta.objectKey)
  await db
    .updateTable('files')
    .set({ deleted_at: new Date().toISOString() })
    .where('id', '=', id)
    .execute()
  return true
}

export interface PresignedFile {
  url: string
  meta: FileMeta
}

/**
 * Short-lived presigned GET URL. `inline` is only honored for the display-safe MIME
 * allowlist; anything else is served as a download with a neutral content type.
 */
export async function presignFileUrl(
  db: Kysely<Database>,
  id: string,
  opts: { disposition?: 'inline' | 'attachment'; ttlSeconds?: number } = {},
  factory: StoreFactory = createS3Store,
): Promise<PresignedFile | null> {
  const meta = await getFile(db, id)
  if (!meta) return null
  const cfg = await requireStorage(db)
  const store = await factory(cfg)
  const inlineOk = INLINE_MIMES.has(meta.mime)
  const disposition = opts.disposition === 'inline' && inlineOk ? 'inline' : 'attachment'
  const url = await store.presignGet(meta.objectKey, {
    ttlSeconds: opts.ttlSeconds ?? 300,
    filename: meta.filename,
    disposition,
    contentType: disposition === 'inline' ? meta.mime : 'application/octet-stream',
  })
  return { url, meta }
}

/** Live pages whose body references this file (by id, either syntax). */
export async function fileReferences(
  db: Kysely<Database>,
  id: string,
): Promise<Array<{ id: string; title: string | null }>> {
  const rows = await db
    .selectFrom('contexts')
    .select(['id', 'title', 'body'])
    .where('deleted_at', 'is', null)
    .where('body', 'like', `%${id}%`)
    .execute()
  return rows
    .filter((r) => fileRefIds(r.body).includes(id))
    .map((r) => ({ id: r.id, title: r.title }))
}
