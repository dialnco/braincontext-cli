import { describe, expect, it } from 'vitest'
import { deleteContext } from '../src/core/contexts'
import { createPage, lint, recordSource } from '../src/core/wiki'
import { freshDb } from './_db'

describe('wiki lint', () => {
  it('flags orphan and wanted', async () => {
    const db = await freshDb()
    await createPage(db, { title: 'Lonely', pageType: 'concept', body: '' })
    await createPage(db, { title: 'A', pageType: 'concept', body: 'see [[Ghost]]' })
    const r = await lint(db)
    expect(r.findings.some((f) => f.kind === 'orphan' && f.title === 'Lonely')).toBe(true)
    expect(r.findings.some((f) => f.kind === 'wanted' && f.title === 'Ghost')).toBe(true)
    await db.destroy()
  })

  it('orphan check ignores inbound links from an index page', async () => {
    const db = await freshDb()
    const p = await createPage(db, { title: 'P', pageType: 'concept', body: '' })
    await createPage(db, { title: 'Catalog', pageType: 'index', body: '[[P]]' })
    const r = await lint(db)
    expect(r.findings.some((f) => f.kind === 'orphan' && f.pageId === p.id)).toBe(true)
    await db.destroy()
  })

  it('flags dangling links to soft-deleted pages', async () => {
    const db = await freshDb()
    const b = await createPage(db, { title: 'B', pageType: 'concept', body: '' })
    await createPage(db, { title: 'A', pageType: 'concept', body: '[[B]]' })
    await deleteContext(db, b.id)
    expect((await lint(db)).findings.some((f) => f.kind === 'dangling')).toBe(true)
    await db.destroy()
  })

  it('flags a source with no derived page', async () => {
    const db = await freshDb()
    await recordSource(db, { title: 'Src', body: 'raw' })
    expect((await lint(db)).findings.some((f) => f.kind === 'source-without-page')).toBe(true)
    await db.destroy()
  })
})
