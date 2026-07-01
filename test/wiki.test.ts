import { describe, expect, it } from 'vitest'
import { deleteContext } from '../src/core/contexts'
import {
  addLink,
  backlinks,
  createPage,
  getPageByTitle,
  outboundLinks,
  recordSource,
  resolvePageRef,
  updatePage,
} from '../src/core/wiki'
import { freshDb } from './_db'

describe('wiki pages & links', () => {
  it('creates a page with a unique slug and syncs [[links]] (resolved + wanted)', async () => {
    const db = await freshDb()
    const gw = await createPage(db, { title: 'Gateway', pageType: 'entity', body: 'edge service' })
    const oauth = await createPage(db, {
      title: 'OAuth2',
      pageType: 'concept',
      body: 'See [[Gateway]] and [[JWT]].',
    })
    expect(oauth.slug).toBe('oauth2')

    const refs = (await outboundLinks(db, oauth.id)).filter((l) => l.type === 'references')
    expect(refs.length).toBe(2)
    expect(refs.find((l) => !l.wanted)?.pageId).toBe(gw.id)
    expect(refs.find((l) => l.wanted)?.title).toBe('JWT')

    expect((await backlinks(db, gw.id)).some((b) => b.pageId === oauth.id)).toBe(true)
    await db.destroy()
  })

  it('suffixes slugs on collision', async () => {
    const db = await freshDb()
    const a = await createPage(db, { title: 'Cache', pageType: 'concept', body: '' })
    const b = await createPage(db, { title: 'Cache', pageType: 'concept', body: '' })
    expect(a.slug).toBe('cache')
    expect(b.slug).toBe('cache-2')
    await db.destroy()
  })

  it('refuses to update a source page (immutable)', async () => {
    const db = await freshDb()
    const s = await recordSource(db, { title: 'Doc', body: 'raw bytes' })
    await expect(updatePage(db, s.id, { body: 'x' })).rejects.toThrow(/immutable/)
    await db.destroy()
  })

  it('resolvePageRef resolves by id, slug, or title', async () => {
    const db = await freshDb()
    const page = await createPage(db, {
      title: 'Active Clients Roster',
      pageType: 'entity',
      body: 'x',
    })
    expect(page.slug).toBe('active-clients-roster')
    expect((await resolvePageRef(db, page.id))?.id).toBe(page.id)
    expect((await resolvePageRef(db, page.slug as string))?.id).toBe(page.id)
    expect((await resolvePageRef(db, 'Active Clients Roster'))?.id).toBe(page.id)
    expect(await resolvePageRef(db, 'no-such-ref')).toBeNull()
    await db.destroy()
  })

  it('resolvePageRef prefers an exact slug over a fuzzy title match', async () => {
    const db = await freshDb()
    // "gateway" the slug vs. "Gateway" the title on two different pages.
    const bySlug = await createPage(db, {
      title: 'Edge Service',
      pageType: 'entity',
      body: '',
      slug: 'gateway',
    })
    await createPage(db, { title: 'Gateway', pageType: 'entity', body: '' })
    expect(bySlug.slug).toBe('gateway')
    expect((await resolvePageRef(db, 'gateway'))?.id).toBe(bySlug.id)
    await db.destroy()
  })

  it('resolves titles case-insensitively, newest on collision', async () => {
    const db = await freshDb()
    await createPage(db, { title: 'Cache', pageType: 'concept', body: 'first' })
    const second = await createPage(db, { title: 'cache', pageType: 'concept', body: 'second' })
    expect((await getPageByTitle(db, 'CACHE'))?.id).toBe(second.id)
    await db.destroy()
  })

  it('dedups links and rejects self-links', async () => {
    const db = await freshDb()
    const a = await createPage(db, { title: 'A', pageType: 'concept', body: '' })
    const b = await createPage(db, { title: 'B', pageType: 'concept', body: '' })
    await addLink(db, a.id, { toId: b.id, type: 'relates' })
    await addLink(db, a.id, { toId: b.id, type: 'relates' })
    await addLink(db, a.id, { toId: a.id, type: 'relates' })
    expect((await outboundLinks(db, a.id)).filter((l) => l.type === 'relates').length).toBe(1)
    await db.destroy()
  })

  it('backlinks exclude soft-deleted sources', async () => {
    const db = await freshDb()
    const b = await createPage(db, { title: 'B', pageType: 'concept', body: '' })
    const a = await createPage(db, { title: 'A', pageType: 'concept', body: '[[B]]' })
    expect((await backlinks(db, b.id)).length).toBe(1)
    await deleteContext(db, a.id) // soft delete
    expect((await backlinks(db, b.id)).length).toBe(0)
    await db.destroy()
  })
})
