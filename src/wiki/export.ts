import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Kysely } from 'kysely'
import type { Context } from '../core/contexts'
import { type Database, REFERENCES_LINK } from '../core/types'
import { listLog, listPages, outboundLinks } from '../core/wiki'
import { parseFrontmatter, stringifyFrontmatter } from '../lib/frontmatter'
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
  const slugById = new Map<string, string>()
  for (const p of pages) {
    if (p.title && p.slug) slugByTitle.set(normalizeTitle(p.title), p.slug)
    if (p.slug) slugById.set(p.id, p.slug)
  }

  const files: string[] = []
  for (const p of pages) {
    if (p.pageType === 'index') continue // the catalog is generated as index.md
    const fm: Record<string, unknown> = {
      title: p.title ?? p.slug ?? p.id,
      type: p.pageType,
      slug: p.slug,
    }
    if (p.tags.length > 0) fm.tags = p.tags
    if (typeof p.metadata.uri === 'string') fm.uri = p.metadata.uri
    // Serialize EXPLICIT typed links (source/relates/supersedes/...). `references` links
    // re-derive from the body `[[..]]` on import, so they are excluded to avoid duplication.
    const links: Array<{ type: string; toSlug?: string; toTitle?: string }> = []
    for (const l of await outboundLinks(db, p.id)) {
      if (l.type === REFERENCES_LINK) continue
      const toSlug = l.pageId ? slugById.get(l.pageId) : undefined
      if (toSlug) links.push({ type: l.type, toSlug })
      else if (l.title) links.push({ type: l.type, toTitle: l.title })
    }
    if (links.length > 0) fm.links = links
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

  // The export dir is a full materialization of the wiki: remove stale .md files for
  // pages that no longer exist, so a deleted page can't resurrect on re-import. CRUCIAL
  // safety: only remove files THIS exporter produced — a wiki page file always carries
  // `slug` + `type` frontmatter, and index.md/log.md are always rewritten (in `keep`).
  // Hand-authored markdown in the target dir (README.md, AGENTS.md, notes) has no such
  // frontmatter and is never touched, so `bctx wiki export .` can't nuke unrelated files.
  const keep = new Set(files)
  for (const existing of readdirSync(outDir)) {
    if (!existing.endsWith('.md') || keep.has(existing)) continue
    if (isStaleWikiPageFile(join(outDir, existing))) rmSync(join(outDir, existing))
  }

  return { files }
}

/** True only for a leftover file a prior wiki export wrote (page frontmatter: slug + type). */
function isStaleWikiPageFile(path: string): boolean {
  try {
    const { data } = parseFrontmatter<Record<string, unknown>>(readFileSync(path, 'utf8'))
    return typeof data.slug === 'string' && typeof data.type === 'string'
  } catch {
    return false
  }
}
