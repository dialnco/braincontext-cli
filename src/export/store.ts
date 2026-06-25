import type { Context } from '../core/contexts'
import { stringifyFrontmatter } from '../lib/frontmatter'

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
