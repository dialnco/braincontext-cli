import { describe, expect, it } from 'vitest'
import {
  createPage,
  lint,
  pageFreshness,
  recordSource,
  updatePage,
  verifyPage,
} from '../src/core/wiki'
import { freshDb } from './_db'

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString()
}

describe('page freshness / verification', () => {
  it('verifyPage stamps verifiedAt/verifiedBy and logs the op', async () => {
    const db = await freshDb()
    const p = await createPage(db, { title: 'Gateway', pageType: 'entity', body: 'edge' })
    const v = await verifyPage(db, p.id, { agent: 'claude' })
    expect(v).not.toBeNull()
    const f = pageFreshness(v!)
    expect(f.state).toBe('verified')
    expect(f.verifiedBy).toBe('claude')
    expect(f.verifiedAt).toBeTruthy()

    const log = await db.selectFrom('wiki_log').selectAll().execute()
    expect(log.some((e) => e.op === 'verify' && e.ref_id === p.id)).toBe(true)
    await db.destroy()
  })

  it('refuses to verify an immutable source page', async () => {
    const db = await freshDb()
    const s = await recordSource(db, { title: 'Raw', body: 'raw text' })
    await expect(verifyPage(db, s.id)).rejects.toThrow(/immutable/)
    await db.destroy()
  })

  it('an edit after verification degrades the state back to unverified', async () => {
    const db = await freshDb()
    const p = await createPage(db, { title: 'Drifty', pageType: 'concept', body: 'v1' })
    const verified = await verifyPage(db, p.id)
    expect(pageFreshness(verified!).state).toBe('verified')
    // Simulate a later edit (verifiedAt stays behind updatedAt beyond the tolerance).
    const edited = await updatePage(db, p.id, { body: 'v2' })
    const f = pageFreshness({
      ...edited!,
      metadata: { ...edited!.metadata, verifiedAt: daysAgo(1) },
    })
    expect(f.state).toBe('unverified')
    await db.destroy()
  })

  it('freshness counts age from the most recent of verifiedAt/updatedAt', () => {
    // Never verified, untouched for 60d => stale.
    expect(pageFreshness({ metadata: {}, updatedAt: daysAgo(60) }).state).toBe('stale')
    // Never verified but recently updated => unverified, not stale.
    expect(pageFreshness({ metadata: {}, updatedAt: daysAgo(2) }).state).toBe('unverified')
    // Verified long ago but edited recently => fresh content, unverified claim.
    expect(
      pageFreshness({ metadata: { verifiedAt: daysAgo(90) }, updatedAt: daysAgo(2) }).state,
    ).toBe('unverified')
    // Custom stale window.
    expect(pageFreshness({ metadata: {}, updatedAt: daysAgo(10) }, { staleDays: 5 }).state).toBe(
      'stale',
    )
  })

  it('lint flags stale and never-verified pages, skipping sources and index', async () => {
    const db = await freshDb()
    const old = daysAgo(60)
    await createPage(db, {
      title: 'Forgotten',
      pageType: 'concept',
      body: 'old [[Anchor]]',
      createdAt: old,
      updatedAt: old,
    })
    await createPage(db, {
      title: 'Old but verified long ago',
      pageType: 'concept',
      body: 'aged',
      createdAt: old,
      updatedAt: old,
      metadata: { verifiedAt: old },
    })
    const fresh = await createPage(db, { title: 'Anchor', pageType: 'concept', body: 'new' })
    await createPage(db, {
      title: 'Old Source',
      pageType: 'source' as never,
      body: 'raw',
      createdAt: old,
      updatedAt: old,
    })

    const r = await lint(db)
    expect(r.findings.some((f) => f.kind === 'never-verified' && f.title === 'Forgotten')).toBe(
      true,
    )
    expect(
      r.findings.some((f) => f.kind === 'stale' && f.title === 'Old but verified long ago'),
    ).toBe(true)
    // Recent page and sources produce no freshness findings.
    expect(
      r.findings.some(
        (f) => (f.kind === 'stale' || f.kind === 'never-verified') && f.pageId === fresh.id,
      ),
    ).toBe(false)
    expect(
      r.findings.some(
        (f) => (f.kind === 'stale' || f.kind === 'never-verified') && f.title === 'Old Source',
      ),
    ).toBe(false)

    // Widening the window clears the freshness findings.
    const r2 = await lint(db, { staleDays: 365 })
    expect(r2.findings.some((f) => f.kind === 'stale' || f.kind === 'never-verified')).toBe(false)
    await db.destroy()
  })
})
