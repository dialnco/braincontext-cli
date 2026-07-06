import { sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import { queryPages } from '../src/core/query'
import { createPage, outboundLinks, recordSource, reindexWiki } from '../src/core/wiki'
import { freshDb } from './_db'

describe('core/reindexWiki — derived-state repair', () => {
  it('rebuilds the page_properties mirror from metadata (default, no link churn)', async () => {
    const db = await freshDb()
    const page = await createPage(db, {
      title: 'Prop',
      pageType: 'concept',
      body: 'see [[Other]]',
      metadata: { props: { status: 'active' } },
    })
    // Wipe the mirror to simulate a store that just gained the table via migration 0002.
    await sql`DELETE FROM page_properties`.execute(db)
    expect((await queryPages(db, { where: { status: 'active' } })).length).toBe(0)

    const r = await reindexWiki(db)
    expect(r.propsRebuilt).toBe(1)
    expect(r.linksResynced).toBe(false)
    expect((await queryPages(db, { where: { status: 'active' } })).map((p) => p.id)).toEqual([
      page.id,
    ])
    await db.destroy()
  })

  it('does NOT synthesize link edges on immutable source pages, even with --links', async () => {
    const db = await freshDb()
    // A source body full of [[..]]-like text that is NOT wiki links (code/docs).
    const src = await recordSource(db, {
      title: 'raw-source',
      body: 'bash: if [[ -f x ]]; then :; fi\nC++: [[nodiscard]]\nTOML: [[table]]',
    })
    const before = await outboundLinks(db, src.id)
    expect(before.filter((l) => l.type === 'references')).toEqual([]) // sources have none by design

    await reindexWiki(db, { links: true })

    const after = await outboundLinks(db, src.id)
    expect(after.filter((l) => l.type === 'references')).toEqual([]) // still none — not fabricated
    await db.destroy()
  })

  it('re-derives references for authored pages when --links is set', async () => {
    const db = await freshDb()
    const page = await createPage(db, { title: 'Author', pageType: 'concept', body: 'x' })
    // Corrupt the derived graph, then prove --links rebuilds it from the body.
    await sql`DELETE FROM links WHERE from_id = ${page.id}`.execute(db)
    await createPage(db, { title: 'Target', pageType: 'concept', body: 'see [[Author]]' })
    // Author now has a body without links; give it one and reindex.
    await sql`UPDATE contexts SET body = 'links to [[Target]]' WHERE id = ${page.id}`.execute(db)

    await reindexWiki(db, { links: true })
    const links = await outboundLinks(db, page.id)
    expect(links.some((l) => l.title === 'Target')).toBe(true)
    await db.destroy()
  })
})
