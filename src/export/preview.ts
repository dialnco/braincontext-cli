import type { Context } from '../core/contexts'
import { applyManagedBlock } from './managed'
import { renderAgentsBody, renderClaudeBody, renderMdc } from './render'
import type { Target } from './write'

export interface PreviewFile {
  /** Forward-slash display path (e.g. `AGENTS.md`, `.cursor/rules/foo.mdc`). */
  path: string
  content: string
}

/**
 * Render the export targets' canonical content for a read-only preview. Mirrors
 * {@link planExport} but is filesystem-free and always shows the clean managed
 * block (`applyManagedBlock('', …)`) a fresh export would produce — so Studio can
 * preview `bctx export` without writing anything.
 */
export function previewExport(items: Context[], targets: Target[]): PreviewFile[] {
  const out: PreviewFile[] = []
  const has = (t: Target) => targets.includes(t)

  if (has('agents'))
    out.push({ path: 'AGENTS.md', content: applyManagedBlock('', renderAgentsBody(items)) })
  if (has('claude'))
    out.push({ path: 'CLAUDE.md', content: applyManagedBlock('', renderClaudeBody()) })
  if (has('cursor')) {
    const used = new Set<string>()
    for (const c of items.filter((x) => x.kind === 'rule')) {
      const { filename, content } = renderMdc(c)
      let name = filename
      for (let i = 2; used.has(name); i++) name = filename.replace(/\.mdc$/, `-${i}.mdc`)
      used.add(name)
      out.push({ path: `.cursor/rules/${name}`, content })
    }
  }
  return out
}
