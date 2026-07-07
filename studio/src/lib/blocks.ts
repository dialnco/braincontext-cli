/**
 * Editor block-level DOM primitives, ported from the reference editor and
 * parameterized by the contenteditable element (`ed`) instead of `this._ed`. These
 * are the imperative operations the Editor component composes (slash menu, space-
 * shortcut transforms, the block-type switcher). Selection/format/link coordination
 * that also touches React state stays in the Editor component.
 */
import { S } from './theme'

export type BlockType =
  | 'p'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'quote'
  | 'ul'
  | 'task'
  | 'code'
  | 'callout'
  | 'hr'

function sel(): Selection | null {
  return window.getSelection()
}

/** The top-level block element containing the caret, or null. */
export function currentBlock(ed: HTMLElement): HTMLElement | null {
  const s = sel()
  if (!s?.rangeCount) return null
  let node: Node | null = s.getRangeAt(0).startContainer
  if (node === ed) {
    const off = s.getRangeAt(0).startOffset
    node = ed.childNodes[off] || ed.lastChild
  }
  while (node?.parentNode && node.parentNode !== ed) node = node.parentNode
  if (!node || node === ed) return null
  return node.nodeType === 1 ? (node as HTMLElement) : null
}

export function textBeforeCaret(blk: HTMLElement): string {
  const s = sel()
  if (!s?.rangeCount) return ''
  const r = s.getRangeAt(0)
  const pre = document.createRange()
  pre.selectNodeContents(blk)
  try {
    pre.setEnd(r.startContainer, r.startOffset)
  } catch {
    return ''
  }
  return pre.toString()
}

export function stripLeading(blk: HTMLElement, n: number): void {
  const w = document.createTreeWalker(blk, NodeFilter.SHOW_TEXT)
  const tn = w.nextNode()
  if (tn) tn.nodeValue = (tn.nodeValue ?? '').slice(n)
}

/** Give an emptied element a <br> so the caret can rest in it (contentEditable quirk). */
export function fill(el: HTMLElement): void {
  if (!el.firstChild || el.textContent === '') {
    while (el.firstChild) el.removeChild(el.firstChild)
    el.appendChild(document.createElement('br'))
  }
}

export function caretToStart(el: HTMLElement): void {
  const r = document.createRange()
  r.selectNodeContents(el)
  r.collapse(true)
  const s = sel()
  if (!s) return
  s.removeAllRanges()
  s.addRange(r)
}

export function isTask(b: HTMLElement): boolean {
  return b.tagName === 'DIV' && !!b.querySelector(':scope > .task-box')
}
export function isCallout(b: HTMLElement): boolean {
  return b.tagName === 'DIV' && !isTask(b) && /accent-soft/.test(b.getAttribute('style') || '')
}
export function blockTypeOf(b: HTMLElement): BlockType {
  const t = b.tagName
  if (t === 'H1') return 'h1'
  if (t === 'H2') return 'h2'
  if (t === 'H3') return 'h3'
  if (t === 'BLOCKQUOTE') return 'quote'
  if (t === 'UL' || t === 'OL') return 'ul'
  if (t === 'PRE') return 'code'
  if (t === 'HR') return 'hr'
  if (isTask(b)) return 'task'
  if (isCallout(b)) return 'callout'
  return 'p'
}

export function makeTask(html: string, checked: boolean): HTMLElement {
  const div = document.createElement('div')
  div.setAttribute('style', S.task)
  const box = document.createElement('span')
  box.className = 'task-box'
  box.setAttribute('contenteditable', 'false')
  box.setAttribute('data-checked', checked ? '1' : '0')
  box.setAttribute(
    'style',
    `width:17px;height:17px;border:1.6px solid ${checked ? 'var(--accent)' : 'var(--muted)'};border-radius:5px;flex:0 0 17px;margin-top:3px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;${checked ? 'background:var(--accent);' : ''}`,
  )
  if (checked) box.innerHTML = '<span style="color:#fff;font-size:11px;line-height:1;">✓</span>'
  const span = document.createElement('span')
  span.setAttribute('style', 'flex:1;')
  span.innerHTML = html?.trim() ? html : '<br>'
  div.appendChild(box)
  div.appendChild(span)
  return div
}

export function makeCallout(lines: string[], title: string): HTMLElement {
  const d = document.createElement('div')
  d.setAttribute('style', S.callout)
  const tt = document.createElement('div')
  tt.setAttribute('style', S.cT)
  tt.textContent = title?.trim() ? title : '◆  Note'
  d.appendChild(tt)
  for (const h of lines) {
    const p = document.createElement('p')
    p.setAttribute('style', S.cP)
    p.innerHTML = h?.trim() ? h : '<br>'
    d.appendChild(p)
  }
  return d
}

/** Transform the block at the caret into `type` (single-block shortcut path). */
export function transformBlock(blk: HTMLElement, type: BlockType): void {
  if (type === 'ul') {
    const li = document.createElement('li')
    li.setAttribute('style', S.li)
    while (blk.firstChild) li.appendChild(blk.firstChild)
    fill(li)
    const prev = blk.previousElementSibling
    if (prev && prev.tagName === 'UL') {
      prev.appendChild(li)
      blk.remove()
    } else {
      const ul = document.createElement('ul')
      ul.setAttribute('style', S.ul)
      ul.appendChild(li)
      blk.replaceWith(ul)
    }
    caretToStart(li)
    return
  }
  if (type === 'task') {
    const span = document.createElement('span')
    span.setAttribute('style', 'flex:1;')
    while (blk.firstChild) span.appendChild(blk.firstChild)
    fill(span)
    const div = makeTask(span.innerHTML, false)
    blk.replaceWith(div)
    caretToStart(div.querySelector(':scope > span:last-child') as HTMLElement)
    return
  }
  if (type === 'hr') {
    const hr = document.createElement('hr')
    hr.setAttribute('style', S.hr)
    const p = document.createElement('p')
    p.setAttribute('style', S.p)
    p.appendChild(document.createElement('br'))
    blk.replaceWith(hr)
    hr.after(p)
    caretToStart(p)
    return
  }
  if (type === 'code') {
    const pre = document.createElement('pre')
    pre.setAttribute('style', S.code)
    pre.textContent = blk.textContent || ' '
    blk.replaceWith(pre)
    caretToStart(pre)
    return
  }
  if (type === 'callout') {
    const p = document.createElement('p')
    p.setAttribute('style', S.cP)
    while (blk.firstChild) p.appendChild(blk.firstChild)
    fill(p)
    const d = makeCallout([p.innerHTML], '')
    blk.replaceWith(d)
    caretToStart(d.querySelector(':scope > p') as HTMLElement)
    return
  }
  const map: Record<string, [string, string]> = {
    h1: ['h1', S.h1],
    h2: ['h2', S.h2],
    h3: ['h3', S.h3],
    quote: ['blockquote', S.quote],
    p: ['p', S.p],
  }
  const [tag, style] = map[type] ?? (['p', S.p] as [string, string])
  const el = document.createElement(tag)
  el.setAttribute('style', style)
  while (blk.firstChild) el.appendChild(blk.firstChild)
  fill(el)
  blk.replaceWith(el)
  caretToStart(el)
}

/** A slash-menu row: either a block transform (`type`) or a non-block action (`action`). */
export interface SlashItem {
  label: string
  hint: string
  type?: BlockType
  /** A non-block action (currently only 'attach', which opens the file picker). */
  action?: 'attach'
}

/** The slash-menu insertable block list. */
export const SLASH_ITEMS: SlashItem[] = [
  { label: 'Heading 1', hint: '#', type: 'h1' },
  { label: 'Heading 2', hint: '##', type: 'h2' },
  { label: 'Heading 3', hint: '###', type: 'h3' },
  { label: 'To-do', hint: '[ ]', type: 'task' },
  { label: 'Bullet list', hint: '–', type: 'ul' },
  { label: 'Quote', hint: '“', type: 'quote' },
  { label: 'Code block', hint: '</>', type: 'code' },
  { label: 'Callout', hint: '◆', type: 'callout' },
  { label: 'Divider', hint: '—', type: 'hr' },
]

/** The block-type-switcher options (toolbar dropdown). */
export const BLOCK_OPTIONS: { type: BlockType; label: string; hint: string }[] = [
  { type: 'p', label: 'Text', hint: '¶' },
  { type: 'h1', label: 'Heading 1', hint: 'H1' },
  { type: 'h2', label: 'Heading 2', hint: 'H2' },
  { type: 'h3', label: 'Heading 3', hint: 'H3' },
  { type: 'quote', label: 'Quote', hint: '“' },
  { type: 'ul', label: 'Bullet list', hint: '•' },
  { type: 'task', label: 'To-do', hint: '✓' },
  { type: 'code', label: 'Code', hint: '</>' },
  { type: 'callout', label: 'Callout', hint: '◆' },
]

export function blockLabel(type: string): string {
  return BLOCK_OPTIONS.find((o) => o.type === type)?.label ?? (type === 'mixed' ? 'Mixed' : 'Text')
}

export interface MenuPos {
  left: number
  top: number
  maxH: number
}

/** Place a floating menu near the caret rect, flipping above when needed. */
export function placeMenu(
  hero: HTMLElement,
  rect: DOMRect,
  width: number,
  rowCount: number,
  rowH: number,
  chromeH: number,
): MenuPos {
  const hr = hero.getBoundingClientRect()
  const sc = hr.width / (hero.offsetWidth || 1) || 1
  const H = hero.offsetHeight
  const Wd = hero.offsetWidth
  let left = (rect.left - hr.left) / sc
  left = Math.max(8, Math.min(left, Wd - width - 8))
  const caretTop = (rect.top - hr.top) / sc
  const caretBottom = (rect.bottom - hr.top) / sc
  const gap = 6
  const estH = chromeH + rowCount * rowH
  const spaceBelow = H - caretBottom - gap - 8
  const spaceAbove = caretTop - gap - 8
  let top: number
  let maxH: number
  if (estH <= spaceBelow || spaceBelow >= spaceAbove) {
    top = caretBottom + gap
    maxH = Math.min(estH, Math.max(120, spaceBelow))
  } else {
    maxH = Math.min(estH, Math.max(120, spaceAbove))
    top = Math.max(8, caretTop - gap - maxH)
  }
  return { left, top, maxH }
}
