const BEGIN = '<!-- BEGIN braincontext-cli (managed: do not edit by hand) -->'
const END = '<!-- END braincontext-cli -->'

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Neutralize any literal fence markers inside the managed body. A context whose text
 * contains `<!-- END braincontext-cli -->` would otherwise truncate the block at the first
 * END and permanently break idempotency (the replace regex is non-greedy). A zero-width
 * space right after `<!--` makes the marker no longer our exact sentinel — visually
 * identical in an editor, but it can never be mistaken for the fence.
 */
function neutralizeSentinels(body: string): string {
  const z = String.fromCharCode(0x200b) // zero-width space
  return body
    .split(BEGIN)
    .join(`<!--${z}${BEGIN.slice(4)}`)
    .split(END)
    .join(`<!--${z}${END.slice(4)}`)
}

/**
 * Insert/replace a managed block in `existing`. If the fence markers are present,
 * only the span between them is replaced; otherwise the block is appended.
 * Everything outside the fence is preserved verbatim.
 */
export function applyManagedBlock(existing: string, body: string): string {
  const block = `${BEGIN}\n${neutralizeSentinels(body)}\n${END}`
  if (existing.includes(BEGIN) && existing.includes(END)) {
    const re = new RegExp(`${escapeRe(BEGIN)}[\\s\\S]*?${escapeRe(END)}`)
    // Function replacer so `$&`, `$1`, `$$` in the body aren't treated as specials.
    return existing.replace(re, () => block)
  }
  const trimmed = existing.replace(/\n*$/, '')
  const prefix = trimmed.length > 0 ? `${trimmed}\n\n` : ''
  return `${prefix}${block}\n`
}
