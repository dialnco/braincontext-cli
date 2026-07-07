import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { Command } from 'commander'
import { withDb } from '../core/db'
import {
  deleteFile,
  type FileMeta,
  fileReferences,
  listFiles,
  presignFileUrl,
  StorageNotConfiguredError,
  uploadFile,
} from '../core/files'
import { createS3Store } from '../core/storage/s3'
import { getStorageConfig } from '../core/storeConfig'
import { dbOptsFrom, parsePositiveInt } from './_shared'

const SETUP_HINT =
  'File storage is not configured for this store. Set it up with:\n' +
  '  bctx config set storage.endpoint https://<account>.r2.cloudflarestorage.com\n' +
  '  bctx config set storage.bucket <bucket>\n' +
  '  bctx config set storage.accessKeyId <key-id>\n' +
  '  bctx config set storage.secretAccessKey <secret>\n' +
  'Optional: storage.region (default "auto"), storage.prefix.'

/** Run an action, turning the unconfigured error into a setup hint + exit 1. */
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof StorageNotConfiguredError) {
      console.error(SETUP_HINT)
      process.exit(1)
    }
    throw e
  }
}

function human(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function printMeta(meta: FileMeta): void {
  console.log(`Uploaded ${meta.filename} (${human(meta.size)}, ${meta.mime})`)
  console.log(`  id:  ${meta.id}`)
  console.log(`  key: ${meta.objectKey}`)
  console.log('Embed in a wiki page:')
  if (meta.mime.startsWith('image/')) {
    console.log(`  ![${meta.filename}](bctx-file://${meta.id})`)
  }
  console.log(`  ![[file:${meta.id}|${meta.filename}]]`)
}

/** Files stored in the configured S3/R2 bucket; this DB keeps only metadata. */
export function fileCommand(): Command {
  const file = new Command('file').description(
    'Manage files stored in the S3/R2 bucket configured via `bctx config` (blobs live\n' +
      'in the bucket; this store keeps only metadata/references).',
  )

  file
    .command('add <path>')
    .description('Upload a file and print its id + wiki embed snippets.')
    .option('--name <name>', 'override the stored filename')
    .option('--agent <name>', 'record an agent source')
    .option('--json', 'output JSON')
    .action(async (path: string, opts, command: Command) => {
      const data = new Uint8Array(await readFile(path))
      const meta = await guarded(() =>
        withDb(dbOptsFrom(command), (db) =>
          uploadFile(db, {
            data,
            filename: opts.name ?? basename(path),
            agentSource: opts.agent ?? 'cli',
          }),
        ),
      )
      if (opts.json) console.log(JSON.stringify(meta, null, 2))
      else printMeta(meta)
    })

  file
    .command('ls')
    .description('List uploaded files, newest first.')
    .option('--limit <n>', 'max rows (default 200)')
    .option('--json', 'output JSON')
    .action(async (opts, command: Command) => {
      const items = await withDb(dbOptsFrom(command), (db) =>
        listFiles(db, { limit: parsePositiveInt(opts.limit, '--limit') }),
      )
      if (opts.json) {
        console.log(JSON.stringify(items, null, 2))
        return
      }
      if (items.length === 0) {
        console.log('No files. Upload one with `bctx file add <path>`.')
        return
      }
      for (const f of items) {
        console.log(`${f.id}  ${human(f.size).padStart(9)}  ${f.mime.padEnd(24)}  ${f.filename}`)
      }
    })

  file
    .command('rm <id>')
    .description('Delete a file from the bucket (and its metadata).')
    .option('--force', 'delete even when wiki pages still reference it')
    .action(async (id: string, opts, command: Command) => {
      await guarded(() =>
        withDb(dbOptsFrom(command), async (db) => {
          if (!opts.force) {
            const refs = await fileReferences(db, id)
            if (refs.length > 0) {
              const list = refs.map((r) => `  ${r.id}  ${r.title ?? '(untitled)'}`).join('\n')
              throw new Error(
                `File is referenced by ${refs.length} page(s):\n${list}\nUse --force to delete anyway.`,
              )
            }
          }
          const ok = await deleteFile(db, id)
          if (!ok) throw new Error(`No such file: ${id}`)
          console.log(`Deleted ${id}`)
        }),
      )
    })

  file
    .command('url <id>')
    .description('Print a temporary presigned URL for a file.')
    .option('--download', 'force download disposition')
    .option('--ttl <seconds>', 'link lifetime (default 300)')
    .action(async (id: string, opts, command: Command) => {
      const r = await guarded(() =>
        withDb(dbOptsFrom(command), (db) =>
          presignFileUrl(db, id, {
            disposition: opts.download ? 'attachment' : 'inline',
            ttlSeconds: parsePositiveInt(opts.ttl, '--ttl'),
          }),
        ),
      )
      if (!r) throw new Error(`No such file: ${id}`)
      console.log(r.url)
    })

  file
    .command('test')
    .description('Verify the storage config by writing and deleting a probe object.')
    .action(async (_opts, command: Command) => {
      await guarded(() =>
        withDb(dbOptsFrom(command), async (db) => {
          const cfg = await getStorageConfig(db)
          if (!cfg) throw new StorageNotConfiguredError()
          const store = await createS3Store(cfg)
          await store.test()
          console.log(`OK — connected to ${cfg.bucket} at ${cfg.endpoint}`)
        }),
      )
    })

  return file
}
