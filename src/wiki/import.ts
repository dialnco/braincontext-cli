import { readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Kysely } from 'kysely'
import type { Database } from '../core/types'
import { PAGE_TYPES, type PageType } from '../core/types'
import { createPage, getPageBySlug, updatePage } from '../core/wiki'
import { parseFrontmatter } from '../lib/frontmatter'

const MDLINK = /\[([^\]]*)\]\(([^)]+)\.md\)/g

function asPageType(value: unknown): PageType {
  return typeof value === 'string' && (PAGE_TYPES as readonly string[]).includes(value)
    ? (value as PageType)
    : 'concept'
}

export interface ImportResult {
  created: number
  updated: number
  skipped: number
}

/**
 * Import a directory of markdown pages into the wiki. Two passes: build a
 * slug->title map, then rewrite [label](slug.md) back to [[Title]] so the
 * `references` channel re-derives on save (inverse of export).
 */
export async function importWiki(db: Kysely<Database>, dir: string): Promise<ImportResult> {
  const files = readdirSync(dir).filter(
    (f) => f.endsWith('.md') && f !== 'index.md' && f !== 'log.md',
  )

  const parsed = files.map((f) => {
    const { data, body } = parseFrontmatter<Record<string, unknown>>(
      readFileSync(join(dir, f), 'utf8'),
    )
    const slug = (typeof data.slug === 'string' && data.slug) || basename(f, '.md')
    const title = (typeof data.title === 'string' && data.title) || slug
    return { f, slug, title, type: asPageType(data.type), body, data }
  })

  const titleBySlug = new Map(parsed.map((p) => [p.slug, p.title]))
  const rewrite = (body: string): string =>
    body.replace(MDLINK, (full, _label, slugRef) => {
      const title = titleBySlug.get(String(slugRef))
      return title ? `[[${title}]]` : full
    })

  let created = 0
  let updated = 0
  let skipped = 0

  for (const p of parsed) {
    const body = rewrite(p.body)
    const existing = await getPageBySlug(db, p.slug)
    if (existing) {
      if (existing.pageType === 'source') {
        skipped++ // sources are immutable
        continue
      }
      await updatePage(db, existing.id, { title: p.title, body })
      updated++
    } else {
      const tags = Array.isArray(p.data.tags)
        ? p.data.tags.filter((t): t is string => typeof t === 'string')
        : undefined
      await createPage(db, {
        title: p.title,
        pageType: p.type,
        body,
        slug: p.slug,
        tags,
        namespace: 'wiki',
      })
      created++
    }
  }

  return { created, updated, skipped }
}
