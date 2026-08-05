import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@libsql/client'
import { type Kysely, sql } from 'kysely'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createContext, getContext, searchContexts } from '../src/core/contexts'
import { kyselyFor } from '../src/core/db'
import { contextRowCount, SEED_TABLES, seedDatabase } from '../src/core/dump'
import { migrateToLatest } from '../src/core/migrate'
import { setConfigValue } from '../src/core/storeConfig'
import type { Database } from '../src/core/types'
import { addLink, createPage } from '../src/core/wiki'

interface Handle {
  db: Kysely<Database>
  close: () => Promise<void>
}

async function fileDb(path: string): Promise<Handle> {
  const client = createClient({ url: `file:${path}` })
  const db = kyselyFor(client)
  await sql`PRAGMA foreign_keys = ON`.execute(db)
  await migrateToLatest(db)
  return {
    db,
    close: async () => {
      await db.destroy()
      client.close()
    },
  }
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bctx-online-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('libSQL Phase 0 lock', () => {
  it('FTS5 external-content + triggers + bm25 work on a libSQL file', async () => {
    const h = await fileDb(join(dir, 'fts.db'))
    await createContext(h.db, {
      body: 'using C++ and TLS handshakes',
      kind: 'note',
      title: 'crypto',
    })
    expect((await searchContexts(h.db, 'handshakes')).length).toBe(1)
    // FTS-special input must not throw (sanitized fallback)
    await expect(searchContexts(h.db, 'C++')).resolves.toEqual(expect.any(Array))
    await h.close()
  })
})

describe('online seed (migrate-online core)', () => {
  it('seeds a remote faithfully from a local store, FTS rebuilt on the remote', async () => {
    const local = await fileDb(join(dir, 'local.db'))
    const a = await createContext(local.db, {
      body: 'use pnpm always',
      kind: 'rule',
      title: 'Pkg',
      tags: ['t1', 't2'],
    })
    const p1 = await createPage(local.db, {
      title: 'Alpha',
      pageType: 'concept',
      body: 'see [[Beta]]',
    })
    const p2 = await createPage(local.db, { title: 'Beta', pageType: 'concept', body: 'b' })
    await addLink(local.db, p1.id, { toId: p2.id, type: 'relates' })

    const remote = await fileDb(join(dir, 'remote.db'))
    expect(await contextRowCount(remote.db)).toBe(0)

    const counts = await seedDatabase(local.db, remote.db)
    expect(counts.contexts).toBe(3) // 1 context + 2 wiki pages

    // identity preserved
    const got = await getContext(remote.db, a.id)
    expect(got?.id).toBe(a.id)
    expect(got?.tags.sort()).toEqual(['t1', 't2'])

    // FTS re-derived on the remote via triggers during the seed insert
    const found = await searchContexts(remote.db, 'pnpm')
    expect(found.map((c) => c.id)).toEqual([a.id])

    // typed link copied
    const links = await sql<{
      n: number
    }>`SELECT count(*) AS n FROM links WHERE type='relates'`.execute(remote.db)
    expect(Number(links.rows[0]?.n)).toBe(1)

    await local.close()
    await remote.close()
  })

  it('contextRowCount guards a non-empty target', async () => {
    const remote = await fileDb(join(dir, 'r2.db'))
    await createContext(remote.db, { body: 'existing', kind: 'note' })
    expect(await contextRowCount(remote.db)).toBeGreaterThan(0)
    await remote.close()
  })

  it('carries per-store config and page properties to the remote', async () => {
    const local = await fileDb(join(dir, 'cfg-local.db'))
    await setConfigValue(local.db, 'storage.bucket', 'notes')
    await createPage(local.db, {
      title: 'Props',
      pageType: 'concept',
      body: 'x',
      metadata: { props: { status: 'active' } },
    })

    const remote = await fileDb(join(dir, 'cfg-remote.db'))
    const counts = await seedDatabase(local.db, remote.db)

    // Regression: these three tables were absent from SEED_TABLES, so going online
    // silently dropped the storage credentials, the file index, and the props mirror.
    expect(counts.store_config).toBe(1)
    expect(counts.page_properties).toBe(1)
    expect(counts.files).toBe(0)
    const bucket = await sql<{
      value: string
    }>`SELECT value FROM store_config WHERE key='storage.bucket'`.execute(remote.db)
    expect(bucket.rows[0]?.value).toBe('notes')

    await local.close()
    await remote.close()
  })
})

describe('SEED_TABLES', () => {
  it('covers every table in the live schema, so a new migration cannot drift', async () => {
    const h = await fileDb(join(dir, 'drift.db'))
    // FTS5 shadow tables (contexts_fts*) are rebuilt by the insert triggers on the
    // destination; kysely_migration* is the migrator's own bookkeeping.
    const r = await sql<{ name: string }>`
      SELECT name FROM sqlite_master
      WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
        AND name NOT LIKE 'kysely_%'
        AND name NOT LIKE 'contexts_fts%'
    `.execute(h.db)
    expect(r.rows.map((x) => x.name).sort()).toEqual([...SEED_TABLES].sort())
    await h.close()
  })
})
