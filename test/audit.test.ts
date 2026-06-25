import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { requireContext } from '../src/commands/_shared'
import { createContext, deleteContext, searchContexts } from '../src/core/contexts'
import { LINK_TYPES } from '../src/core/types'
import { addLink, backlinks, createPage, lint, outboundLinks, updatePage } from '../src/core/wiki'
import { applyManagedBlock } from '../src/export/managed'
import { selectContexts } from '../src/export/select'
import { runExport } from '../src/export/write'
import { stringifyFrontmatter } from '../src/lib/frontmatter'
import { readSkillDir } from '../src/skillbundles/parse'
import { applyImport } from '../src/sync/import'
import { exportWiki } from '../src/wiki/export'
import { freshDb } from './_db'

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'bctx-audit-'))
}

describe('audit fixes', () => {
  it('C2: creating a page resolves pre-existing wanted links', async () => {
    const db = await freshDb()
    const a = await createPage(db, { title: 'A', pageType: 'concept', body: 'see [[Beta]]' })
    expect((await lint(db)).findings.some((f) => f.kind === 'wanted' && f.title === 'Beta')).toBe(
      true,
    )

    const beta = await createPage(db, { title: 'Beta', pageType: 'entity', body: '' })
    const report = await lint(db)
    expect(report.findings.some((f) => f.kind === 'wanted')).toBe(false)
    expect((await backlinks(db, beta.id)).some((b) => b.pageId === a.id)).toBe(true)
    expect(report.findings.some((f) => f.kind === 'orphan' && f.pageId === beta.id)).toBe(false)
    await db.destroy()
  })

  it('C3: search tolerates FTS-special input instead of throwing', async () => {
    const db = await freshDb()
    await createContext(db, { body: 'using C++ and a:b syntax', kind: 'note' })
    expect((await searchContexts(db, 'syntax')).length).toBe(1)
    await expect(searchContexts(db, 'C++')).resolves.toEqual(expect.any(Array))
    await expect(searchContexts(db, '(C++ OR')).resolves.toEqual(expect.any(Array))
    await db.destroy()
  })

  it('C4: managed block preserves $ patterns and stays idempotent', () => {
    const body = 'cost $5, also $& and $1 and $$ tokens'
    const once = applyManagedBlock('', body)
    expect(once).toContain(body)
    expect(applyManagedBlock(once, body)).toBe(once)
  })

  it('C7: wiki export removes files for deleted pages', async () => {
    const db = await freshDb()
    const a = await createPage(db, { title: 'Alpha', pageType: 'concept', body: 'a' })
    const dir = tmp()
    await exportWiki(db, dir)
    expect(existsSync(join(dir, 'alpha.md'))).toBe(true)
    await deleteContext(db, a.id)
    await exportWiki(db, dir)
    expect(existsSync(join(dir, 'alpha.md'))).toBe(false)
    rmSync(dir, { recursive: true, force: true })
    await db.destroy()
  })

  it('C10: a crafted slug is sanitized (no path separators)', async () => {
    const db = await freshDb()
    const p = await createPage(db, {
      title: 'X',
      pageType: 'concept',
      body: '',
      slug: '../../etc/evil',
    })
    expect(p.slug).not.toMatch(/[/\\]/)
    expect(p.slug).not.toContain('..')
    await db.destroy()
  })

  it('C11: skill parse never follows symlinks (no exfiltration)', () => {
    const base = tmp()
    const dir = join(base, 'demo-skill')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: demo-skill\ndescription: d\n---\nbody\n')
    const secret = join(base, 'secret.txt')
    writeFileSync(secret, 'TOPSECRET')
    symlinkSync(secret, join(dir, 'leak.txt'))

    const parsed = readSkillDir(dir)
    expect(parsed.files.some((f) => f.relPath === 'leak.txt')).toBe(false)
    expect(parsed.files.some((f) => f.content.toString().includes('TOPSECRET'))).toBe(false)
    rmSync(base, { recursive: true, force: true })
  })

  it('H3: explicit links survive body re-sync; `references` is reserved', async () => {
    const db = await freshDb()
    const a = await createPage(db, { title: 'A', pageType: 'concept', body: '' })
    const b = await createPage(db, { title: 'B', pageType: 'concept', body: '' })
    await addLink(db, a.id, { toId: b.id, type: 'relates' })
    await updatePage(db, a.id, { body: 'now [[B]]' })

    const out = await outboundLinks(db, a.id)
    expect(out.some((l) => l.type === 'relates' && l.pageId === b.id)).toBe(true)
    expect(out.some((l) => l.type === 'references' && l.pageId === b.id)).toBe(true)
    expect((LINK_TYPES as readonly string[]).includes('references')).toBe(false)
    await db.destroy()
  })

  it('C1/H1: by-id context surfaces reject wiki pages', async () => {
    const db = await freshDb()
    const page = await createPage(db, { title: 'P', pageType: 'concept', body: '' })
    await expect(requireContext(db, page.id)).rejects.toThrow(/wiki page/)
    const note = await createContext(db, { body: 'n', kind: 'note' })
    expect((await requireContext(db, note.id))?.id).toBe(note.id)
    await db.destroy()
  })

  it('M3: search honors includeDeleted', async () => {
    const db = await freshDb()
    const c = await createContext(db, { body: 'findme zzz', kind: 'note' })
    await deleteContext(db, c.id)
    expect((await searchContexts(db, 'zzz')).length).toBe(0)
    expect((await searchContexts(db, 'zzz', { includeDeleted: true })).length).toBe(1)
    await db.destroy()
  })

  it('M5: import skips a file whose context was soft-deleted', async () => {
    const db = await freshDb()
    const c = await createContext(db, { body: 'x', kind: 'note', title: 'X', namespace: 'ns' })
    const dir = tmp()
    runExport(await selectContexts(db, { namespace: 'ns' }), { outDir: dir, targets: ['store'] })
    await deleteContext(db, c.id)
    const { result } = await applyImport(db, dir)
    expect(result.skipped).toBe(1)
    expect(result.updated).toBe(0)
    rmSync(dir, { recursive: true, force: true })
    await db.destroy()
  })

  it('C5/C6: --prune is refused without a manifest, allowed with --namespace', async () => {
    const db = await freshDb()
    const dir = tmp()
    writeFileSync(
      join(dir, 'a.md'),
      stringifyFrontmatter({ kind: 'note', namespace: 'global', title: 'A' }, 'a\n'),
    )
    await expect(applyImport(db, dir, { prune: true })).rejects.toThrow(/Cannot --prune/)
    const ok = await applyImport(db, dir, { prune: true, pruneNamespace: 'global' })
    expect(ok.result.created).toBe(1)
    rmSync(dir, { recursive: true, force: true })
    await db.destroy()
  })
})
