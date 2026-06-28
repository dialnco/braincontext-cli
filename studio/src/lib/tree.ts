/**
 * Build a nested folder tree from wiki page titles. Page titles are slash-delimited
 * paths (e.g. `docs/prospecting/slep/informe-slep`), so the last segment is the file
 * leaf and the preceding segments are nested folders. The sidebar renders this tree as
 * a collapsible file explorer. Kept pure (no DOM/React) so it's unit-testable.
 */
import type { Context } from '../api/types'

export interface TreeFile {
  kind: 'file'
  /** The last path segment — the filename shown in the tree. */
  name: string
  page: Context
}

export interface TreeFolder {
  kind: 'folder'
  /** This folder's own segment (`''` for the root). */
  name: string
  /** Full slash path from the root, e.g. `docs/prospecting` (`''` for the root). */
  path: string
  folders: TreeFolder[]
  files: TreeFile[]
  /** Total descendant files (pages) under this folder. */
  count: number
}

function emptyFolder(name: string, path: string): TreeFolder {
  return { kind: 'folder', name, path, folders: [], files: [], count: 0 }
}

function segmentsOf(title: string | null): string[] {
  return (title ?? '')
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Recursively alpha-sort folders/files and compute descendant counts. */
function finalize(folder: TreeFolder): number {
  folder.folders.sort((a, b) => a.name.localeCompare(b.name))
  folder.files.sort((a, b) => a.name.localeCompare(b.name))
  let count = folder.files.length
  for (const child of folder.folders) count += finalize(child)
  folder.count = count
  return count
}

/** Build the root folder of the page tree (root has name `''` and path `''`). */
export function buildPageTree(pages: Context[]): TreeFolder {
  const root = emptyFolder('', '')
  for (const page of pages) {
    const segments = segmentsOf(page.title)
    if (segments.length === 0) {
      // Null/blank/all-slash title: a root-level file with no usable name.
      root.files.push({ kind: 'file', name: 'Untitled', page })
      continue
    }
    const leaf = segments.pop()
    if (leaf === undefined) continue // unreachable after the length check; satisfies the type
    let folder = root
    for (const seg of segments) {
      let next = folder.folders.find((f) => f.name === seg)
      if (!next) {
        next = emptyFolder(seg, folder.path ? `${folder.path}/${seg}` : seg)
        folder.folders.push(next)
      }
      folder = next
    }
    folder.files.push({ kind: 'file', name: leaf, page })
  }
  finalize(root)
  return root
}
