import { describe, expect, it } from 'vitest'
import { RevConflictError } from '../src/core/contexts'
import {
  TableError,
  tableAddColumn,
  tableAddRow,
  tableDeleteColumn,
  tableDeleteRow,
  tableDeleteRowAt,
  tableGet,
  tableRenameColumn,
  tableSetCell,
  tableSetCellAt,
  tableSetColumnAlign,
} from '../src/core/tables'
import { createPage, listLog, recordSource, searchPages } from '../src/core/wiki'
import { freshDb } from './_db'

const BODY = [
  '# Providers',
  '',
  '## Supported',
  '',
  '| Name | Status |',
  '| --- | --- |',
  '| Acme | active |',
  '| Beta | deprecated |',
].join('\n')

async function pageWithTable(db: Awaited<ReturnType<typeof freshDb>>) {
  return createPage(db, { title: 'Providers', pageType: 'concept', body: BODY })
}

describe('core/tables — inline table ops', () => {
  it('reads a table as structured rows without the body', async () => {
    const db = await freshDb()
    const page = await pageWithTable(db)
    const view = await tableGet(db, page.id, {})
    expect(view.header).toEqual(['Name', 'Status'])
    expect(view.rows).toEqual([
      ['Acme', 'active'],
      ['Beta', 'deprecated'],
    ])
    expect(view.headingAbove).toBe('Supported')
    expect(view.rev).toBe(page.rev)
    await db.destroy()
  })

  it('sets one cell, funnels through updatePage (history + FTS), leaves others intact', async () => {
    const db = await freshDb()
    const page = await pageWithTable(db)
    const updated = await tableSetCell(db, page.id, {}, 'Beta', 'Status', 'active')
    expect(updated.body).toContain('| Beta | active |')
    expect(updated.body).not.toContain('deprecated')
    expect(updated.body).toContain('| Acme | active |') // untouched row preserved
    expect(updated.rev).not.toBe(page.rev) // rev advanced

    // Went through the wiki write path: FTS finds the new cell text.
    const hits = await searchPages(db, 'active')
    expect(hits.map((h) => h.id)).toContain(page.id)
    await db.destroy()
  })

  it('adds and deletes rows', async () => {
    const db = await freshDb()
    const page = await pageWithTable(db)
    const added = await tableAddRow(db, page.id, {}, ['Gamma', 'active'])
    expect(added.body).toContain('| Gamma | active |')
    const deleted = await tableDeleteRow(db, page.id, {}, 'Acme')
    expect(deleted.body).not.toContain('| Acme |')
    expect(deleted.body).toContain('| Gamma | active |')
    await db.destroy()
  })

  it('errors loudly on an unknown column or row (no silent wrong-place edit)', async () => {
    const db = await freshDb()
    const page = await pageWithTable(db)
    await expect(tableSetCell(db, page.id, {}, 'Beta', 'Nope', 'x')).rejects.toBeInstanceOf(
      TableError,
    )
    await expect(tableSetCell(db, page.id, {}, 'Nobody', 'Status', 'x')).rejects.toBeInstanceOf(
      TableError,
    )
    await db.destroy()
  })

  it('honors ifRev compare-and-swap', async () => {
    const db = await freshDb()
    const page = await pageWithTable(db)
    // A concurrent edit advances the page rev.
    await tableSetCell(db, page.id, {}, 'Acme', 'Status', 'paused')
    // Our edit still carries the original rev → conflict.
    await expect(
      tableSetCell(db, page.id, {}, 'Beta', 'Status', 'active', { ifRev: page.rev }),
    ).rejects.toBeInstanceOf(RevConflictError)
    await db.destroy()
  })

  it('disambiguates by caption / tableIndex and reports ambiguity', async () => {
    const db = await freshDb()
    const body = ['## A', '| x |', '| --- |', '| 1 |', '## B', '| y |', '| --- |', '| 2 |'].join(
      '\n',
    )
    const page = await createPage(db, { title: 'Two', pageType: 'concept', body })
    // No locator + multiple tables → ambiguous.
    await expect(tableGet(db, page.id, {})).rejects.toBeInstanceOf(TableError)
    // By caption resolves.
    expect((await tableGet(db, page.id, { caption: 'B' })).header).toEqual(['y'])
    // By index resolves.
    expect((await tableGet(db, page.id, { tableIndex: 0 })).header).toEqual(['x'])
    await db.destroy()
  })

  it('does not touch a table inside a code fence', async () => {
    const db = await freshDb()
    const body = [
      '```md',
      '| fake | table |',
      '| --- | --- |',
      '| a | b |',
      '```',
      '',
      '| real | col |',
      '| --- | --- |',
      '| 1 | 2 |',
    ].join('\n')
    const page = await createPage(db, { title: 'Fenced', pageType: 'concept', body })
    const view = await tableGet(db, page.id, {})
    expect(view.header).toEqual(['real', 'col']) // only the real table is seen
    await db.destroy()
  })

  it('keeps the wiki log usable (page created)', async () => {
    const db = await freshDb()
    await pageWithTable(db)
    expect(Array.isArray(await listLog(db))).toBe(true)
    await db.destroy()
  })
})

describe('core/tables — index-addressed ops (grid)', () => {
  it('sets a cell by row+col index, funnels through updatePage (FTS + rev)', async () => {
    const db = await freshDb()
    const page = await pageWithTable(db)
    const updated = await tableSetCellAt(db, page.id, {}, 1, 1, 'active')
    expect(updated.body).toContain('| Beta | active |')
    expect(updated.rev).not.toBe(page.rev)
    expect((await searchPages(db, 'active')).map((h) => h.id)).toContain(page.id)
    await db.destroy()
  })

  it('deletes a row by index', async () => {
    const db = await freshDb()
    const page = await pageWithTable(db)
    const updated = await tableDeleteRowAt(db, page.id, {}, 0)
    expect(updated.body).not.toContain('| Acme |')
    expect(updated.body).toContain('| Beta | deprecated |')
    await db.destroy()
  })

  it('adds, renames, aligns, and deletes a column (rows stay rectangular)', async () => {
    const db = await freshDb()
    const page = await pageWithTable(db)
    const added = await tableAddColumn(db, page.id, {}, { name: 'Owner' })
    const view1 = await tableGet(db, added.id, {})
    expect(view1.header).toEqual(['Name', 'Status', 'Owner'])
    expect(view1.rows).toEqual([
      ['Acme', 'active', ''],
      ['Beta', 'deprecated', ''],
    ])

    await tableRenameColumn(db, page.id, {}, 2, 'Team')
    await tableSetColumnAlign(db, page.id, {}, 2, 'center')
    const view2 = await tableGet(db, page.id, {})
    expect(view2.header).toEqual(['Name', 'Status', 'Team'])
    expect(view2.alignments[2]).toBe('center')

    const deleted = await tableDeleteColumn(db, page.id, {}, 2)
    expect((await tableGet(db, deleted.id, {})).header).toEqual(['Name', 'Status'])
    await db.destroy()
  })

  it('errors on out-of-range indices and refuses deleting the last column', async () => {
    const db = await freshDb()
    const page = await pageWithTable(db)
    await expect(tableSetCellAt(db, page.id, {}, 9, 0, 'x')).rejects.toBeInstanceOf(TableError)
    await expect(tableSetCellAt(db, page.id, {}, 0, 9, 'x')).rejects.toBeInstanceOf(TableError)
    await expect(tableDeleteColumn(db, page.id, {}, 5)).rejects.toBeInstanceOf(TableError)
    // Collapse to one column, then refuse deleting it.
    await tableDeleteColumn(db, page.id, {}, 1)
    await expect(tableDeleteColumn(db, page.id, {}, 0)).rejects.toBeInstanceOf(TableError)
    await db.destroy()
  })

  it('honors ifRev on a column op', async () => {
    const db = await freshDb()
    const page = await pageWithTable(db)
    await tableSetCellAt(db, page.id, {}, 0, 1, 'paused') // advances rev
    await expect(
      tableAddColumn(db, page.id, {}, { name: 'X' }, { ifRev: page.rev }),
    ).rejects.toBeInstanceOf(RevConflictError)
    await db.destroy()
  })

  it('refuses editing a table on an immutable source page', async () => {
    const db = await freshDb()
    const src = await recordSource(db, {
      title: 'Src',
      body: '| a | b |\n| --- | --- |\n| 1 | 2 |',
    })
    // Reading the source table is fine.
    expect((await tableGet(db, src.id, {})).header).toEqual(['a', 'b'])
    // Writing is refused.
    await expect(tableSetCellAt(db, src.id, {}, 0, 0, 'x')).rejects.toBeInstanceOf(TableError)
    await expect(tableAddColumn(db, src.id, {}, { name: 'c' })).rejects.toBeInstanceOf(TableError)
    await db.destroy()
  })
})
