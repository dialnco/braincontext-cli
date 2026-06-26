import type { Context } from '../core/contexts'

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n')
}

function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat
}

/** Detailed single-entry view. */
export function formatContext(ctx: Context): string {
  const lines = [
    `${ctx.id}  [${ctx.kind}/${ctx.scope}]  ns=${ctx.namespace}${
      ctx.deletedAt ? '  (deleted)' : ''
    }`,
  ]
  if (ctx.title) lines.push(`  title: ${ctx.title}`)
  if (ctx.tags.length > 0) lines.push(`  tags:  ${ctx.tags.join(', ')}`)
  if (ctx.agentSource) lines.push(`  agent: ${ctx.agentSource}`)
  lines.push(`  updated: ${ctx.updatedAt}`)
  lines.push('')
  lines.push(indent(ctx.body))
  return lines.join('\n')
}

/** Compact one-line-per-entry list view. */
export function formatList(items: Context[]): string {
  if (items.length === 0) return 'No contexts found.'
  return items
    .map((c) => {
      const label = c.title ?? truncate(c.body, 60)
      const tags = c.tags.length > 0 ? `  #${c.tags.join(' #')}` : ''
      // Wiki pages carry a pageType (concept/entity/source/…); show that instead
      // of the underlying kind (always "note"). Mark soft-deleted rows (list --all).
      const del = c.deletedAt ? '  (deleted)' : ''
      return `${c.id}  [${c.pageType ?? c.kind}]  ${label}${tags}${del}`
    })
    .join('\n')
}
