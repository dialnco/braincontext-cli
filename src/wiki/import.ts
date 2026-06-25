import { readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Kysely } from 'kysely'
import { type Database, PAGE_TYPES, type PageType } from '../core/types'
import { createPage, getPageBySlug, recordSource, updatePage } from '../core/wiki'
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
      updated++
    } else if (p.type === 'source') {
      await recordSource(db, { title: p.title, body, uri: str(p.data.uri), createdAt, updatedAt })
      created++
    } else {
      await createPage(db, {
        title: p.title,
        pageType: p.type,
        body,
        slug: p.slug,
        tags,
        namespace: 'wiki',
        createdAt,
        updatedAt,
      })
      created++
    }
  }

  return { created, updated, skipped }
}
