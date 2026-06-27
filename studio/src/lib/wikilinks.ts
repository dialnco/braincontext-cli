/**
 * Wikilink rendering + parsing for the editor. A wikilink is an inline,
 * non-editable pill carrying the target page id in `data-link`; on save the body
 * HTML is converted to markdown `[[Title]]` (see markdown.ts) and the server
 * re-derives the `references` link graph from those titles.
 */

const WL_STYLE =
  "color:var(--link);font-family:'IBM Plex Sans',sans-serif;font-weight:500;font-size:.93em;border-bottom:1px solid color-mix(in srgb, var(--link) 32%, transparent);padding-bottom:.5px;white-space:nowrap;"

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Inline pill HTML for a link to `id` displayed as `title`. `id` may be empty for
 *  an as-yet-unresolved (wanted) link — the title is what the server resolves on. */
export function wlSpan(id: string, title: string): string {
  return `<span class="wl" data-link="${esc(id)}" data-title="${esc(title)}" contenteditable="false" style="${WL_STYLE}">${esc(title)}</span>`
}

/** Turn a free-text label into a url/slug-ish id (matches the reference behaviour). */
export function slugifyTitle(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || `note-${title.length}`
  )
}

/** All `[[Title]]` targets in a markdown/plain string (deduped, in order). */
export function parseWikiLinks(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const re = /\[\[([^[\]\n|]+)(?:\|[^[\]\n]+)?\]\]/g
  let m: RegExpExecArray | null
  m = re.exec(text)
  while (m) {
    const title = (m[1] ?? '').trim()
    const key = title.toLowerCase()
    if (title && !seen.has(key)) {
      seen.add(key)
      out.push(title)
    }
    m = re.exec(text)
  }
  return out
}
