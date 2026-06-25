import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

const FM = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/

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
  const m = md.match(FM)
  if (!m) return { data: {} as T, body: md }
  const data = (parseYaml(m[1] ?? '') ?? {}) as T
  return { data, body: m[2] ?? '' }
}

/** Serialize `data` as a `---` frontmatter block followed by `body`. */
export function stringifyFrontmatter(data: Record<string, unknown>, body: string): string {
  // lineWidth: 0 disables line wrapping so long descriptions stay single-line.
  const yaml = stringifyYaml(data, { lineWidth: 0 }).replace(/\n$/, '')
  const sep = body.startsWith('\n') ? '' : '\n'
  return `---\n${yaml}\n---${sep}${body}`
}
