import { describe, expect, it } from 'vitest'
import { createContext, listContexts, searchContexts } from '../src/core/contexts'
import { createPage } from '../src/core/wiki'
import { selectContexts } from '../src/export/select'
import { freshDb } from './_db'

describe('wiki pages do not leak into legacy surfaces', () => {
  it('list / search / export exclude pages by default; pageScope=all includes them', async () => {
    const db = await freshDb()
    await createContext(db, { body: 'normal note about pnpm', kind: 'note' })
    await createPage(db, { title: 'WikiPnpm', pageType: 'concept', body: 'a page about pnpm' })

    expect((await listContexts(db)).length).toBe(1)
    expect((await listContexts(db, { pageScope: 'all' })).length).toBe(2)

    expect((await searchContexts(db, 'pnpm')).length).toBe(1)
    expect((await searchContexts(db, 'pnpm', { pageScope: 'all' })).length).toBe(2)

    // AGENTS.md export selection (selectContexts -> listContexts) excludes pages
    expect((await selectContexts(db, {})).length).toBe(1)
    await db.destroy()
  })
})
