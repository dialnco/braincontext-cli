import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createPage, getPageByTitle, listPages, outboundLinks } from '../src/core/wiki'
import { exportWiki } from '../src/wiki/export'
import { importWiki } from '../src/wiki/import'
import { freshDb } from './_db'

describe('wiki export/import round-trip', () => {
  it('preserves pages and resolved links into a fresh store', async () => {
    const db = await freshDb()
    await createPage(db, { title: 'Gateway', pageType: 'entity', body: 'edge service' })
    await createPage(db, { title: 'OAuth2', pageType: 'concept', body: 'See [[Gateway]].' })
    const out = mkdtempSync(join(tmpdir(), 'bctx-wiki-'))
    const result = await exportWiki(db, out)
    expect(result.files).toContain('index.md')
    expect(result.files).toContain('log.md')

    const db2 = await freshDb()
    const r = await importWiki(db2, out)
    expect(r.created).toBe(2)
    expect((await listPages(db2)).length).toBe(2)

    const oauth = await getPageByTitle(db2, 'OAuth2')
    if (!oauth) throw new Error('OAuth2 not imported')
    const links = await outboundLinks(db2, oauth.id)
    expect(links.some((l) => l.title === 'Gateway' && !l.wanted)).toBe(true)

    rmSync(out, { recursive: true, force: true })
    await db.destroy()
    await db2.destroy()
  })
})
