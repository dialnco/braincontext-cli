/**
 * Visual tokens carried over from the reference design (warm "paper" aesthetic,
 * Spectral + IBM Plex), kept as pure data so components and the editor share one
 * source of truth. Only the taxonomy below changed: wiki **page types** replaced
 * the reference's personal-note types.
 */

export type ThemeName = 'light' | 'dark'

/** CSS-variable palettes applied on the hero container; everything reads var(--…). */
export const LIGHT: Record<string, string> = {
  '--bg': '#e7dfcf',
  '--panel': '#efe8da',
  '--surface': '#faf6ee',
  '--ink': '#2c2823',
  '--ink-soft': '#4f4a40',
  '--muted': '#9a917f',
  '--border': '#dcd3c0',
  '--accent': '#6a7cff',
  '--accent-ink': '#4b53c6',
  '--accent-soft': 'rgba(106,124,255,0.15)',
  '--link': '#4b53c6',
  '--code-bg': '#efe8d9',
}

export const DARK: Record<string, string> = {
  '--bg': '#121317',
  '--panel': '#17181d',
  '--surface': '#1a1b21',
  '--ink': '#e8e4d9',
  '--ink-soft': '#bdb8aa',
  '--muted': '#827c6f',
  '--border': '#2a2b33',
  '--accent': '#7c8cff',
  '--accent-ink': '#9aa3ff',
  '--accent-soft': 'rgba(124,140,255,0.16)',
  '--link': '#9aa3ff',
  '--code-bg': '#0f1014',
}

/** Block-content inline styles used by both the renderer and the editor transforms. */
export const S = {
  p: "font:400 17.5px/1.74 'Spectral',serif;color:var(--ink-soft);margin:0 0 18px;",
  h1: "font:600 27px/1.24 'Spectral',serif;color:var(--ink);margin:26px 0 10px;letter-spacing:-.013em;",
  h2: "font:600 21px/1.3 'Spectral',serif;color:var(--ink);margin:32px 0 11px;letter-spacing:-.01em;",
  h3: "font:600 16.5px/1.32 'Spectral',serif;color:var(--ink);margin:22px 0 8px;",
  li: "font:400 17.5px/1.66 'Spectral',serif;color:var(--ink-soft);margin:0 0 7px;",
  ul: 'margin:0 0 18px;padding-left:23px;',
  task: "font:400 17px/1.6 'Spectral',serif;color:var(--ink-soft);margin:0 0 7px;display:flex;align-items:flex-start;gap:10px;",
  hr: 'border:none;border-top:1px solid var(--border);margin:24px 0;',
  quote:
    "margin:0 0 18px;padding:5px 0 5px 20px;border-left:3px solid var(--accent);color:var(--ink);font:italic 400 18px/1.62 'Spectral',serif;",
  code: "font:500 13.5px/1.65 'IBM Plex Mono',monospace;background:var(--code-bg);border:1px solid var(--border);border-radius:9px;padding:13px 15px;color:var(--ink-soft);margin:0 0 18px;white-space:pre-wrap;display:block;overflow:auto;",
  ic: "font:500 13.5px 'IBM Plex Mono',monospace;background:var(--code-bg);border:1px solid var(--border);border-radius:5px;padding:1px 6px;color:var(--ink);",
  callout:
    'margin:0 0 18px;border:1px solid var(--border);background:var(--accent-soft);border-radius:11px;padding:13px 16px;',
  cT: "font:600 11px/1 'IBM Plex Mono',monospace;letter-spacing:.09em;text-transform:uppercase;color:var(--accent-ink);margin:0 0 6px;",
  cP: "font:400 16px/1.6 'Spectral',serif;color:var(--ink-soft);margin:0;",
  // A wide table renders as its OWN scroll box (display:block + overflow:auto): it
  // breaks out to the full pane width — JS sets the exact max-width per layout since
  // the side panels vary, see WikiEditor.sizeTables — and scrolls both axes in place
  // instead of dragging the page. max-height caps very tall tables so the sticky
  // header below has a vertical scroll context. width:max-content lets it exceed the
  // 720px prose column; max-width:100% is the pre-JS fallback. border-collapse MUST
  // be `separate` (not collapse) or the sticky <th>'s border doesn't scroll with it.
  table:
    'display:block;width:max-content;max-width:100%;max-height:70vh;overflow:auto;border-collapse:separate;border-spacing:0;border-radius:10px;margin:0 0 20px;',
  th: "position:sticky;top:0;z-index:1;text-align:left;white-space:nowrap;font:600 13.5px/1.5 'IBM Plex Sans',sans-serif;color:var(--ink);background:var(--code-bg);border-right:1px solid var(--border);border-bottom:1px solid var(--border);padding:9px 14px;",
  td: "font:400 16px/1.6 'Spectral',serif;color:var(--ink-soft);border-right:1px solid var(--border);border-bottom:1px solid var(--border);padding:9px 14px;vertical-align:top;",
} as const

/** A short glyph per wiki page type, for the sidebar / palette / graph legend. */
export function pageTypeGlyph(pageType: string | null): string {
  switch (pageType) {
    case 'entity':
      return '◈' // ◈
    case 'concept':
      return '◆' // ◆
    case 'summary':
      return '◐' // ◐
    case 'comparison':
      return '⇄' // ⇄
    case 'analysis':
      return '◉' // ◉
    case 'datatable':
      return '▦' // ▦ (grid)
    case 'view':
      return '⊞' // ⊞ (saved query)
    case 'source':
      return '▤' // ▤
    case 'index':
      return '☰' // ☰
    default:
      return '◌' // ◌ (plain context)
  }
}

/** A stable accent colour per page type, used to tint nodes in the folder graph view. */
export function pageTypeColor(pageType: string | null): string {
  switch (pageType) {
    case 'concept':
      return 'var(--accent)'
    case 'entity':
      return '#5fb3a3'
    case 'source':
      return '#c98a6a'
    case 'summary':
      return '#6f9bd1'
    case 'comparison':
      return '#b07bd1'
    case 'analysis':
      return '#cf7d9e'
    default:
      return 'var(--muted)'
  }
}

/** Human label for a page-type group heading. */
export function pageTypeLabel(pageType: string | null): string {
  if (!pageType) return 'Other'
  return pageType.charAt(0).toUpperCase() + pageType.slice(1)
}
