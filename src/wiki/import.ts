import { readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Kysely } from 'kysely'
import { type Database, LINK_TYPES, PAGE_TYPES, type PageType } from '../core/types'
import { addLink, createPage, getPageBySlug, recordSource, updatePage } from '../core/wiki'
import { parseFrontmatter } from '../lib/frontmatter'

const MDLINK = /\[([^\]]*)\]\(([^)]+)\.md\)/g

function asPageType(value: unknown): PageType {
  return typeof value === 'string' && (PAGE_TYPES as readonly string[]).includes(value)
    ? (value as PageType)
    : 'concept'
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}
function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : []
}

interface FmLink {
  type: string
  toSlug?: string
  toTitle?: string
}
/** Parse the `links:` frontmatter array (explicit typed edges) written by export. */
function asLinks(v: unknown): FmLink[] {
  if (!Array.isArray(v)) return []
  const out: FmLink[] = []
  for (const it of v) {
    if (!it || typeof it !== 'object') continue
    const o = it as Record<string, unknown>
    const type = str(o.type)
    if (!type || !(LINK_TYPES as readonly string[]).includes(type)) continue
    out.push({ type, toSlug: str(o.toSlug), toTitle: str(o.toTitle) })
  }
  return out
}

export interface ImportResult {
  created: number
  updated: number
  skipped: number
}

interface ParsedPage {
  f: string
  slug: string
  title: string
  type: PageType
  body: string
  data: Record<string, unknown>
}

/**
 * Import a directory of markdown pages into the wiki. Two passes: build a
 * slug->title map, then rewrite [label](slug.md) back to [[Title]] so the
 * `references` channel re-derives on save (inverse of export). Malformed files
 * are skipped, not fatal. Preserves created/updated timestamps and source uris.
 */
export async function importWiki(db: Kysely<Database>, dir: string): Promise<ImportResult> {
  const files = readdirSync(dir).filter(
    (f) => f.endsWith('.md') && f !== 'index.md' && f !== 'log.md',
  )

  const parsed: ParsedPage[] = []
  let skipped = 0
  for (const f of files) {
    try {
      const { data, body } = parseFrontmatter<Record<string, unknown>>(
        readFileSync(join(dir, f), 'utf8'),
      )
      const slug = str(data.slug) || basename(f, '.md')
      const title = str(data.title) || slug
      parsed.push({ f, slug, title, type: asPageType(data.type), body, data })
    } catch {
      skipped++ // malformed frontmatter — skip, keep going
    }
  }

  const titleBySlug = new Map(parsed.map((p) => [p.slug, p.title]))
  const rewrite = (body: string): string =>
    body.replace(MDLINK, (full, _label, slugRef) => {
      const title = titleBySlug.get(String(slugRef))
      return title ? `[[${title}]]` : full
    })

  let created = 0
  let updated = 0
  const idBySlug = new Map<string, string>()

  for (const p of parsed) {
    const body = rewrite(p.body)
    const tags = strArray(p.data.tags)
    const createdAt = str(p.data.created)
    const updatedAt = str(p.data.updated)
    const existing = await getPageBySlug(db, p.slug)

    if (existing) {
      if (existing.pageType === 'source') {
        skipped++ // sources are immutable
        continue
      }
      await updatePage(db, existing.id, {
        title: p.title,
        body,
        addTags: tags.filter((t) => !existing.tags.includes(t)),
        removeTags: existing.tags.filter((t) => !tags.includes(t)),
      })
      idBySlug.set(p.slug, existing.id)
      updated++
    } else if (p.type === 'source') {
      const src = await recordSource(db, {
        title: p.title,
        body,
        uri: str(p.data.uri),
        createdAt,
        updatedAt,
      })
      idBySlug.set(p.slug, src.id)
      created++
    } else {
      const page = await createPage(db, {
        title: p.title,
        pageType: p.type,
        body,
        slug: p.slug,
        tags,
        namespace: 'wiki',
        createdAt,
        updatedAt,
      })
      idBySlug.set(p.slug, page.id)
      created++
    }
  }

  // Second pass: recreate explicit typed links now that every page exists (and has an id).
  // `references` edges already re-derived from the rewritten body above, so skip those.
  for (const p of parsed) {
    const fromId = idBySlug.get(p.slug)
    if (!fromId) continue
    for (const link of asLinks(p.data.links)) {
      const toId = link.toSlug ? idBySlug.get(link.toSlug) : undefined
      if (toId) await addLink(db, fromId, { toId, type: link.type })
      else if (link.toTitle) await addLink(db, fromId, { toTitle: link.toTitle, type: link.type })
    }
  }

  return { created, updated, skipped }
}
