/**
 * HTML ⇄ Markdown for the editor. `htmlToMarkdown` is the source of the markdown
 * we PATCH to the server (and show in the dual pane); wikilink pills become
 * `[[Title]]` so the server can re-derive the link graph. `markdownToHtml` renders
 * a stored markdown body back into the styled editor DOM on load.
 *
 * These run in the browser (they use the DOM), but stay free of React/editor state
 * so they're unit-testable with jsdom.
 */
import { type Align, isTableDelim, serializeTable, splitRow } from '@core/lib/mdtable'
import { S } from './theme'
import { wlSpan } from './wikilinks'

function esc(t: string): string {
  const d = document.createElement('div')
  d.textContent = t
  // textContent→innerHTML escapes & < > but NOT quotes; this helper is interpolated
  // into attribute values (alt, data-embed-title), where an unescaped `"` breaks out
  // of the attribute and lets `onerror=…` land on the element itself.
  return d.innerHTML.replace(/"/g, '&quot;')
}

/** Strict whitelist for file references: a ULID (Crockford base32, 26 chars). */
const FILE_ID = '[0-9A-HJKMNP-TV-Z]{26}'
const FILE_ID_EXACT = new RegExp(`^${FILE_ID}$`)

/**
 * The ONLY thing that ever renders as an <img>: `![alt](bctx-file://<ULID>)`.
 * The src is constructed from the validated ULID — never from user-supplied URLs —
 * so `![x](javascript:…)` / `![x](https://…)` stay literal text (XSS-safe by
 * construction; alt is escaped).
 */
export function fileImgHtml(id: string, alt: string): string {
  return `<img src="/api/files/${id}/content" alt="${esc(alt)}" data-file-id="${id}" style="max-width:100%;border-radius:9px;">`
}

/** Serialize a whitelisted file <img> back to markdown; any other <img> is dropped. */
function imgMd(el: HTMLElement): string {
  const id = el.getAttribute('data-file-id') || ''
  if (!FILE_ID_EXACT.test(id)) return ''
  const alt = (el.getAttribute('alt') || '').replace(/[\]\n]/g, ' ')
  return `![${alt}](bctx-file://${id})`
}

/** Serialize editor HTML to markdown. Mirrors the reference html2md, with wikilinks
 *  emitted by stored title (data-title) so a renamed/unresolved link round-trips. */
export function htmlToMarkdown(html: string): string {
  const root = document.createElement('div')
  root.innerHTML = html

  const inline = (node: Node): string => {
    let s = ''
    node.childNodes.forEach((c) => {
      if (c.nodeType === 3) {
        s += c.nodeValue
      } else if (c.nodeType === 1) {
        const el = c as HTMLElement
        const t = el.tagName
        if (el.hasAttribute('data-link')) {
          s += `[[${el.getAttribute('data-title') || el.textContent}]]`
        } else if (t === 'IMG') s += imgMd(el)
        else if (t === 'STRONG' || t === 'B') s += `**${inline(el)}**`
        else if (t === 'EM' || t === 'I') s += `*${inline(el)}*`
        else if (t === 'CODE') s += `\`${el.textContent}\``
        else if (t === 'BR') s += '\n'
        else if (t === 'SPAN') {
          const st = el.getAttribute('style') || ''
          if (/code-bg/.test(st)) s += `\`${el.textContent}\``
          else if (/accent-soft/.test(st)) s += `==${el.textContent}==`
          else s += inline(el)
        } else s += inline(el)
      }
    })
    return s
  }

  const out: string[] = []
  root.childNodes.forEach((node) => {
    if (node.nodeType !== 1) {
      const tx = (node.nodeValue || '').trim()
      if (tx) out.push(tx)
      return
    }
    const el = node as HTMLElement
    const t = el.tagName
    const st = el.getAttribute('style') || ''
    if (t === 'H1') out.push(`# ${inline(el)}`)
    else if (t === 'H2') out.push(`## ${inline(el)}`)
    else if (t === 'H3') out.push(`### ${inline(el)}`)
    else if (t === 'P') out.push(inline(el))
    else if (t === 'BLOCKQUOTE') out.push(`> ${inline(el).replace(/\n/g, '\n> ')}`)
    else if (t === 'UL') {
      for (const li of el.querySelectorAll(':scope > li')) out.push(`- ${inline(li)}`)
    } else if (t === 'OL') {
      let i = 1
      for (const li of el.querySelectorAll(':scope > li')) out.push(`${i++}. ${inline(li)}`)
    } else if (t === 'PRE') out.push(`\`\`\`\n${el.textContent?.replace(/\n+$/, '')}\n\`\`\``)
    else if (t === 'TABLE') {
      // Delegate framing/escaping/alignment to the shared serializer (one grammar with
      // the CLI); alignment survives via the data-align stamped on header cells.
      const trs = [...el.querySelectorAll('tr')]
      const head = trs[0]
      if (head) {
        const cellText = (c: Element) => inline(c).trim()
        const header = [...head.children].map(cellText)
        const alignments = [...head.children].map((c) => {
          const a = (c as HTMLElement).getAttribute('data-align')
          return a === 'left' || a === 'right' || a === 'center' ? a : null
        })
        const bodyRows = trs.slice(1).map((tr) => [...tr.children].map(cellText))
        out.push(serializeTable({ header, alignments, rows: bodyRows }))
      }
    } else if (t === 'HR') out.push('---')
    else if (t === 'IMG') {
      const md = imgMd(el)
      if (md) out.push(md)
    } else if (t === 'DIV') {
      // An embed placeholder round-trips to its `![[Title]]` marker — never serialize the
      // hydrated table inside it (that would inline the datatable into the consuming page).
      if (el.hasAttribute('data-embed-title')) {
        out.push(`![[${el.getAttribute('data-embed-title')}]]`)
        return
      }
      // Same rule for file-attachment placeholders (hydrated card is never serialized).
      if (el.hasAttribute('data-file-embed')) {
        const id = el.getAttribute('data-file-embed') || ''
        const name = el.getAttribute('data-file-name') || ''
        out.push(`![[file:${id}${name ? `|${name}` : ''}]]`)
        return
      }
      const box = el.querySelector(':scope > .task-box')
      if (/accent-soft/.test(st) && el.querySelector('p')) {
        const label = (el.firstElementChild?.textContent || '').replace(/[^A-Za-z]/g, '') || 'note'
        const body = [...el.querySelectorAll(':scope > p')]
          .map((p) => inline(p))
          .join('\n')
          .replace(/\n/g, '\n> ')
        out.push(`> [!${label.toLowerCase()}] ${body}`)
      } else if (box) {
        const span = el.querySelector(':scope > span:last-child')
        const ch = box.getAttribute('data-checked') === '1'
        out.push(`- [${ch ? 'x' : ' '}] ${span ? inline(span) : ''}`)
      } else out.push(inline(el))
    } else out.push(inline(el))
  })
  // Drop trailing empty blocks (e.g. the empty paragraph markdownToHtml appends after a
  // trailing atom so the caret isn't trapped) so the markdown round-trip stays byte-stable.
  while (out.length && !out[out.length - 1]?.trim()) out.pop()
  return out.join('\n\n')
}

/** Minimal markdown→styled-HTML for loading a stored body into the editor. Supports
 *  the block + inline subset the editor itself produces (headings, lists, tasks,
 *  quotes, code, hr, callouts, bold/italic/code, ==highlight==, [[wikilinks]]). */
export function markdownToHtml(md: string, resolveTitle: (title: string) => string): string {
  const lines = (md ?? '').replace(/\r\n/g, '\n').split('\n')
  const blocks: string[] = []
  let i = 0

  const renderLinks = (text: string): string => {
    // Pull wikilinks out first so their inner text isn't re-escaped/formatted.
    const parts: string[] = []
    let last = 0
    const re = /\[\[([^[\]\n|]+)(?:\|([^[\]\n]+))?\]\]/g
    let m: RegExpExecArray | null = re.exec(text)
    while (m) {
      parts.push(fmt(esc(text.slice(last, m.index))))
      const title = (m[1] ?? '').trim()
      parts.push(wlSpan(resolveTitle(title), m[2]?.trim() || title))
      last = m.index + m[0].length
      m = re.exec(text)
    }
    parts.push(fmt(esc(text.slice(last))))
    return parts.join('')
  }
  const renderInline = (text: string): string => {
    // File images are pulled out before everything else (same technique as wikilinks);
    // only the validated bctx-file ULID form ever becomes an <img> — see fileImgHtml.
    const parts: string[] = []
    let last = 0
    const re = new RegExp(`!\\[([^\\]\\n]*)\\]\\(bctx-file://(${FILE_ID})\\)`, 'g')
    let m: RegExpExecArray | null = re.exec(text)
    while (m) {
      parts.push(renderLinks(text.slice(last, m.index)))
      parts.push(fileImgHtml(m[2] ?? '', m[1] ?? ''))
      last = m.index + m[0].length
      m = re.exec(text)
    }
    parts.push(renderLinks(text.slice(last)))
    return parts.join('')
  }
  const fmt = (s: string): string =>
    s
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(
        /==([^=]+)==/g,
        `<span style="background:var(--accent-soft);border-radius:3px;padding:0 3px;">$1</span>`,
      )
      .replace(/`([^`]+)`/g, `<span style="${S.ic}">$1</span>`)

  const at = (j: number): string => lines[j] ?? ''
  while (i < lines.length) {
    const line = at(i)
    if (!line.trim()) {
      i++
      continue
    }
    if (line.startsWith('```')) {
      const buf: string[] = []
      i++
      while (i < lines.length && !at(i).startsWith('```')) buf.push(at(i++))
      i++ // closing fence
      blocks.push(`<pre style="${S.code}">${esc(buf.join('\n'))}</pre>`)
      continue
    }
    // A file attachment on its own line — `![[file:<ULID>|name]]` — becomes a placeholder
    // card that WikiEditor hydrates from /api/files metadata (PDF viewer / download card).
    // Checked BEFORE the generic transclusion so `file:` never resolves as a page title.
    const fileEmbedMatch = new RegExp(
      `^\\s*!\\[\\[\\s*file:(${FILE_ID})\\s*(?:\\|([^\\]]*))?\\]\\]\\s*$`,
      'i',
    ).exec(line)
    if (fileEmbedMatch?.[1]) {
      blocks.push(fileEmbedHtml(fileEmbedMatch[1].toUpperCase(), (fileEmbedMatch[2] ?? '').trim()))
      i++
      continue
    }
    // A transclusion on its own line — `![[Title]]` — becomes a non-editable embed placeholder
    // that WikiEditor hydrates with the referenced datatable's rendered table. The wrapper keeps
    // the title so htmlToMarkdown re-emits `![[Title]]` verbatim (autosave never clobbers it).
    const embedMatch = /^\s*!\[\[\s*([^\]|]+?)\s*(?:\|[^\]]*)?\]\]\s*$/.exec(line)
    if (embedMatch?.[1]) {
      blocks.push(embedHtml(embedMatch[1].trim()))
      i++
      continue
    }
    // GFM table: a pipe row immediately followed by a `|---|---|` delimiter row.
    if (line.includes('|') && isTableDelim(at(i + 1))) {
      const header = splitRow(line)
      const alignments = splitRow(at(i + 1)).map(alignOf)
      i += 2 // header + delimiter
      const rows: string[][] = []
      while (i < lines.length && at(i).trim() && at(i).includes('|')) rows.push(splitRow(at(i++)))
      blocks.push(tableHtml(header, rows, alignments, renderInline))
      continue
    }
    if (/^#\s/.test(line)) blocks.push(`<h1 style="${S.h1}">${renderInline(line.slice(2))}</h1>`)
    else if (/^##\s/.test(line))
      blocks.push(`<h2 style="${S.h2}">${renderInline(line.slice(3))}</h2>`)
    else if (/^###\s/.test(line))
      blocks.push(`<h3 style="${S.h3}">${renderInline(line.slice(4))}</h3>`)
    else if (/^(---|\*\*\*)\s*$/.test(line)) blocks.push(`<hr style="${S.hr}">`)
    else if (/^\s*[-*]\s\[[ xX]\]\s/.test(line)) {
      const checked = /\[[xX]\]/.test(line)
      const text = line.replace(/^\s*[-*]\s\[[ xX]\]\s/, '')
      blocks.push(taskHtml(renderInline(text), checked))
    } else if (/^\s*[-*]\s/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*]\s/.test(at(i)) && !/^\s*[-*]\s\[[ xX]\]/.test(at(i))) {
        items.push(`<li style="${S.li}">${renderInline(at(i).replace(/^\s*[-*]\s/, ''))}</li>`)
        i++
      }
      blocks.push(`<ul style="${S.ul}">${items.join('')}</ul>`)
      continue
    } else if (/^>\s?/.test(line)) {
      const buf: string[] = []
      while (i < lines.length && /^>\s?/.test(at(i))) buf.push(at(i++).replace(/^>\s?/, ''))
      blocks.push(`<blockquote style="${S.quote}">${renderInline(buf.join(' '))}</blockquote>`)
      continue
    } else blocks.push(`<p style="${S.p}">${renderInline(line)}</p>`)
    i++
  }
  // A non-editable atom (file/table embed) or a bare <hr>/<table> as the LAST block
  // leaves no caret position after it in contenteditable, trapping the user. Append an
  // empty paragraph so there's always somewhere to click/type below. It serializes to
  // nothing (htmlToMarkdown trims trailing empties), so the round-trip stays stable.
  const last = blocks[blocks.length - 1]
  if (last && (last.includes('contenteditable="false"') || /^<(hr|table)\b/.test(last))) {
    blocks.push(`<p style="${S.p}"><br></p>`)
  }
  return blocks.join('\n') || `<p style="${S.p}"><br></p>`
}

/** Column alignment from a GFM delimiter cell (`:--` left, `:-:` center, `--:` right). */
function alignOf(cell: string): Align | null {
  const l = cell.startsWith(':')
  const r = cell.endsWith(':')
  return l && r ? 'center' : r ? 'right' : l ? 'left' : null
}

function tableHtml(
  header: string[],
  rows: string[][],
  alignments: Array<Align | null>,
  renderInline: (text: string) => string,
): string {
  // Stamp text-align (visual) + data-align (so htmlToMarkdown re-emits the alignment) +
  // data-r/data-c (so the editor can address a single cell without re-serializing the body).
  const styleFor = (ci: number) => `${S.td}${alignments[ci] ? `;text-align:${alignments[ci]}` : ''}`
  const head = header
    .map(
      (c, ci) =>
        `<th style="${S.th}${alignments[ci] ? `;text-align:${alignments[ci]}` : ''}" data-align="${alignments[ci] ?? ''}" data-c="${ci}">${renderInline(c)}</th>`,
    )
    .join('')
  const body = rows
    .map(
      (r, ri) =>
        `<tr>${header.map((_, ci) => `<td style="${styleFor(ci)}" data-r="${ri}" data-c="${ci}">${renderInline(r[ci] ?? '')}</td>`).join('')}</tr>`,
    )
    .join('')
  return `<table style="${S.table}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
}

/**
 * A non-editable placeholder for a `![[file:<id>|name]]` attachment; WikiEditor hydrates
 * it into a download card / inline PDF viewer. Uses `data-file-embed` (NOT
 * `data-embed-title`) so the datatable hydrator never touches it.
 */
export function fileEmbedHtml(id: string, name: string): string {
  return `<div class="file-embed" data-file-embed="${id}" data-file-name="${esc(name)}" contenteditable="false" style="margin:0 0 20px;border:1px solid var(--border);border-radius:11px;overflow:hidden;"><div style="display:flex;align-items:center;gap:8px;padding:9px 14px;background:var(--code-bg);font:600 12px/1 'IBM Plex Mono',monospace;color:var(--muted);"><span>📎 ${esc(name || 'attachment')}</span></div><div style="padding:12px 14px;font:400 14px/1.5 'Spectral',serif;color:var(--muted);">Loading attachment…</div></div>`
}

/** A non-editable placeholder for a `![[Title]]` embed; WikiEditor hydrates the table into it. */
function embedHtml(title: string): string {
  return `<div class="embed" data-embed-title="${esc(title)}" contenteditable="false" style="margin:0 0 20px;border:1px solid var(--border);border-radius:11px;overflow:hidden;"><div style="display:flex;align-items:center;gap:8px;padding:9px 14px;background:var(--code-bg);border-bottom:1px solid var(--border);font:600 12px/1 'IBM Plex Mono',monospace;color:var(--muted);"><span>▦ ${esc(title)}</span></div><div style="padding:12px 14px;font:400 14px/1.5 'Spectral',serif;color:var(--muted);">Loading embedded table…</div></div>`
}

function taskHtml(inner: string, checked: boolean): string {
  const box = `<span class="task-box" contenteditable="false" data-checked="${checked ? '1' : '0'}" style="width:17px;height:17px;border:1.6px solid ${checked ? 'var(--accent)' : 'var(--muted)'};border-radius:5px;flex:0 0 17px;margin-top:3px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;${checked ? 'background:var(--accent);' : ''}">${checked ? '<span style="color:#fff;font-size:11px;line-height:1;">✓</span>' : ''}</span>`
  return `<div style="${S.task}">${box}<span style="flex:1;">${inner}</span></div>`
}
