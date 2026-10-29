/**
 * Render an inbox message body to HTML — ESCAPE FIRST. Bodies are written by other
 * members (and their agents), and Studio runs with the launching member's key, so
 * an injected script could act as them. Every character is HTML-escaped before any
 * formatting is applied; the only markup ever produced is a fixed set of tags with
 * no attributes from the input except an http(s) link target (itself escaped) and a
 * wikilink title kept in a data attribute. No raw HTML, no other URL schemes.
 *
 * Pure string → string (no DOM), so it is unit-testable without jsdom.
 */

const ESC: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESC[c] ?? c)
}

function inline(escaped: string): string {
  return (
    escaped
      // `code` first so nothing inside it is formatted.
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      // [[Title]] → a wikilink the view resolves on click (title stays escaped).
      .replace(/\[\[([^\]\n|]+)\]\]/g, '<span class="inbox-wl" data-wikilink="$1">$1</span>')
      // Bare http(s) URLs only. The match runs on escaped text, so it cannot contain
      // a raw quote or angle bracket to break out of the attribute.
      .replace(
        /\bhttps?:\/\/[^\s<&]+(?:&amp;[^\s<&]+)*/g,
        (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`,
      )
  )
}

export function renderInboxBody(body: string): string {
  const out: string[] = []
  const parts = body.split(/```/)
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      // Fenced block: drop an optional language tag on the first line.
      const code = part.replace(/^[a-zA-Z0-9_-]*\n/, '')
      out.push(`<pre><code>${escapeHtml(code)}</code></pre>`)
      return
    }
    for (const para of part.split(/\n{2,}/)) {
      if (!para.trim()) continue
      out.push(`<p>${inline(escapeHtml(para.trim())).replace(/\n/g, '<br>')}</p>`)
    }
  })
  return out.join('')
}
