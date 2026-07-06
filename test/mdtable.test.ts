import { describe, expect, it } from 'vitest'
import {
  addColumnData,
  addRowData,
  columnIndex,
  deleteColumnData,
  deleteRowData,
  parseTables,
  renameColumnData,
  replaceTableInBody,
  rowIndexByKey,
  serializeTable,
  setCellData,
  setColumnAlignData,
  type Table,
} from '../src/lib/mdtable'

/** Parse and return the first table, failing loudly (keeps strict indexed-access happy). */
function firstTable(md: string): Table {
  const t = parseTables(md)[0]
  if (!t) throw new Error('expected at least one table')
  return t
}

describe('mdtable — parse/serialize', () => {
  it('parses a table with alignment + heading and round-trips idempotently', () => {
    const md = [
      '## Providers',
      '',
      '| Name | Status | Tier |',
      '| :--- | :----: | ---: |',
      '| Acme | active | 2 |',
      '| Beta | deprecated | 3 |',
    ].join('\n')
    const t = firstTable(md)
    expect(t.headingAbove).toBe('Providers')
    expect(t.header).toEqual(['Name', 'Status', 'Tier'])
    expect(t.alignments).toEqual(['left', 'center', 'right'])
    expect(t.rows).toEqual([
      ['Acme', 'active', '2'],
      ['Beta', 'deprecated', '3'],
    ])
    // Re-serialize is stable (idempotent) even if source spacing differed.
    const once = serializeTable(t)
    expect(serializeTable(firstTable(once))).toBe(once)
    expect(once).toContain('| :--- | :--: | ---: |')
  })

  it('honors escaped pipes and rows without outer pipes', () => {
    const md = ['a | b', '--- | ---', 'x \\| y | z'].join('\n')
    const t = firstTable(md)
    expect(t.header).toEqual(['a', 'b'])
    expect(t.rows).toEqual([['x | y', 'z']])
    // The literal pipe survives a serialize round-trip (re-escaped).
    expect(serializeTable(t)).toContain('x \\| y')
  })

  it('does NOT parse a table inside a code fence', () => {
    const md = [
      'Prose.',
      '',
      '```md',
      '| not | a | table |',
      '| --- | --- | --- |',
      '| a | b | c |',
      '```',
      '',
      '| real | table |',
      '| --- | --- |',
      '| 1 | 2 |',
    ].join('\n')
    const tables = parseTables(md)
    expect(tables).toHaveLength(1)
    expect(firstTable(md).header).toEqual(['real', 'table'])
  })

  it('finds multiple tables under their headings', () => {
    const md = ['## One', '| a |', '| --- |', '| 1 |', '## Two', '| b |', '| --- |', '| 2 |'].join(
      '\n',
    )
    const tables = parseTables(md)
    expect(tables.map((t) => t.headingAbove)).toEqual(['One', 'Two'])
  })
})

describe('mdtable — splice mutations', () => {
  const md = ['| Name | Status |', '| --- | --- |', '| Acme | active |', '| Beta | old |'].join(
    '\n',
  )

  it('sets one cell, leaving the rest byte-identical', () => {
    const t = firstTable(md)
    const r = rowIndexByKey(t, 'Beta')
    const c = columnIndex(t, 'Status')
    const next = replaceTableInBody(md, t, setCellData(t, r, c, 'active'))
    expect(next).toContain('| Beta | active |')
    expect(next).not.toContain('| Beta | old |')
    expect(next).toContain('| Acme | active |') // untouched row preserved
  })

  it('resolves a column by header name or ordinal, row by key value', () => {
    const t = firstTable(md)
    expect(columnIndex(t, 'Status')).toBe(1)
    expect(columnIndex(t, '1')).toBe(1)
    expect(columnIndex(t, 'nope')).toBe(-1)
    expect(rowIndexByKey(t, 'acme')).toBe(0) // case-insensitive value match
    expect(rowIndexByKey(t, '1')).toBe(1) // ordinal fallback
  })

  it('adds and deletes rows', () => {
    const t = firstTable(md)
    const added = firstTable(replaceTableInBody(md, t, addRowData(t, ['Gamma', 'new'])))
    expect(added.rows).toHaveLength(3)
    expect(added.rows[2]).toEqual(['Gamma', 'new'])

    const t2 = firstTable(md)
    const deleted = firstTable(replaceTableInBody(md, t2, deleteRowData(t2, 1)))
    expect(deleted.rows).toEqual([['Acme', 'active']])
  })
})

describe('mdtable — column mutations', () => {
  const md = ['| Name | Status |', '| :--- | ---: |', '| Acme | active |', '| Beta | old |'].join(
    '\n',
  )

  it('appends a column, keeping header/alignments/rows rectangular', () => {
    const t = firstTable(md)
    const next = firstTable(
      replaceTableInBody(md, t, addColumnData(t, undefined, 'Owner', 'center')),
    )
    expect(next.header).toEqual(['Name', 'Status', 'Owner'])
    expect(next.alignments).toEqual(['left', 'right', 'center'])
    expect(next.rows).toEqual([
      ['Acme', 'active', ''],
      ['Beta', 'old', ''],
    ])
  })

  it('inserts a column at a position, shifting cells right (no silent reshape)', () => {
    const t = firstTable(md)
    const next = firstTable(replaceTableInBody(md, t, addColumnData(t, 1, 'Tier')))
    expect(next.header).toEqual(['Name', 'Tier', 'Status'])
    expect(next.alignments).toEqual(['left', null, 'right'])
    expect(next.rows).toEqual([
      ['Acme', '', 'active'],
      ['Beta', '', 'old'],
    ])
  })

  it('deletes a column from header + alignments + every row', () => {
    const t = firstTable(md)
    const next = firstTable(replaceTableInBody(md, t, deleteColumnData(t, 0)))
    expect(next.header).toEqual(['Status'])
    expect(next.alignments).toEqual(['right'])
    expect(next.rows).toEqual([['active'], ['old']])
  })

  it('renames a header and sets one column alignment', () => {
    const t = firstTable(md)
    const renamed = firstTable(replaceTableInBody(md, t, renameColumnData(t, 1, 'State')))
    expect(renamed.header).toEqual(['Name', 'State'])
    expect(renamed.rows).toEqual([
      ['Acme', 'active'],
      ['Beta', 'old'],
    ])
    const aligned = firstTable(replaceTableInBody(md, t, setColumnAlignData(t, 0, 'center')))
    expect(aligned.alignments).toEqual(['center', 'right'])
  })

  it('add→delete a column round-trips to the original table', () => {
    const t = firstTable(md)
    const added = replaceTableInBody(md, t, addColumnData(t, 1, 'Temp'))
    const back = replaceTableInBody(
      added,
      firstTable(added),
      deleteColumnData(firstTable(added), 1),
    )
    expect(back).toBe(md)
  })
})
