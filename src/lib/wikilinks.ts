// `(?<!!)` so a `![[Title]]` transclusion is NOT captured as a plain [[..]] reference link
// (the `!` prefix routes it to the reserved `embeds` channel instead — see parseTransclusions).
const WIKILINK = /(?<!!)\[\[([^\]]+)\]\]/g
const TRANSCLUSION = /!\[\[([^\]]+)\]\]/g

/** Extract the distinct titles referenced by [[Title]] / [[Title|alias]] in a body. */
export function parseWikiLinks(body: string): string[] {
  const out: string[] = []
  for (const m of body.matchAll(WIKILINK)) {
    const title = (m[1] ?? '').split('|')[0]?.trim()
    if (title) out.push(title)
  }
  return [...new Set(out)]
}

/** Extract the distinct titles embedded via `![[Title]]` transclusion in a body. */
export function parseTransclusions(body: string): string[] {
  const out: string[] = []
  for (const m of body.matchAll(TRANSCLUSION)) {
    const title = (m[1] ?? '').split('|')[0]?.trim()
    if (title) out.push(title)
  }
  return [...new Set(out)]
}

/** Normalize a title for case/whitespace-insensitive matching. */
export function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** Derive a filesystem-safe slug from a title. */
export function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'page'
  )
}
