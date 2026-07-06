import { describe, expect, it } from 'vitest'
import { expandTransclusions } from '../src/core/datatable'
import { extractTableToDatatable, TableError, tableGet } from '../src/core/tables'
import { EMBEDS_LINK } from '../src/core/types'
import { createPage, outboundLinks, recordSource, searchPages } from '../src/core/wiki'
import { freshDb } from './_db'

const BODY = [
  '# Roster',
  '',
  'Intro prose about the [[CRM]].',
  '',
  '## Data',
  '',
  '| Name | Status |',
  '| :--- | ---: |',
  '| Acme | active |',
  '| Beta | paused |',
  '',
  'Closing note.',
].join('\n')

describe('core/extractTableToDatatable', () => {
  it('extracts a table into a datatable page + leaves a ![[embed]], preserving prose', async () => {
    const db = await freshDb()
    const page = await createPage(db, { title: 'Roster Page', pageType: 'summary', body: BODY })

    const { datatable, page: updated } = await extractTableToDatatable(
      db,
      page.id,
      {},
      {
        title: 'Roster Data',
      },
    )

    // The datatable holds the table VERBATIM (alignment row preserved).
    expect(datatable.pageType).toBe('datatable')
    expect(datatable.body).toBe(
      ['| Name | Status |', '| :--- | ---: |', '| Acme | active |', '| Beta | paused |'].join('\n'),
    )

    // The source keeps its prose + heading, with the embed where the table was.
    expect(updated.body).toContain('Intro prose about the [[CRM]].')
    expect(updated.body).toContain('## Data')
    expect(updated.body).toContain('![[Roster Data]]')
    expect(updated.body).toContain('Closing note.')
    expect(updated.body).not.toContain('| Acme | active |') // table no longer inline

    // The embed derives an `embeds` edge to the datatable.
    const links = await outboundLinks(db, updated.id)
    expect(links.some((l) => l.type === EMBEDS_LINK && l.pageId === datatable.id)).toBe(true)

    // Reads identically: expanding the embed reproduces the table in place.
    const expanded = await expandTransclusions(db, updated.body)
    expect(expanded).toContain('| Acme | active |')
    expect(expanded).toContain('Intro prose about the [[CRM]].')

    // The datatable is now a first-class table (cell-addressable) + full-text searchable.
    const view = await tableGet(db, datatable.id, {})
    expect(view.header).toEqual(['Name', 'Status'])
    expect(view.alignments).toEqual(['left', 'right'])
    expect((await searchPages(db, 'paused')).map((p) => p.id)).toContain(datatable.id)
    await db.destroy()
  })

  it('refuses an immutable source page', async () => {
    const db = await freshDb()
    const src = await recordSource(db, {
      title: 'Src',
      body: '| a | b |\n| --- | --- |\n| 1 | 2 |',
    })
    await expect(extractTableToDatatable(db, src.id, {}, { title: 'X' })).rejects.toBeInstanceOf(
      TableError,
    )
    await db.destroy()
  })

  it('refuses a title collision (never clobbers an existing page)', async () => {
    const db = await freshDb()
    const page = await createPage(db, { title: 'P', pageType: 'concept', body: BODY })
    await createPage(db, { title: 'Taken', pageType: 'concept', body: 'x' })
    await expect(
      extractTableToDatatable(db, page.id, {}, { title: 'Taken' }),
    ).rejects.toBeInstanceOf(TableError)
    await db.destroy()
  })

  it('errors on an ambiguous locator instead of extracting the wrong table', async () => {
    const db = await freshDb()
    const body = ['## A', '| x |', '| --- |', '| 1 |', '## B', '| y |', '| --- |', '| 2 |'].join(
      '\n',
    )
    const page = await createPage(db, { title: 'Two', pageType: 'concept', body })
    await expect(extractTableToDatatable(db, page.id, {}, { title: 'T' })).rejects.toBeInstanceOf(
      TableError,
    )
    // A caption disambiguates and extracts exactly that table.
    const { datatable } = await extractTableToDatatable(
      db,
      page.id,
      { caption: 'B' },
      { title: 'T' },
    )
    expect(datatable.body).toContain('| y |')
    await db.destroy()
  })
})
