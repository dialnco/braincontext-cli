import { sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import { getContext } from '../src/core/contexts'
import { migrateToLatest } from '../src/core/migrate'
import { queryPages } from '../src/core/query'
import { createPage } from '../src/core/wiki'
import { freshDb } from './_db'

const tableExists = async (db: Awaited<ReturnType<typeof freshDb>>, name: string) => {
  const r = await sql<{
    n: number
  }>`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name=${name}`.execute(db)
  return (r.rows[0]?.n ?? 0) > 0
}

describe('migrations — incrementals upgrade an existing store without data loss', () => {
  it('applies 0002 + 0003 to a store already at 0001, preserving data', async () => {
    const db = await freshDb() // fully migrated (0001 + 0002 + 0003)

    // Seed real data BEFORE the "downgrade", to prove the migration preserves it.
    const page = await createPage(db, {
      title: 'Existing',
      pageType: 'concept',
      body: 'body with [[Link]]',
      metadata: { props: { status: 'active' } },
    })

    // Simulate an OLD store that only ran 0001 (the exact edumetrics starting state):
    // drop the incremental tables and forget their migration records.
    await sql`DROP TABLE page_properties`.execute(db)
    await sql`DROP TABLE files`.execute(db)
    await sql`DROP TABLE store_config`.execute(db)
    await sql`DELETE FROM kysely_migration WHERE name IN ('0002_page_properties', '0003_file_storage')`.execute(
      db,
    )
    expect(await tableExists(db, 'page_properties')).toBe(false)
    expect(await tableExists(db, 'files')).toBe(false)

    // The upgrade path: opening the store re-runs migrations → 0002 and 0003 apply.
    await migrateToLatest(db)
    expect(await tableExists(db, 'page_properties')).toBe(true)
    expect(await tableExists(db, 'files')).toBe(true)
    expect(await tableExists(db, 'store_config')).toBe(true)

    const applied = await sql<{
      name: string
    }>`SELECT name FROM kysely_migration ORDER BY name`.execute(db)
    expect(applied.rows.map((r) => r.name)).toEqual([
      '0001_init',
      '0002_page_properties',
      '0003_file_storage',
    ])

    // Data survived the migration untouched.
    const still = await getContext(db, page.id)
    expect(still?.title).toBe('Existing')
    expect(still?.body).toBe('body with [[Link]]')

    // The mirror was empty right after 0002 (derived on write), but the next write repopulates it.
    await createPage(db, {
      title: 'New After Upgrade',
      pageType: 'concept',
      body: 'x',
      metadata: { props: { status: 'active' } },
    })
    const hits = await queryPages(db, { where: { status: 'active' } })
    expect(hits.length).toBeGreaterThanOrEqual(1)
    await db.destroy()
  })
})
