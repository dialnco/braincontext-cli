import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { queryPages, renderView } from '../src/core/query'
import { createPage, createView, getPageByTitle } from '../src/core/wiki'
import { exportWiki } from '../src/wiki/export'
import { importWiki } from '../src/wiki/import'
import { freshDb } from './_db'

async function seed(db: Awaited<ReturnType<typeof freshDb>>) {
  await createPage(db, {
    title: 'Auth',
    pageType: 'concept',
    body: 'a',
    metadata: { props: { status: 'active', priority: 3, area: 'security' } },
  })
  await createPage(db, {
    title: 'Billing',
    pageType: 'concept',
    body: 'b',
    metadata: { props: { status: 'deprecated', priority: 1, area: 'payments' } },
  })
  await createPage(db, {
    title: 'Search',
    pageType: 'concept',
    body: 's',
    metadata: { props: { status: 'active', priority: 5, area: 'search' } },
  })
}

const titles = (pages: Awaited<ReturnType<typeof queryPages>>) => pages.map((p) => p.title).sort()

describe('core/query — predicate AST over page properties', () => {
  it('eq (scalar shorthand) and ne', async () => {
    const db = await freshDb()
    await seed(db)
    expect(titles(await queryPages(db, { where: { status: 'active' } }))).toEqual([
      'Auth',
      'Search',
    ])
    // ne matches pages without a `status = deprecated` row (incl. absent) — here the two actives.
    expect(titles(await queryPages(db, { where: { status: { ne: 'deprecated' } } }))).toEqual([
      'Auth',
      'Search',
    ])
    await db.destroy()
  })

  it('numeric lt/gt/lte/gte compare as numbers, not text', async () => {
    const db = await freshDb()
    await seed(db)
    // Textual comparison would put '5' < '3'? No — but '10' < '3' textually; use gte 3 to prove CAST.
    expect(titles(await queryPages(db, { where: { priority: { gte: 3 } } }))).toEqual([
      'Auth',
      'Search',
    ])
    expect(titles(await queryPages(db, { where: { priority: { lt: 3 } } }))).toEqual(['Billing'])
    await db.destroy()
  })

  it('in, contains, exists', async () => {
    const db = await freshDb()
    await seed(db)
    expect(
      titles(await queryPages(db, { where: { area: { in: ['security', 'search'] } } })),
    ).toEqual(['Auth', 'Search'])
    expect(titles(await queryPages(db, { where: { area: { contains: 'ear' } } }))).toEqual([
      'Search',
    ])
    // every seeded page has `status`, none has `missing`
    expect((await queryPages(db, { where: { status: { exists: true } } })).length).toBe(3)
    expect((await queryPages(db, { where: { missing: { exists: true } } })).length).toBe(0)
    await db.destroy()
  })

  it('ANDs multiple keys', async () => {
    const db = await freshDb()
    await seed(db)
    expect(
      titles(await queryPages(db, { where: { status: 'active', priority: { gt: 4 } } })),
    ).toEqual(['Search'])
    await db.destroy()
  })

  it('sorts numerically and by direction', async () => {
    const db = await freshDb()
    await seed(db)
    const asc = await queryPages(db, {
      where: { status: { exists: true } },
      sort: { key: 'priority', dir: 'asc', numeric: true },
    })
    expect(asc.map((p) => p.title)).toEqual(['Billing', 'Auth', 'Search'])
    await db.destroy()
  })
})

describe('core/query — saved views', () => {
  it('renders a live GFM table and re-reflects changes', async () => {
    const db = await freshDb()
    await seed(db)
    const view = await createView(db, {
      title: 'Active work',
      query: { where: { status: 'active' }, sort: { key: 'priority', dir: 'desc', numeric: true } },
      columns: ['priority', 'area'],
    })
    expect(view.pageType).toBe('view')
    const rendered = await renderView(db, view.metadata)
    expect(rendered).toContain('| Page | priority | area |')
    expect(rendered).toContain('[[Search]]')
    expect(rendered).toContain('[[Auth]]')
    expect(rendered).not.toContain('[[Billing]]') // deprecated, excluded
    // Search (priority 5) sorts above Auth (priority 3).
    expect(rendered.indexOf('[[Search]]')).toBeLessThan(rendered.indexOf('[[Auth]]'))
    await db.destroy()
  })

  it('round-trips props + view definition through export/import', async () => {
    const db = await freshDb()
    await seed(db)
    await createView(db, {
      title: 'Active work',
      query: { where: { status: 'active' } },
      columns: ['priority'],
    })

    const dir = mkdtempSync(join(tmpdir(), 'bctx-view-'))
    await exportWiki(db, dir)
    const db2 = await freshDb()
    await importWiki(db2, dir)

    // Properties re-derived from frontmatter → query still works in the fresh store.
    expect(titles(await queryPages(db2, { where: { status: 'active' } }))).toEqual([
      'Auth',
      'Search',
    ])
    // The view survives with its query, and renders live in the new store.
    const view = await getPageByTitle(db2, 'Active work')
    expect(view?.pageType).toBe('view')
    const rendered = await renderView(db2, view?.metadata ?? {})
    expect(rendered).toContain('[[Auth]]')
    expect(rendered).not.toContain('[[Billing]]')

    rmSync(dir, { recursive: true, force: true })
    await db.destroy()
    await db2.destroy()
  })
})
