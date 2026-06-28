import { describe, expect, it } from 'vitest'
import type { Context } from '../studio/src/api/types'
import { buildPageTree, type TreeFolder } from '../studio/src/lib/tree'

/** Minimal Context factory — only the fields buildPageTree reads matter. */
function p(title: string | null, id = title ?? 'root'): Context {
  return {
    id,
    namespace: 'default',
    title,
    body: '',
    kind: 'note',
    scope: 'project',
    agentSource: null,
    metadata: {},
    pageType: 'entity',
    slug: null,
    tags: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
  } as Context
}

function folder(root: TreeFolder, ...path: string[]): TreeFolder | undefined {
  let f: TreeFolder | undefined = root
  for (const seg of path) f = f?.folders.find((c) => c.name === seg)
  return f
}

describe('buildPageTree', () => {
  it('nests folders from slash-delimited titles and keeps the filename as the leaf', () => {
    const root = buildPageTree([
      p('docs/prospecting/slep/informe-valle'),
      p('docs/prospecting/slep/informe-tamarugal'),
      p('docs/ventas-analysis/flujo-venta'),
    ])
    const slep = folder(root, 'docs', 'prospecting', 'slep')
    expect(slep?.files.map((f) => f.name)).toEqual(['informe-tamarugal', 'informe-valle'])
    expect(folder(root, 'docs', 'ventas-analysis')?.files.map((f) => f.name)).toEqual([
      'flujo-venta',
    ])
    // path is the full slash chain
    expect(slep?.path).toBe('docs/prospecting/slep')
  })

  it('sorts folders and files alphabetically', () => {
    const root = buildPageTree([p('b/zeta'), p('b/alpha'), p('a/x')])
    expect(root.folders.map((f) => f.name)).toEqual(['a', 'b'])
    expect(folder(root, 'b')?.files.map((f) => f.name)).toEqual(['alpha', 'zeta'])
  })

  it('counts all descendant files at each folder', () => {
    const root = buildPageTree([p('docs/a/1'), p('docs/a/2'), p('docs/b/3'), p('top')])
    expect(root.count).toBe(4)
    expect(folder(root, 'docs')?.count).toBe(3)
    expect(folder(root, 'docs', 'a')?.count).toBe(2)
    expect(folder(root, 'docs', 'b')?.count).toBe(1)
  })

  it('puts no-slash titles at the root', () => {
    const root = buildPageTree([p('Untitled 1'), p('docs/x')])
    expect(root.files.map((f) => f.name)).toEqual(['Untitled 1'])
    expect(root.folders.map((f) => f.name)).toEqual(['docs'])
  })

  it('falls back to "Untitled" for null/blank/all-slash titles', () => {
    const root = buildPageTree([p(null, 'a'), p('   ', 'b'), p('//', 'c')])
    expect(root.files.map((f) => f.name)).toEqual(['Untitled', 'Untitled', 'Untitled'])
    expect(root.count).toBe(3)
  })

  it('lets a name be both a folder and a file', () => {
    const root = buildPageTree([p('docs'), p('docs/intro')])
    expect(root.files.map((f) => f.name)).toEqual(['docs'])
    expect(folder(root, 'docs')?.files.map((f) => f.name)).toEqual(['intro'])
  })

  it('keeps duplicate full paths as distinct files (keyed by page id)', () => {
    const root = buildPageTree([p('docs/dup', 'id1'), p('docs/dup', 'id2')])
    const files = folder(root, 'docs')?.files ?? []
    expect(files).toHaveLength(2)
    expect(files.map((f) => f.page.id).sort()).toEqual(['id1', 'id2'])
  })
})
