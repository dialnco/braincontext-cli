import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDatatable, expandTransclusions } from '../src/core/datatable'
import { tableSetCell } from '../src/core/tables'
import { EMBEDS_LINK, REFERENCES_LINK } from '../src/core/types'
import { backlinks, createPage, getPageByTitle, outboundLinks } from '../src/core/wiki'
import { exportWiki } from '../src/wiki/export'
import { importWiki } from '../src/wiki/import'
import { freshDb } from './_db'

describe('transclusion — ![[Title]] embeds', () => {
  it('derives an embeds edge (not a references edge) and surfaces backlinks', async () => {
    const db = await freshDb()
    const dt = await createDatatable(db, {
      title: 'Providers',
      columns: ['Name', 'Status'],
      rows: [['Acme', 'active']],
    })
    const page = await createPage(db, {
      title: 'Overview',
      pageType: 'summary',
      body: 'The providers we support:\n\n![[Providers]]\n\nSee also [[Providers]] for edits.',
    })

    const out = await outboundLinks(db, page.id)
    const embed = out.find((l) => l.type === EMBEDS_LINK)
    expect(embed?.pageId).toBe(dt.id)
    // The same title also appears as a plain [[Providers]] reference — distinct channel.
    expect(out.some((l) => l.type === REFERENCES_LINK && l.pageId === dt.id)).toBe(true)

    // The datatable sees the consumer as an inbound embed (edit-once, reflect-everywhere).
    const back = await backlinks(db, dt.id)
    expect(back.some((l) => l.type === EMBEDS_LINK && l.pageId === page.id)).toBe(true)
    await db.destroy()
  })

  it('inlines the embedded datatable body on read, and re-renders when it changes', async () => {
    const db = await freshDb()
    await createDatatable(db, {
      title: 'Providers',
      columns: ['Name', 'Status'],
      rows: [['Acme', 'active']],
    })
    const page = await createPage(db, {
      title: 'Overview',
      pageType: 'summary',
      body: 'Providers:\n\n![[Providers]]',
    })

    const first = await expandTransclusions(db, page.body)
    expect(first).toContain('| Acme | active |')
    expect(first).not.toContain('![[Providers]]') // resolved embeds are replaced

    // Edit the datatable ONCE; the consumer's rendered view reflects it (no edit to the page).
    const dt = await getPageByTitle(db, 'Providers')
    if (!dt) throw new Error('datatable missing')
    await tableSetCell(db, dt.id, {}, 'Acme', 'Status', 'paused')
    const second = await expandTransclusions(db, page.body)
    expect(second).toContain('| Acme | paused |')
    await db.destroy()
  })

  it('leaves an unresolved ![[Title]] verbatim (a wanted embed)', async () => {
    const db = await freshDb()
    const out = await expandTransclusions(db, 'nothing here yet ![[Missing Table]]')
    expect(out).toContain('![[Missing Table]]')
    await db.destroy()
  })

  it('round-trips a datatable + verbatim ![[Title]] through export/import', async () => {
    const db = await freshDb()
    await createDatatable(db, {
      title: 'Providers',
      columns: ['Name', 'Status'],
      rows: [['Acme', 'active']],
    })
    await createPage(db, {
      title: 'Overview',
      pageType: 'summary',
      body: 'Providers:\n\n![[Providers]]',
    })

    const dir = mkdtempSync(join(tmpdir(), 'bctx-embed-'))
    await exportWiki(db, dir)

    const db2 = await freshDb()
    await importWiki(db2, dir)

    const overview = await getPageByTitle(db2, 'Overview')
    if (!overview) throw new Error('Overview not imported')
    // The embed stays verbatim through export (Obsidian renders it) and re-derives its edge.
    expect(overview.body).toContain('![[Providers]]')
    const dt2 = await getPageByTitle(db2, 'Providers')
    expect(dt2?.pageType).toBe('datatable')
    const out = await outboundLinks(db2, overview.id)
    expect(out.some((l) => l.type === EMBEDS_LINK && l.pageId === dt2?.id)).toBe(true)

    rmSync(dir, { recursive: true, force: true })
    await db.destroy()
    await db2.destroy()
  })
})
