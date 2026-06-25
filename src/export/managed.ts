const BEGIN = '<!-- BEGIN braincontext-cli (managed: do not edit by hand) -->'
const END = '<!-- END braincontext-cli -->'

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Insert/replace a managed block in `existing`. If the fence markers are present,
 * only the span between them is replaced; otherwise the block is appended.
 * Everything outside the fence is preserved verbatim.
 */
export function applyManagedBlock(existing: string, body: string): string {
  const block = `${BEGIN}\n${body}\n${END}`
  if (existing.includes(BEGIN) && existing.includes(END)) {
    const re = new RegExp(`${escapeRe(BEGIN)}[\\s\\S]*?${escapeRe(END)}`)
    // Function replacer so `$&`, `$1`, `$$` in the body aren't treated as specials.
    return existing.replace(re, () => block)
  }
  const trimmed = existing.replace(/\n*$/, '')
  const prefix = trimmed.length > 0 ? `${trimmed}\n\n` : ''
  return `${prefix}${block}\n`
}
