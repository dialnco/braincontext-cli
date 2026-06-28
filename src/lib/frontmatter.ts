import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

// Tolerate CRLF line endings and a closing `---` with trailing spaces.
const FM = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/

export interface Frontmatter<T = Record<string, unknown>> {
  data: T
  body: string
}

/**
 * Split a markdown document with a leading `---` YAML frontmatter block into
 * parsed `data` + the remaining `body`. If there is no frontmatter, `data` is
 * empty and `body` is the whole input. Throws on malformed YAML (callers that
 * must be lenient should catch).
 */
export function parseFrontmatter<T = Record<string, unknown>>(md: string): Frontmatter<T> {
  const text = md.replace(/^\uFEFF/, '') // strip a leading BOM
  const m = text.match(FM)
  if (!m) return { data: {} as T, body: text }
  const data = (parseYaml(m[1] ?? '') ?? {}) as T
  return { data, body: m[2] ?? '' }
}

/** Serialize `data` as a `---` frontmatter block followed by `body`. */
export function stringifyFrontmatter(data: Record<string, unknown>, body: string): string {
  // lineWidth: 0 disables line wrapping so long descriptions stay single-line.
  const yaml = stringifyYaml(data, { lineWidth: 0 }).replace(/\n$/, '')
  // Always emit exactly the single newline that terminates the closing `---` line, then the
  // body verbatim. `parseFrontmatter` consumes that one terminator, so `body` already carries
  // any blank line that followed it — the previous `startsWith('\n') ? '' : '\n'` logic
  // swallowed that blank line and broke the byte-for-byte round-trip.
  return `---\n${yaml}\n---\n${body}`
}
