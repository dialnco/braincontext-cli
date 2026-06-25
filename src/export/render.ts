import type { Context } from '../core/contexts'

const KIND_SECTIONS: Array<{ kind: string; heading: string }> = [
  { kind: 'rule', heading: 'Rules' },
  { kind: 'decision', heading: 'Decisions' },
  { kind: 'note', heading: 'Notes' },
  { kind: 'snippet', heading: 'Snippets' },
  { kind: 'skill', heading: 'Skills' },
]

function renderEntry(c: Context): string {
  const title = c.title ? `**${c.title}** — ` : ''
  const tags = c.tags.length > 0 ? ` _(tags: ${c.tags.join(', ')})_` : ''
  return `- ${title}${c.body.trim()}${tags}`
}

/** Markdown that goes INSIDE the AGENTS.md managed fence (sections by kind). */
export function renderAgentsBody(items: Context[]): string {
  const lines: string[] = []
  for (const { kind, heading } of KIND_SECTIONS) {
    const group = items.filter((c) => c.kind === kind)
    if (group.length === 0) continue
    lines.push(`## ${heading}`, '')
    for (const c of group) lines.push(renderEntry(c))
    lines.push('')
  }
  return lines.join('\n').trim()
}

/** Body inside the CLAUDE.md managed fence: just the AGENTS.md import bridge. */
export function renderClaudeBody(): string {
  return '@AGENTS.md'
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50) || 'rule'
  )
}

/** A plain YAML scalar, quoted only when it would otherwise be ambiguous. */
function yamlScalar(value: string): string {
  const v = value.trim()
  const needsQuote = /:\s/.test(v) || /^[!&*?{}[\],#|>@`"'%-]/.test(v) || v === ''
  return needsQuote ? JSON.stringify(v) : v
}

/**
 * Render one Cursor rule file (.mdc) from a kind='rule' context.
 * Frontmatter is exactly description / globs / alwaysApply; `globs` is emitted
 * as an unquoted comma-separated string (Cursor's required form), never a list.
 */
export function renderMdc(c: Context): { filename: string; content: string } {
  const description = (c.title ?? c.body.split('\n')[0] ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
  const globs = typeof c.metadata.globs === 'string' ? c.metadata.globs.trim() : ''

  const fm: string[] = ['---']
  if (description) fm.push(`description: ${yamlScalar(description)}`)
  if (globs) fm.push(`globs: ${globs}`) // intentionally unquoted CSV
  fm.push('alwaysApply: false', '---', '')

  const content = `${fm.join('\n')}\n${c.body.trim()}\n`
  return { filename: `${slug(c.title ?? c.id)}.mdc`, content }
}
