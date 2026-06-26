import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Kysely, sql } from 'kysely'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createContext, getContext, updateContext } from '../src/core/contexts'
import { openStore, type Store } from '../src/core/db'
import { migrateToLatest } from '../src/core/migrate'
import type { Database } from '../src/core/types'

/**
 * In-process regression for the write-serialization + retry fixes, modelling the
 * realistic shapes:
 *  - concurrent writes on ONE long-lived connection (the MCP server receiving
 *    concurrent tool calls) — must serialize and lose nothing;
 *  - concurrent first-run migration — must not crash.
 *
 * The cross-PROCESS matrix (many agents = many OS processes hammering one file)
 * lives in scripts/stress/local.mts, which the harness runs at scale.
 */

let dir: string
let file: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bctx-conc-'))
  file = join(dir, 'c.db')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

async function open(): Promise<Store> {
  const store = openStore({ mode: 'local', file })
  await store.prepare()
  await migrateToLatest(store.db, { lockFile: file })
  return store
}

async function count(db: Kysely<Database>, q: ReturnType<typeof sql>): Promise<number> {
  const r = (await q.execute(db)) as { rows: Array<{ n: number | bigint }> }
  return Number(r.rows[0]?.n ?? 0)
}

describe('concurrency', () => {
  it('concurrent first-run migration on a fresh file does not crash', async () => {
    const [a, b] = await Promise.all([open(), open()])
    expect(await count(a.db, sql`SELECT count(*) AS n FROM contexts`)).toBe(0)
    expect(await count(b.db, sql`SELECT count(*) AS n FROM contexts`)).toBe(0)
    await a.close()
    await b.close()
  })

  it('concurrent writes on one connection serialize — all land, no duplicates', async () => {
    const s = await open()
    const N = 40
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        createContext(s.db, { body: `x-${i}`, kind: 'note', namespace: 'c' }),
      ),
    )
    expect(await count(s.db, sql`SELECT count(*) AS n FROM contexts WHERE namespace = 'c'`)).toBe(N)
    expect(
      await count(
        s.db,
        sql`SELECT count(*) AS n FROM (SELECT id FROM contexts GROUP BY id HAVING count(*) > 1)`,
      ),
    ).toBe(0)
    await s.close()
  })

  it('concurrent setMetadata on one connection loses no keys (read inside txn)', async () => {
    const s = await open()
    const c = await createContext(s.db, { body: 'target', kind: 'note', namespace: 'c' })
    const N = 30
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        updateContext(s.db, c.id, { setMetadata: { [`k${i}`]: i } }),
      ),
    )
    const final = await getContext(s.db, c.id)
    expect(Object.keys(final?.metadata ?? {}).length).toBe(N)
    await s.close()
  })
})
