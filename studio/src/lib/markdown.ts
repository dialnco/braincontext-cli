/**
 * HTML ⇄ Markdown for the editor. `htmlToMarkdown` is the source of the markdown
 * we PATCH to the server (and show in the dual pane); wikilink pills become
 * `[[Title]]` so the server can re-derive the link graph. `markdownToHtml` renders
 * a stored markdown body back into the styled editor DOM on load.
 *
 * These run in the browser (they use the DOM), but stay free of React/editor state
 * so they're unit-testable with jsdom.
 */
import { S } from './theme'
import { wlSpan } from './wikilinks'

function esc(t: string): string {
  const d = document.createElement('div')
  d.textContent = t
  return d.innerHTML
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
        } else if (t === 'STRONG' || t === 'B') s += `**${inline(el)}**`
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
      const rows = [...el.querySelectorAll('tr')]
      if (rows.length) {
        const lines: string[] = []
        rows.forEach((tr, ri) => {
          const cells = [...tr.children].map((c) =>
            inline(c).trim().replace(/\|/g, '\\|').replace(/\n/g, ' '),
          )
          lines.push(`| ${cells.join(' | ')} |`)
          if (ri === 0) lines.push(`| ${cells.map(() => '---').join(' | ')} |`)
        })
        out.push(lines.join('\n'))
      }
    } else if (t === 'HR') out.push('---')
    else if (t === 'DIV') {
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
  return out.join('\n\n')
}

/** Minimal markdown→styled-HTML for loading a stored body into the editor. Supports
 *  the block + inline subset the editor itself produces (headings, lists, tasks,
 *  quotes, code, hr, callouts, bold/italic/code, ==highlight==, [[wikilinks]]). */
export function markdownToHtml(md: string, resolveTitle: (title: string) => string): string {
  const lines = (md ?? '').replace(/\r\n/g, '\n').split('\n')
  const blocks: string[] = []
  let i = 0

  const renderInline = (text: string): string => {
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
    // GFM table: a pipe row immediately followed by a `|---|---|` delimiter row.
    if (line.includes('|') && isTableDelim(at(i + 1))) {
      const header = splitRow(line)
      i += 2 // header + delimiter
      const rows: string[][] = []
      while (i < lines.length && at(i).trim() && at(i).includes('|')) rows.push(splitRow(at(i++)))
      blocks.push(tableHtml(header, rows, renderInline))
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
  return blocks.join('\n') || `<p style="${S.p}"><br></p>`
}

/** True if `s` is a GFM table delimiter row (e.g. `|---|:--:|`), not a `---` rule. */
function isTableDelim(s: string): boolean {
  const t = (s ?? '').trim()
  if (!t.includes('|') || !t.includes('-')) return false
  return splitRow(t).every((c) => /^:?-+:?$/.test(c))
}

/** Split a table row into trimmed cells, dropping optional outer pipes and
 *  honouring escaped `\|` so it round-trips with the serializer. */
function splitRow(s: string): string[] {
  return s
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|'))
}

function tableHtml(
  header: string[],
  rows: string[][],
  renderInline: (text: string) => string,
): string {
  const head = header.map((c) => `<th style="${S.th}">${renderInline(c)}</th>`).join('')
  const body = rows
    .map(
      (r) =>
        `<tr>${header.map((_, ci) => `<td style="${S.td}">${renderInline(r[ci] ?? '')}</td>`).join('')}</tr>`,
    )
    .join('')
  return `<table style="${S.table}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
}

function taskHtml(inner: string, checked: boolean): string {
  const box = `<span class="task-box" contenteditable="false" data-checked="${checked ? '1' : '0'}" style="width:17px;height:17px;border:1.6px solid ${checked ? 'var(--accent)' : 'var(--muted)'};border-radius:5px;flex:0 0 17px;margin-top:3px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;${checked ? 'background:var(--accent);' : ''}">${checked ? '<span style="color:#fff;font-size:11px;line-height:1;">✓</span>' : ''}</span>`
  return `<div style="${S.task}">${box}<span style="flex:1;">${inner}</span></div>`
}
