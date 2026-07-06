import { describe, expect, it } from 'vitest'
import { createDatatable } from '../src/core/datatable'
import { tableAddRow, tableGet, tableSetCell } from '../src/core/tables'
import { searchPages } from '../src/core/wiki'
import { freshDb } from './_db'

describe('core/datatable — body-canonical GFM table page', () => {
  it('creates a page whose body IS a GFM table (searchable, peekable)', async () => {
    const db = await freshDb()
    const dt = await createDatatable(db, {
      title: 'Providers',
      columns: ['Name', 'Status'],
      rows: [
        ['Acme', 'active'],
        ['Beta', 'deprecated'],
      ],
    })
    expect(dt.pageType).toBe('datatable')
    expect(dt.body).toContain('| Name | Status |')
    expect(dt.body).toContain('| Acme | active |')

    // The datatable is just a page, so the Phase 1 table ops work on it for free.
    const view = await tableGet(db, dt.id, {})
    expect(view.header).toEqual(['Name', 'Status'])
    expect(view.rows).toEqual([
      ['Acme', 'active'],
      ['Beta', 'deprecated'],
    ])

    // Its cell text is full-text searchable (body is canonical, no bespoke read path).
    const hits = await searchPages(db, 'deprecated')
    expect(hits.map((h) => h.id)).toContain(dt.id)
    await db.destroy()
  })

  it('creates an empty (headers-only) datatable that rows can be appended to', async () => {
    const db = await freshDb()
    const dt = await createDatatable(db, { title: 'Empty', columns: ['Key', 'Value'] })
    expect((await tableGet(db, dt.id, {})).rows).toEqual([])
    const added = await tableAddRow(db, dt.id, {}, ['k1', 'v1'])
    expect(added.body).toContain('| k1 | v1 |')
    const edited = await tableSetCell(db, dt.id, {}, 'k1', 'Value', 'v2')
    expect(edited.body).toContain('| k1 | v2 |')
    await db.destroy()
  })
})
