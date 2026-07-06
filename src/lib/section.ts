/**
 * Pure, fence-aware heading-section addressing for markdown bodies — the read/patch analogue
 * of `mdtable.ts` for prose. No `node:`/DOM deps so it bundles into both CLI and browser.
 *
 * A "section" is an ATX heading (`#`..`######`) plus every line beneath it, up to (but not
 * including) the next heading of the SAME OR HIGHER level (or end of document). Headings
 * inside ``` / ~~~ fenced code blocks are ignored, so a `# comment` in a code sample can't be
 * mistaken for a real section boundary.
 */

const FENCE = /^\s*(```|~~~)/
// ATX heading: 1–6 leading #, text, optional trailing #'s (`## Title ##`).
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/

export interface Section {
  /** Heading text with the leading #'s (and any trailing #'s) stripped. */
  heading: string
  /** Heading level, 1–6. */
  level: number
  /** 0-based line index of the heading line. */
  startLine: number
  /** 0-based line index of the last line in the section (inclusive). */
  endLine: number
  /** The section's markdown, including its heading line. */
  text: string
}

interface HeadingLine {
  level: number
  text: string
  line: number
}

/** All ATX headings in document order (fence-aware). */
export function parseHeadings(body: string): Array<{ level: number; text: string; line: number }> {
  const lines = body.split('\n')
  const out: HeadingLine[] = []
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (FENCE.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m = HEADING.exec(line)
    if (m?.[1] && m[2]) out.push({ level: m[1].length, text: m[2].trim(), line: i })
  }
  return out
}

/** Normalize a heading for tolerant matching (case/space-insensitive, trailing #'s dropped). */
export function normalizeHeading(heading: string): string {
  return heading
    .replace(/^#+\s*/, '')
    .replace(/\s*#+\s*$/, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

/** Every section whose heading matches `heading` (usually 0 or 1; >1 ⇒ ambiguous). */
export function findSections(body: string, heading: string): Section[] {
  const lines = body.split('\n')
  const headings = parseHeadings(body)
  const want = normalizeHeading(heading)
  const out: Section[] = []
  for (let h = 0; h < headings.length; h++) {
    const cur = headings[h]
    if (!cur || normalizeHeading(cur.text) !== want) continue
    // The section ends just before the next heading of the same or a higher level.
    let endLine = lines.length - 1
    for (let n = h + 1; n < headings.length; n++) {
      const next = headings[n]
      if (next && next.level <= cur.level) {
        endLine = next.line - 1
        break
      }
    }
    const text = lines.slice(cur.line, endLine + 1).join('\n')
    out.push({ heading: cur.text, level: cur.level, startLine: cur.line, endLine, text })
  }
  return out
}

/**
 * Replace a section's lines (heading inclusive) with `newText`, returning the new body.
 * `newText` is inserted verbatim; callers that want to keep the heading must include it.
 */
export function replaceSection(body: string, section: Section, newText: string): string {
  const lines = body.split('\n')
  const before = lines.slice(0, section.startLine)
  const after = lines.slice(section.endLine + 1)
  const middle = newText.split('\n')
  return [...before, ...middle, ...after].join('\n')
}

export interface OccurrenceResult {
  body: string
  /** How many times `find` occurred in the original body. */
  count: number
}

/**
 * Replace one exact occurrence of `find` with `replace`. `occurrence` is 1-based; when it is
 * undefined the replacement only happens if `find` occurs EXACTLY once. Returns the (possibly
 * unchanged) body plus the total match count so the caller can enforce match-or-refuse.
 */
export function replaceOccurrence(
  body: string,
  find: string,
  replace: string,
  occurrence?: number,
): OccurrenceResult {
  if (find === '') return { body, count: 0 }
  // Collect every match start (non-overlapping, left to right).
  const starts: number[] = []
  for (let i = body.indexOf(find); i !== -1; i = body.indexOf(find, i + find.length)) starts.push(i)
  const count = starts.length
  if (count === 0) return { body, count }

  let idx: number
  if (occurrence === undefined) {
    if (count !== 1) return { body, count } // ambiguous — caller refuses
    idx = starts[0] as number
  } else {
    if (occurrence < 1 || occurrence > count) return { body, count } // out of range — caller refuses
    idx = starts[occurrence - 1] as number
  }
  const next = `${body.slice(0, idx)}${replace}${body.slice(idx + find.length)}`
  return { body: next, count }
}
