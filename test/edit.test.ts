import { describe, expect, it } from 'vitest'
import { RevConflictError } from '../src/core/contexts'
import { EditError, editPage, getPageSection, patchPageSection } from '../src/core/edit'
import { createPage, outboundLinks, searchPages } from '../src/core/wiki'
import { freshDb } from './_db'

const BODY = [
  '# Gateway',
  '',
  'Intro paragraph mentioning [[OAuth2]].',
  '',
  '## Config',
  'The timeout is 30s.',
  '',
  '## Limits',
  'Max 100 rps.',
].join('\n')

async function page(db: Awaited<ReturnType<typeof freshDb>>) {
  return createPage(db, { title: 'Gateway', pageType: 'entity', body: BODY })
}

describe('core/edit — section read/patch', () => {
  it('reads a single section (text + rev) without the whole body', async () => {
    const db = await freshDb()
    const p = await page(db)
    const view = await getPageSection(db, p.id, 'Config')
    expect(view.text).toBe('## Config\nThe timeout is 30s.\n')
    expect(view.rev).toBe(p.rev)
    await db.destroy()
  })

  it('patches one section through updatePage (others intact, FTS updated)', async () => {
    const db = await freshDb()
    const p = await page(db)
    const updated = await patchPageSection(db, p.id, 'Config', '## Config\nThe timeout is 60s.')
    expect(updated.body).toContain('The timeout is 60s.')
    expect(updated.body).not.toContain('30s')
    expect(updated.body).toContain('Max 100 rps.') // sibling untouched
    expect(updated.rev).not.toBe(p.rev)

    const hits = await searchPages(db, '60s')
    expect(hits.map((h) => h.id)).toContain(p.id)
    await db.destroy()
  })

  it('refuses a missing or ambiguous heading (never a wrong-place edit)', async () => {
    const db = await freshDb()
    const p = await page(db)
    await expect(patchPageSection(db, p.id, 'Nope', 'x')).rejects.toBeInstanceOf(EditError)
    const dup = await createPage(db, {
      title: 'Dup',
      pageType: 'concept',
      body: '## A\n1\n## A\n2',
    })
    await expect(getPageSection(db, dup.id, 'A')).rejects.toBeInstanceOf(EditError)
    await db.destroy()
  })

  it('re-syncs links when a patched section changes [[refs]]', async () => {
    const db = await freshDb()
    const p = await page(db)
    await patchPageSection(db, p.id, 'Limits', '## Limits\nSee [[Rate Limiting]].')
    const links = await outboundLinks(db, p.id)
    expect(links.some((l) => l.title === 'Rate Limiting')).toBe(true)
    await db.destroy()
  })

  it('honors ifRev compare-and-swap on a section patch', async () => {
    const db = await freshDb()
    const p = await page(db)
    await patchPageSection(db, p.id, 'Config', '## Config\nchanged.')
    await expect(
      patchPageSection(db, p.id, 'Limits', '## Limits\nx', { ifRev: p.rev }),
    ).rejects.toBeInstanceOf(RevConflictError)
    await db.destroy()
  })
})

describe('core/edit — anchored find/replace', () => {
  it('replaces a unique exact match', async () => {
    const db = await freshDb()
    const p = await page(db)
    const updated = await editPage(db, p.id, 'Max 100 rps.', 'Max 250 rps.')
    expect(updated.body).toContain('Max 250 rps.')
    await db.destroy()
  })

  it('refuses when find is absent (no silent no-op)', async () => {
    const db = await freshDb()
    const p = await page(db)
    await expect(editPage(db, p.id, 'not present', 'x')).rejects.toBeInstanceOf(EditError)
    await db.destroy()
  })

  it('refuses an ambiguous match, then targets it with occurrence', async () => {
    const db = await freshDb()
    const p = await createPage(db, { title: 'Dupes', pageType: 'concept', body: 'x y x y x' })
    await expect(editPage(db, p.id, 'x', 'z')).rejects.toBeInstanceOf(EditError)
    const updated = await editPage(db, p.id, 'x', 'z', { occurrence: 2 })
    expect(updated.body).toBe('x y z y x')
    await db.destroy()
  })

  it('honors ifRev on a replace', async () => {
    const db = await freshDb()
    const p = await page(db)
    await editPage(db, p.id, '30s', '45s')
    await expect(editPage(db, p.id, '100 rps', '200 rps', { ifRev: p.rev })).rejects.toBeInstanceOf(
      RevConflictError,
    )
    await db.destroy()
  })
})
