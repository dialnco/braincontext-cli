import { estimateTokens } from './tokens'

/** Section headings (## / ###) in document order, hash prefixes stripped. */
export function extractOutline(body: string): string[] {
  const out: string[] = []
  let inFence = false
  for (const line of body.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m = /^(#{2,3})\s+(.+)/.exec(line)
    if (m?.[2]) out.push(m[2].trim())
  }
  return out
}

/** Leading ~maxChars of the body, cut at a word boundary; never splits a [[wikilink]]. */
export function extractExcerpt(body: string, maxChars = 400): string {
  const text = body.trim()
  if (text.length <= maxChars) return text
  let cut = text.lastIndexOf(' ', maxChars)
  if (cut <= 0) cut = maxChars
  const open = text.lastIndexOf('[[', cut)
  if (open > text.lastIndexOf(']]', cut)) cut = open
  return `${text.slice(0, cut).trimEnd()}…`
}

export interface TruncationResult {
  text: string
  truncated: boolean
  totalTokens: number
  returnedTokens: number
}

/**
 * Truncate to ~maxTokens at a paragraph boundary. Falls back to a hard cut when
 * the nearest paragraph break would drop more than half the budget (returning a
 * tiny fragment to honor a break helps nobody).
 */
export function truncateAtTokens(body: string, maxTokens: number): TruncationResult {
  const totalTokens = estimateTokens(body)
  if (totalTokens <= maxTokens) {
    return { text: body, truncated: false, totalTokens, returnedTokens: totalTokens }
  }
  const maxChars = maxTokens * 4
  const paraBreak = body.lastIndexOf('\n\n', maxChars)
  const cut = paraBreak > maxChars / 2 ? paraBreak : maxChars
  const text = body.slice(0, cut).trimEnd()
  return { text, truncated: true, totalTokens, returnedTokens: estimateTokens(text) }
}
