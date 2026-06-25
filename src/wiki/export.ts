import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Kysely } from 'kysely'
import type { Context } from '../core/contexts'
import type { Database } from '../core/types'
import { listLog, listPages } from '../core/wiki'
import { stringifyFrontmatter } from '../lib/frontmatter'
import { normalizeTitle } from '../lib/wikilinks'

const WIKILINK = /\[\[([^\]]+)\]\]/g

/** Rewrite [[Title]] -> [label](slug.md) using a normalized-title -> slug map. */
function rewriteLinks(body: string, slugByTitle: Map<string, string>): string {
  return body.replace(WIKILINK, (full, inner) => {
    const [rawTitle, alias] = String(inner).split('|')
    const title = (rawTitle ?? '').trim()
    const slug = slugByTitle.get(normalizeTitle(title))
    const label = (alias ?? title).trim()
    return slug ? `[${label}](${slug}.md)` : full
  })
}

function firstLine(body: string): string {
  return (body.split('\n').find((l) => l.trim()) ?? '')
    .replace(/^#+\s*/, '')
    .trim()
    .slice(0, 120)
}

/** Render the catalog page (grouped by page type) — shared by `wiki index` and export. */
export function renderIndexMarkdown(pages: Context[]): string {
  const order = ['entity', 'concept', 'summary', 'comparison', 'analysis', 'source']
  const lines = ['# Wiki index', '']
  for (const t of order) {
    const group = pages.filter((p) => p.pageType === t)
    if (group.length === 0) continue
    lines.push(`## ${t}`, '')
    for (const p of group) {
      const summary = firstLine(p.body)
      lines.push(`- [${p.title ?? p.slug}](${p.slug ?? p.id}.md)${summary ? ` — ${summary}` : ''}`)
    }
    lines.push('')
  }
  return `${lines.join('\n').trim()}\n`
}

export interface ExportResult {
  files: string[]
}

/** Materialize the wiki to `outDir`: one <slug>.md per page + index.md + log.md. */
export async function exportWiki(db: Kysely<Database>, outDir: string): Promise<ExportResult> {
  mkdirSync(outDir, { recursive: true })
  const pages = await listPages(db, { limit: 100000 })

  const slugByTitle = new Map<string, string>()
  for (const p of pages) {
    if (p.title && p.slug) slugByTitle.set(normalizeTitle(p.title), p.slug)
  }

  const files: string[] = []
  for (const p of pages) {
    const fm: Record<string, unknown> = {
      title: p.title ?? p.slug ?? p.id,
      type: p.pageType,
      slug: p.slug,
    }
    if (p.tags.length > 0) fm.tags = p.tags
    if (typeof p.metadata.uri === 'string') fm.uri = p.metadata.uri
    fm.created = p.createdAt
    fm.updated = p.updatedAt

    const body = rewriteLinks(p.body, slugByTitle)
    const file = `${p.slug ?? p.id}.md`
    writeFileSync(
      join(outDir, file),
      stringifyFrontmatter(fm, body.endsWith('\n') ? body : `${body}\n`),
      'utf8',
    )
    files.push(file)
  }

  writeFileSync(join(outDir, 'index.md'), renderIndexMarkdown(pages), 'utf8')
  files.push('index.md')

  const log = await listLog(db, { limit: 1000 })
  const logLines = ['# Wiki log', '']
  for (const e of log.reverse()) {
    logLines.push(`## [${e.createdAt}] ${e.op}${e.title ? ` | ${e.title}` : ''}`)
    if (e.detail) logLines.push(e.detail)
    logLines.push('')
  }
  writeFileSync(join(outDir, 'log.md'), `${logLines.join('\n').trim()}\n`, 'utf8')
  files.push('log.md')

  return { files }
}
