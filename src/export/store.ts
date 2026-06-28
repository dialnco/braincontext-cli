import { readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '../core/contexts'
import { parseFrontmatter, stringifyFrontmatter } from '../lib/frontmatter'

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50) || 'context'
  )
}

/**
 * Render an identity-bearing, round-trippable markdown file for one context.
 * The `id` frontmatter is the match key for `bctx import` — the filename is only
 * a human-friendly hint.
 */
export function renderContextFile(c: Context): { filename: string; content: string } {
  const fm: Record<string, unknown> = {
    id: c.id,
    kind: c.kind,
    namespace: c.namespace,
    scope: c.scope,
  }
  if (c.title) fm.title = c.title
  if (c.tags.length > 0) fm.tags = c.tags
  if (c.agentSource) fm.agent = c.agentSource
  if (Object.keys(c.metadata).length > 0) fm.metadata = c.metadata
  fm.updated = c.updatedAt

  const body = c.body.endsWith('\n') ? c.body : `${c.body}\n`
  return { filename: `${slug(c.title ?? c.id)}.md`, content: stringifyFrontmatter(fm, body) }
}

/**
 * Remove stale `store` export files — those a prior export wrote (frontmatter `id`) whose
 * context is no longer live — so a deleted context can't resurrect on re-import. Scoped to
 * the same filters as this export (mirrors `import --prune`), so a partial export
 * (`--namespace`) never deletes another scope's files; files without an `id` (AGENTS.md,
 * README, wiki pages) are never touched. Returns the removed filenames.
 */
export function pruneStaleStoreFiles(
  dir: string,
  liveIds: Set<string>,
  filters: { namespace?: string; kind?: string; scope?: string } = {},
): string[] {
  const removed: string[] = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.md')) continue
    const path = join(dir, f)
    let data: Record<string, unknown>
    try {
      data = parseFrontmatter<Record<string, unknown>>(readFileSync(path, 'utf8')).data
    } catch {
      continue
    }
    const id = data.id
    if (typeof id !== 'string' || liveIds.has(id)) continue // not a store file, or still live
    if (filters.namespace && data.namespace !== filters.namespace) continue
    if (filters.kind && data.kind !== filters.kind) continue
    if (filters.scope && data.scope !== filters.scope) continue
    rmSync(path)
    removed.push(f)
  }
  return removed
}
