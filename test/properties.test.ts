import { sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import { deleteContext } from '../src/core/contexts'
import { listProperties, queryPages } from '../src/core/query'
import { createPage, setPageProps, updatePage } from '../src/core/wiki'
import { freshDb } from './_db'

describe('page properties — derive-on-write mirror', () => {
  it('mirrors metadata.props into page_properties on create', async () => {
    const db = await freshDb()
    const page = await createPage(db, {
      title: 'Gateway',
      pageType: 'entity',
      body: 'edge',
      metadata: { props: { status: 'active', priority: 2 } },
    })
    const rows = await db
      .selectFrom('page_properties')
      .selectAll()
      .where('context_id', '=', page.id)
      .orderBy('key')
      .execute()
    expect(rows.map((r) => [r.key, r.value, r.type])).toEqual([
      ['priority', '2', 'number'],
      ['status', 'active', 'string'],
    ])
    await db.destroy()
  })

  it('rebuilds the mirror on every write (props are fully derived)', async () => {
    const db = await freshDb()
    const page = await createPage(db, {
      title: 'X',
      pageType: 'concept',
      body: 'b',
      metadata: { props: { status: 'draft' } },
    })
    await setPageProps(db, page.id, { status: 'published', owner: 'ana' })
    const info = await listProperties(db)
    expect(info.find((p) => p.key === 'status')?.count).toBe(1)
    expect(info.find((p) => p.key === 'owner')?.count).toBe(1)
    // The old value is gone (delete-then-reinsert), so a query on it finds nothing.
    expect((await queryPages(db, { where: { status: 'draft' } })).length).toBe(0)
    expect((await queryPages(db, { where: { status: 'published' } })).length).toBe(1)
    await db.destroy()
  })

  it('deletes a key when a prop is set to null', async () => {
    const db = await freshDb()
    const page = await createPage(db, {
      title: 'Y',
      pageType: 'concept',
      body: 'b',
      metadata: { props: { a: '1', b: '2' } },
    })
    await setPageProps(db, page.id, { a: null })
    const keys = (await listProperties(db)).map((p) => p.key).sort()
    expect(keys).toEqual(['b'])
    await db.destroy()
  })

  it('does not mirror non-scalar or internal metadata (only props)', async () => {
    const db = await freshDb()
    await createPage(db, {
      title: 'Z',
      pageType: 'concept',
      body: 'b',
      metadata: { sources: ['a.ts'], props: { tag: 'x', nested: { no: 1 } } },
    })
    const keys = (await listProperties(db)).map((p) => p.key)
    expect(keys).toEqual(['tag']) // sources + the nested object are excluded
    await db.destroy()
  })

  it('cleans up the mirror on hard delete', async () => {
    const db = await freshDb()
    const page = await createPage(db, {
      title: 'Temp',
      pageType: 'concept',
      body: 'b',
      metadata: { props: { k: 'v' } },
    })
    await deleteContext(db, page.id, { hard: true })
    const rows = await db.selectFrom('page_properties').selectAll().execute()
    expect(rows).toEqual([])
    await db.destroy()
  })

  it('degrades gracefully when the mirror table is missing (old un-reset DB)', async () => {
    const db = await freshDb()
    // Simulate a store migrated before page_properties existed.
    await sql`DROP TABLE page_properties`.execute(db)
    // Writes on the UNIVERSAL path must still succeed (mirror is non-authoritative).
    const page = await createPage(db, {
      title: 'Legacy',
      pageType: 'concept',
      body: 'b',
      metadata: { props: { status: 'active' } },
    })
    expect(page.id).toBeTruthy()
    const updated = await updatePage(db, page.id, { body: 'b2' })
    expect(updated?.body).toBe('b2')
    await db.destroy()
  })

  it('re-syncs the mirror when body changes but props are untouched', async () => {
    const db = await freshDb()
    const page = await createPage(db, {
      title: 'Body',
      pageType: 'concept',
      body: 'one',
      metadata: { props: { keep: 'yes' } },
    })
    await updatePage(db, page.id, { body: 'two' })
    // props survive a body-only edit (rebuilt from unchanged metadata).
    expect((await queryPages(db, { where: { keep: 'yes' } })).length).toBe(1)
    await db.destroy()
  })
})
