import { mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createContext, getContext, listContexts } from '../src/core/contexts'
import { createPage, getPageByTitle } from '../src/core/wiki'
import { selectContexts } from '../src/export/select'
import { runExport } from '../src/export/write'
import { parseFrontmatter, stringifyFrontmatter } from '../src/lib/frontmatter'
import { applyImport, writeExportManifest } from '../src/sync/import'
import { freshDb } from './_db'

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'bctx-store-'))
}
function fileFor(dir: string, id: string): string | undefined {
  return readdirSync(dir).find((f) => {
    if (!f.endsWith('.md')) return false
    return parseFrontmatter(readFileSync(join(dir, f), 'utf8')).data.id === id
  })
}

describe('store round-trip (manual markdown <-> db sync)', () => {
  it('export --targets store -> import recreates contexts (id honored)', async () => {
    const db = await freshDb()
    const c = await createContext(db, {
      body: 'Use pnpm',
      kind: 'rule',
      title: 'Pkg',
      tags: ['tooling', 'policy'],
      namespace: 'proj',
      agentSource: 'claude',
    })
    const dir = tmp()
    runExport(await selectContexts(db, {}), { outDir: dir, targets: ['store'] })

    const db2 = await freshDb()
    const { result } = await applyImport(db2, dir)
    expect(result.created).toBe(1)
    const got = await getContext(db2, c.id) // same id honored
    expect(got?.body).toBe('Use pnpm')
    expect(got?.kind).toBe('rule')
    expect(got?.tags.slice().sort()).toEqual(['policy', 'tooling'])

    rmSync(dir, { recursive: true, force: true })
    await db.destroy()
    await db2.destroy()
  })

  it('syncs edited body + tags back (matched by id); dry-run writes nothing', async () => {
    const db = await freshDb()
    const c = await createContext(db, { body: 'old', kind: 'note', title: 'T', tags: ['a', 'b'] })
    const dir = tmp()
    runExport(await selectContexts(db, {}), { outDir: dir, targets: ['store'] })

    const file = fileFor(dir, c.id)
    if (!file) throw new Error('exported file not found')
    const { data } = parseFrontmatter(readFileSync(join(dir, file), 'utf8'))
    writeFileSync(join(dir, file), stringifyFrontmatter({ ...data, tags: ['a', 'c'] }, 'new\n'))

    const dry = await applyImport(db, dir, { dryRun: true })
    expect(dry.result.updated).toBe(1)
    expect((await getContext(db, c.id))?.body).toBe('old') // dry-run untouched

    const { result } = await applyImport(db, dir)
    expect(result.updated).toBe(1)
    const after = await getContext(db, c.id)
    expect(after?.body).toBe('new')
    expect(after?.tags.slice().sort()).toEqual(['a', 'c'])

    rmSync(dir, { recursive: true, force: true })
    await db.destroy()
  })

  it('creates a context from a new file with no id', async () => {
    const db = await freshDb()
    const dir = tmp()
    writeFileSync(
      join(dir, 'fresh.md'),
      stringifyFrontmatter({ kind: 'note', namespace: 'global', title: 'Fresh' }, 'brand new\n'),
    )
    const { result } = await applyImport(db, dir)
    expect(result.created).toBe(1)
    expect(
      (await listContexts(db)).some((c) => c.title === 'Fresh' && c.body.trim() === 'brand new'),
    ).toBe(true)
    rmSync(dir, { recursive: true, force: true })
    await db.destroy()
  })

  it('prune is namespace-scoped: keeps by default, removes only missing in seen namespaces', async () => {
    const db = await freshDb()
    const a = await createContext(db, { body: 'a', kind: 'note', title: 'A', namespace: 'proj' })
    const b = await createContext(db, { body: 'b', kind: 'note', title: 'B', namespace: 'proj' })
    const other = await createContext(db, {
      body: 'o',
      kind: 'note',
      title: 'O',
      namespace: 'other',
    })

    const dir = tmp()
    runExport(await selectContexts(db, { namespace: 'proj' }), { outDir: dir, targets: ['store'] })
    writeExportManifest(dir, { namespace: 'proj' }) // what `export --targets store` records
    const bFile = fileFor(dir, b.id)
    if (!bFile) throw new Error('B file not found')
    unlinkSync(join(dir, bFile))

    const keep = await applyImport(db, dir)
    expect(keep.result.missing).toBe(1)
    expect(keep.result.pruned).toBe(0)
    expect((await getContext(db, b.id))?.deletedAt).toBeNull()

    const prune = await applyImport(db, dir, { prune: true })
    expect(prune.result.pruned).toBe(1)
    expect((await getContext(db, b.id))?.deletedAt).toBeTruthy()
    expect((await getContext(db, a.id))?.deletedAt).toBeNull()
    expect((await getContext(db, other.id))?.deletedAt).toBeNull() // other namespace untouched

    rmSync(dir, { recursive: true, force: true })
    await db.destroy()
  })

  it('store export excludes wiki pages; import skips ids resolving to wiki pages', async () => {
    const db = await freshDb()
    await createContext(db, { body: 'note', kind: 'note', title: 'N' })
    await createPage(db, { title: 'WikiPage', pageType: 'concept', body: 'page body' })

    const items = await selectContexts(db, {})
    expect(items.length).toBe(1) // wiki excluded from selection
    const dir = tmp()
    runExport(items, { outDir: dir, targets: ['store'] })
    expect(readdirSync(dir).filter((f) => f.endsWith('.md')).length).toBe(1)

    const wikiPage = await getPageByTitle(db, 'WikiPage')
    if (!wikiPage) throw new Error('wiki page missing')
    writeFileSync(
      join(dir, 'wiki.md'),
      stringifyFrontmatter(
        { id: wikiPage.id, kind: 'note', namespace: 'wiki', title: 'WikiPage' },
        'hacked\n',
      ),
    )
    const { result } = await applyImport(db, dir)
    expect(result.skipped).toBe(1)
    expect((await getPageByTitle(db, 'WikiPage'))?.body).toBe('page body') // untouched

    rmSync(dir, { recursive: true, force: true })
    await db.destroy()
  })
})
