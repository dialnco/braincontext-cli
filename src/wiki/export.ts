import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Kysely } from 'kysely'
import type { Context } from '../core/contexts'
import { renderView } from '../core/query'
import { type Database, EMBEDS_LINK, REFERENCES_LINK } from '../core/types'
import { listLog, listPages, outboundLinks } from '../core/wiki'
import { parseFrontmatter, stringifyFrontmatter } from '../lib/frontmatter'
import { estimateTokens, formatTokens } from '../lib/tokens'
import { normalizeTitle } from '../lib/wikilinks'

// `(?<!!)` leaves a `![[Title]]` transclusion verbatim (Obsidian renders it as an embed);
// only plain [[Title]] references become relative markdown links.
const WIKILINK = /(?<!!)\[\[([^\]]+)\]\]/g

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

/**
 * Render the catalog page (grouped by page type) — shared by `wiki index` and export.
 * Every line carries the page's token estimate so an agent can budget which pages
 * it can afford to open before opening any of them.
 *
 * With `budget`, the rendered document itself is capped at ~that many tokens: source
 * entries are dropped first, then the entries with the largest bodies, and an explicit
 * "N omitted" line replaces them — a truncated map must never read as a complete one.
 */
export function renderIndexMarkdown(pages: Context[], opts: { budget?: number } = {}): string {
  const order = [
    'entity',
    'concept',
    'summary',
    'comparison',
    'analysis',
    'datatable',
    'view',
    'source',
  ]
  const total = pages.reduce((n, p) => n + estimateTokens(p.body), 0)

  const entryLine = (p: Context): string => {
    const summary = firstLine(p.body)
    const cost = formatTokens(estimateTokens(p.body))
    return `- [${p.title ?? p.slug}](${p.slug ?? p.id}.md)${summary ? ` — ${summary}` : ''} (${cost})`
  }

  const render = (kept: Set<string>, omitted: number): string => {
    const lines = ['# Wiki index', '', `${pages.length} page(s) · ${formatTokens(total)} total`, '']
    for (const t of order) {
      const group = pages.filter((p) => p.pageType === t && kept.has(p.id))
      if (group.length === 0) continue
      lines.push(`## ${t}`, '')
      for (const p of group) lines.push(entryLine(p))
      lines.push('')
    }
    if (omitted > 0) {
      lines.push(`_${omitted} page(s) omitted to fit the ~${opts.budget} token budget._`, '')
    }
    return `${lines.join('\n').trim()}\n`
  }

  const kept = new Set(pages.filter((p) => p.pageType !== 'index').map((p) => p.id))
  if (!opts.budget) return render(kept, 0)

  // Drop order: sources first, then largest bodies — the cheap-to-open pages keep
  // their place on the map. Recompute arithmetically, render once at the end.
  const dropOrder = [...pages]
    .filter((p) => kept.has(p.id))
    .sort((a, b) => {
      const aSrc = a.pageType === 'source' ? 0 : 1
      const bSrc = b.pageType === 'source' ? 0 : 1
      if (aSrc !== bSrc) return aSrc - bSrc
      return estimateTokens(b.body) - estimateTokens(a.body)
    })
  let cost = estimateTokens(render(kept, 0))
  let omitted = 0
  for (const p of dropOrder) {
    if (cost <= opts.budget) break
    kept.delete(p.id)
    cost -= estimateTokens(`${entryLine(p)}\n`)
    omitted++
  }
  return render(kept, omitted)
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
    // Serialize EXPLICIT typed links (source/relates/supersedes/...). `references` and
    // `embeds` links re-derive from the body `[[..]]` / `![[..]]` on import, so they are
    // excluded to avoid duplication (the `![[..]]` stays verbatim in the body).
    const links: Array<{ type: string; toSlug?: string; toTitle?: string }> = []
    for (const l of await outboundLinks(db, p.id)) {
      if (l.type === REFERENCES_LINK || l.type === EMBEDS_LINK) continue
      const toSlug = l.pageId ? slugById.get(l.pageId) : undefined
      if (toSlug) links.push({ type: l.type, toSlug })
      else if (l.title) links.push({ type: l.type, toTitle: l.title })
    }
    if (links.length > 0) fm.links = links
    // Typed properties (metadata.props) round-trip as their own frontmatter block so
    // `wiki query` re-derives them on import; `view` pages also carry their saved query.
    if (p.metadata.props && typeof p.metadata.props === 'object') fm.props = p.metadata.props
    if (p.pageType === 'view') {
      if (p.metadata.query) fm.query = p.metadata.query
      if (Array.isArray(p.metadata.columns)) fm.columns = p.metadata.columns
    }
    fm.created = p.createdAt
    fm.updated = p.updatedAt

    // A view's body is generated — re-render it live so the export reflects the current graph.
    const rawBody = p.pageType === 'view' ? await renderView(db, p.metadata) : p.body
    const body = rewriteLinks(rawBody, slugByTitle)
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
