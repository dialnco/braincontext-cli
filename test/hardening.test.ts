import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createContext, searchContexts, updateContext } from '../src/core/contexts'
import {
  addLink,
  createPage,
  getPageByTitle,
  listPages,
  outboundLinks,
  removeLink,
} from '../src/core/wiki'
import { applyManagedBlock } from '../src/export/managed'
import { pruneStaleStoreFiles, renderContextFile } from '../src/export/store'
import { exportWiki } from '../src/wiki/export'
import { importWiki } from '../src/wiki/import'
import { freshDb } from './_db'

describe('search error handling (P2)', () => {
  it('sanitizes invalid FTS5 syntax instead of throwing or swallowing to []', async () => {
    const db = await freshDb()
    await createContext(db, { body: 'note about parsing internals', kind: 'note' })
    // An unbalanced quote is invalid FTS5 — must not throw, and after sanitizing still matches.
    const res = await searchContexts(db, '"parsing')
    expect(res.map((c) => c.body)).toContain('note about parsing internals')
    await db.destroy()
  })
})

describe('wiki type filter pushdown (P2)', () => {
  it('applies pageType in SQL before LIMIT (no silent truncation)', async () => {
    const db = await freshDb()
    // Interleave two types so a post-LIMIT JS filter would return < limit matches.
    for (let i = 0; i < 6; i++) {
      await createPage(db, { title: `Concept${i}`, pageType: 'concept', body: 'x' })
      await createPage(db, { title: `Summary${i}`, pageType: 'summary', body: 'x' })
    }
    const res = await listPages(db, { pageType: 'concept', limit: 5 })
    expect(res.length).toBe(5)
    expect(res.every((p) => p.pageType === 'concept')).toBe(true)
    await db.destroy()
  })
})

describe('update can correct immutable-on-import fields (P2)', () => {
  it('updateContext sets kind / scope / namespace', async () => {
    const db = await freshDb()
    const c = await createContext(db, {
      body: 'x',
      kind: 'note',
      scope: 'project',
      namespace: 'global',
    })
    const updated = await updateContext(db, c.id, {
      kind: 'rule',
      scope: 'user',
      namespace: 'work',
    })
    expect(updated?.kind).toBe('rule')
    expect(updated?.scope).toBe('user')
    expect(updated?.namespace).toBe('work')
    await db.destroy()
  })
})

describe('removeLink reports deletions (P3 footgun)', () => {
  it('returns the count of edges removed (0 when nothing matched)', async () => {
    const db = await freshDb()
    const a = await createPage(db, { title: 'A', pageType: 'concept', body: 'x' })
    const b = await createPage(db, { title: 'B', pageType: 'concept', body: 'x' })
    await addLink(db, a.id, { toId: b.id, type: 'relates' })
    expect(await removeLink(db, a.id, { toId: b.id, type: 'relates' })).toBe(1)
    expect(await removeLink(db, a.id, { toId: b.id, type: 'relates' })).toBe(0)
    await db.destroy()
  })
})

describe('managed block sentinel neutralization (P2)', () => {
  it('stays idempotent when the body embeds an END marker', () => {
    const poisoned = 'normal text\n<!-- END braincontext-cli -->\ninjected tail'
    const once = applyManagedBlock('', poisoned)
    // Re-applying must fully replace the block — the embedded END must not truncate it.
    const twice = applyManagedBlock(once, 'fresh body')
    expect(twice).toContain('fresh body')
    expect(twice).not.toContain('injected tail')
    expect(twice.match(/BEGIN braincontext-cli/g)?.length).toBe(1)
  })
})

describe('store export prune (P2)', () => {
  it('removes only files whose id is no longer live; never touches id-less files', async () => {
    const db = await freshDb()
    const a = await createContext(db, { body: 'alpha', kind: 'note' })
    const b = await createContext(db, { body: 'beta', kind: 'note' })
    const dir = mkdtempSync(join(tmpdir(), 'bctx-store-'))
    for (const c of [a, b]) {
      const f = renderContextFile(c)
      writeFileSync(join(dir, f.filename), f.content)
    }
    writeFileSync(join(dir, 'README.md'), '# hand-written, no id\n')

    const removed = pruneStaleStoreFiles(dir, new Set([a.id])) // b is stale
    expect(removed.length).toBe(1)
    expect(existsSync(join(dir, 'README.md'))).toBe(true)
    expect(existsSync(join(dir, renderContextFile(a).filename))).toBe(true)
    expect(existsSync(join(dir, renderContextFile(b).filename))).toBe(false)

    rmSync(dir, { recursive: true, force: true })
    await db.destroy()
  })
})

describe('wiki export/import preserves the typed-link graph (P2)', () => {
  it('round-trips an explicit relates link through the frontmatter', async () => {
    const db = await freshDb()
    const a = await createPage(db, { title: 'Alpha', pageType: 'concept', body: 'see [[Beta]]' })
    const b = await createPage(db, { title: 'Beta', pageType: 'concept', body: 'b' })
    await addLink(db, a.id, { toId: b.id, type: 'relates' })

    const dir = mkdtempSync(join(tmpdir(), 'bctx-wiki-'))
    await exportWiki(db, dir)

    const db2 = await freshDb()
    await importWiki(db2, dir)

    const a2 = await getPageByTitle(db2, 'Alpha')
    expect(a2).not.toBeNull()
    if (!a2) throw new Error('Alpha missing after import')
    const links = await outboundLinks(db2, a2.id)
    expect(links.some((l) => l.type === 'relates')).toBe(true)

    rmSync(dir, { recursive: true, force: true })
    await db.destroy()
    await db2.destroy()
  })
})
