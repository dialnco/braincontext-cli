import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Context } from '../api/types'
import {
  BLOCK_OPTIONS,
  type BlockType,
  blockLabel,
  blockTypeOf,
  currentBlock,
  isCallout,
  isTask,
  type MenuPos,
  placeMenu,
  SLASH_ITEMS,
  stripLeading,
  textBeforeCaret,
  transformBlock,
} from '../lib/blocks'
import { sx } from '../lib/dc'
import { htmlToMarkdown, markdownToHtml } from '../lib/markdown'
import { S } from '../lib/theme'
import { wlSpan } from '../lib/wikilinks'
import { type SaveStatus, useAutosave } from '../state/useAutosave'

interface Fmt {
  bold: boolean
  italic: boolean
  code: boolean
  highlight: boolean
  link: boolean
}
interface FloatMenu extends MenuPos {
  open: boolean
  q: string
  idx: number
}
interface SelBar {
  open: boolean
  left: number
  top: number
  fmt: Fmt
  blockType: string
  blockOpen: boolean
}
interface Preview {
  open: boolean
  left: number
  top: number
  page: Context | null
}

type LinkRow =
  | { kind: 'page'; id: string; title: string; sub: string }
  | { kind: 'new'; id: string; title: string; sub: string }

const CLOSED_MENU: FloatMenu = { open: false, q: '', idx: 0, left: 0, top: 0, maxH: 0 }

export interface WikiEditorHandle {
  flush: () => Promise<void>
}

interface Props {
  page: Context
  pages: Context[]
  dual: boolean
  readOnly?: boolean
  onSave: (markdown: string) => Promise<void>
  onOpenPage: (id: string) => void
  /** Create a page by title, returning it (or null on failure). */
  onCreatePage: (title: string) => Promise<Context | null>
  /** Called after a successful save so the parent can refetch links/backlinks. */
  onSaved?: (status: SaveStatus) => void
  /** Expose the autosave flush so the parent can force a save on navigate/switch. */
  handleRef?: React.MutableRefObject<WikiEditorHandle | null>
}

/**
 * The braincontext wiki editor: a contenteditable surface that loads a page body
 * (markdown → styled HTML), and on edit debounces a 10s autosave of the body back
 * as markdown (the server re-derives `[[..]]` links). Slash menu, wikilink
 * autocomplete, selection toolbar, and hover previews are all bound to live pages.
 */
export function WikiEditor({
  page,
  pages,
  dual,
  readOnly,
  onSave,
  onOpenPage,
  onCreatePage,
  onSaved,
  handleRef,
}: Props) {
  const edRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const anchor = useRef<{ node: Node; start: number } | null>(null)
  const slashBlk = useRef<HTMLElement | null>(null)
  const [linkMenu, setLinkMenu] = useState<FloatMenu>(CLOSED_MENU)
  const [slashMenu, setSlashMenu] = useState<FloatMenu>(CLOSED_MENU)
  const [selBar, setSelBar] = useState<SelBar>({
    open: false,
    left: 0,
    top: 0,
    fmt: emptyFmt(),
    blockType: 'p',
    blockOpen: false,
  })
  const [preview, setPreview] = useState<Preview>({ open: false, left: 0, top: 0, page: null })
  const [md, setMd] = useState('')
  const [words, setWords] = useState(0)
  const [mdCopied, setMdCopied] = useState(false)

  const pagesRef = useRef(pages)
  pagesRef.current = pages

  const resolveTitle = useCallback((title: string): string => {
    const hit = pagesRef.current.find((p) => (p.title ?? '').toLowerCase() === title.toLowerCase())
    return hit?.id ?? ''
  }, [])

  const autosave = useAutosave(onSave)
  useEffect(() => {
    if (handleRef) handleRef.current = { flush: autosave.flush }
  }, [handleRef, autosave.flush])
  useEffect(() => {
    onSaved?.(autosave.status)
  }, [autosave.status, onSaved])

  // Load the page body into the editor when the active page changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-render on page identity + body
  useEffect(() => {
    const ed = edRef.current
    if (!ed) return
    ed.innerHTML = markdownToHtml(page.body, resolveTitle)
    ed.scrollTop = 0
    setWords((ed.textContent?.trim().match(/\S+/g) || []).length)
  }, [page.id])

  // Sync the dual-pane markdown source when it opens or the page changes. Without
  // this it's only refreshed on edit, so toggling dual on a loaded page is blank.
  // page.id is read indirectly (the load effect rewrites the editor on nav).
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-sync on page change
  useEffect(() => {
    const ed = edRef.current
    if (dual && ed) setMd(htmlToMarkdown(ed.innerHTML))
  }, [dual, page.id])

  const persist = useCallback(() => {
    const ed = edRef.current
    if (!ed) return
    setWords((ed.textContent?.trim().match(/\S+/g) || []).length)
    autosave.schedule(htmlToMarkdown(ed.innerHTML))
    if (dual) setMd(htmlToMarkdown(ed.innerHTML))
  }, [autosave, dual])

  // --- wikilink autocomplete ([[) ---
  const closeLinkMenu = useCallback(() => {
    anchor.current = null
    setLinkMenu((m) => ({ ...m, open: false }))
  }, [])

  const linkRows = useCallback(
    (q: string): LinkRow[] => {
      const ql = q.toLowerCase()
      let list = pagesRef.current.filter((p) => p.id !== page.id)
      if (ql) list = list.filter((p) => (p.title ?? '').toLowerCase().includes(ql))
      const rows: LinkRow[] = list
        .slice(0, 6)
        .map((p) => ({ kind: 'page', id: p.id, title: p.title ?? p.id, sub: p.pageType ?? 'page' }))
      if (ql && !pagesRef.current.find((p) => (p.title ?? '').toLowerCase() === ql)) {
        rows.push({ kind: 'new', id: '', title: q, sub: 'new page' })
      }
      return rows
    },
    [page.id],
  )

  const maybeLink = useCallback(() => {
    const ed = edRef.current
    const host = hostRef.current
    const s = window.getSelection()
    if (!ed || !host || !s?.rangeCount) return closeLinkMenu()
    const range = s.getRangeAt(0)
    if (!range.collapsed || range.startContainer.nodeType !== 3) return closeLinkMenu()
    const node = range.startContainer
    const text = (node.textContent ?? '').slice(0, range.startOffset)
    const m = text.match(/\[\[([^[\]\n]*)$/)
    if (!m) return closeLinkMenu()
    const q = m[1] ?? ''
    anchor.current = { node, start: range.startOffset - m[0].length }
    const rows = linkRows(q)
    const pos = placeMenu(host, range.getBoundingClientRect(), 288, rows.length, 34, 30)
    setLinkMenu((prev) => ({
      open: true,
      q,
      idx: prev.open && prev.q === q ? Math.min(prev.idx, Math.max(0, rows.length - 1)) : 0,
      ...pos,
    }))
  }, [closeLinkMenu, linkRows])

  const replaceAnchor = useCallback(
    (html: string) => {
      const a = anchor.current
      const ed = edRef.current
      const s = window.getSelection()
      if (!a || !ed || !s?.rangeCount) return
      const cur = s.getRangeAt(0)
      const r = document.createRange()
      r.setStart(a.node, a.start)
      r.setEnd(cur.startContainer, cur.startOffset)
      r.deleteContents()
      const tpl = document.createElement('template')
      tpl.innerHTML = `${html} `
      const last = tpl.content.lastChild
      r.insertNode(tpl.content)
      if (last) {
        const nr = document.createRange()
        nr.setStartAfter(last)
        nr.collapse(true)
        s.removeAllRanges()
        s.addRange(nr)
      }
      anchor.current = null
      setLinkMenu((m) => ({ ...m, open: false }))
      persist()
      ed.focus()
    },
    [persist],
  )

  const insertExisting = useCallback(
    (p: Context) => replaceAnchor(wlSpan(p.id, p.title ?? p.id)),
    [replaceAnchor],
  )
  const insertNew = useCallback(
    async (title: string) => {
      const created = await onCreatePage(title)
      replaceAnchor(wlSpan(created?.id ?? '', title))
    },
    [onCreatePage, replaceAnchor],
  )

  // --- slash menu ---
  const closeSlash = useCallback(() => {
    slashBlk.current = null
    setSlashMenu((m) => ({ ...m, open: false }))
  }, [])

  const maybeSlash = useCallback(() => {
    const ed = edRef.current
    const host = hostRef.current
    const s = window.getSelection()
    if (!ed || !host || !s?.rangeCount) return closeSlash()
    const r = s.getRangeAt(0)
    if (!r.collapsed) return closeSlash()
    const blk = currentBlock(ed)
    if (!blk || blk.tagName === 'PRE') return closeSlash()
    const m = textBeforeCaret(blk).match(/^\/([\w-]*)$/)
    if (!m) return closeSlash()
    slashBlk.current = blk
    const q = m[1] ?? ''
    const rows = slashRows(q)
    const pos = placeMenu(host, r.getBoundingClientRect(), 228, rows.length, 32, 38)
    setSlashMenu((prev) => ({
      open: true,
      q,
      idx: prev.open && prev.q === q ? Math.min(prev.idx, Math.max(0, rows.length - 1)) : 0,
      ...pos,
    }))
  }, [closeSlash])

  const runSlash = useCallback(
    (type: BlockType) => {
      const blk = slashBlk.current
      const q = slashMenu.q
      closeSlash()
      if (!blk) return
      stripLeading(blk, 1 + q.length)
      transformBlock(blk, type)
      persist()
      edRef.current?.focus()
    },
    [slashMenu.q, closeSlash, persist],
  )

  // --- selection toolbar ---
  const checkSelection = useCallback(() => {
    const ed = edRef.current
    const host = hostRef.current
    const s = window.getSelection()
    if (!ed || !host || !s?.rangeCount || s.isCollapsed)
      return setSelBar((b) => (b.open ? { ...b, open: false } : b))
    const r = s.getRangeAt(0)
    if (!ed.contains(r.commonAncestorContainer))
      return setSelBar((b) => (b.open ? { ...b, open: false } : b))
    const rect = r.getBoundingClientRect()
    if (!rect.width && !rect.height) return
    const hr = host.getBoundingClientRect()
    const sc = hr.width / (host.offsetWidth || 1) || 1
    let left = (rect.left + rect.width / 2 - hr.left) / sc
    let top = (rect.top - hr.top) / sc - 44
    if (top < 8) top = (rect.bottom - hr.top) / sc + 8
    left = Math.max(150, Math.min(left, host.offsetWidth - 150))
    setSelBar({
      open: true,
      left,
      top,
      fmt: inspectFormats(ed),
      blockType: currentBlockType(ed),
      blockOpen: false,
    })
  }, [])

  const wrapSelection = useCallback(
    (style: string) => {
      const ed = edRef.current
      const s = window.getSelection()
      if (!ed || !s?.rangeCount || s.isCollapsed) return
      const r = s.getRangeAt(0)
      const el = document.createElement('span')
      el.setAttribute('style', style)
      try {
        r.surroundContents(el)
      } catch {
        el.appendChild(r.extractContents())
        r.insertNode(el)
      }
      s.removeAllRanges()
      setSelBar((b) => ({ ...b, open: false }))
      persist()
      ed.focus()
    },
    [persist],
  )

  const toggleWrap = useCallback(
    (test: (st: string) => boolean, style: string) => {
      const ed = edRef.current
      const s = window.getSelection()
      if (!ed || !s?.rangeCount || s.isCollapsed) return
      let node: Node | null = s.getRangeAt(0).commonAncestorContainer
      if (node && node.nodeType === 3) node = node.parentNode
      let target: HTMLElement | null = null
      let n = node
      while (n && n !== ed) {
        if (n.nodeType === 1) {
          const el = n as HTMLElement
          if (
            el.tagName === 'SPAN' &&
            !el.hasAttribute('data-link') &&
            test(el.getAttribute('style') || '')
          )
            target = el
        }
        n = n.parentNode
      }
      if (target) {
        const parent = target.parentNode
        const r = document.createRange()
        r.selectNodeContents(target)
        const frag = r.extractContents()
        const first = frag.firstChild
        const last = frag.lastChild
        parent?.replaceChild(frag, target)
        if (first && last) {
          const nr = document.createRange()
          nr.setStartBefore(first)
          nr.setEndAfter(last)
          s.removeAllRanges()
          s.addRange(nr)
        }
        setSelBar((b) => ({ ...b, open: false }))
        persist()
        ed.focus()
        return
      }
      wrapSelection(style)
    },
    [persist, wrapSelection],
  )

  const fmtBold = () => {
    document.execCommand('bold')
    setSelBar((b) => ({ ...b, open: false }))
    persist()
  }
  const fmtItalic = () => {
    document.execCommand('italic')
    setSelBar((b) => ({ ...b, open: false }))
    persist()
  }
  const fmtCode = () => toggleWrap((st) => /code-bg/.test(st), S.ic)
  const fmtHighlight = () =>
    toggleWrap(
      (st) => /accent-soft/.test(st),
      'background:var(--accent-soft);border-radius:3px;padding:0 3px;',
    )

  const fmtLink = useCallback(async () => {
    const ed = edRef.current
    const s = window.getSelection()
    if (!ed || !s?.rangeCount || s.isCollapsed) return
    const text = s.toString().trim()
    if (!text) return
    const existing = pagesRef.current.find(
      (p) => (p.title ?? '').toLowerCase() === text.toLowerCase(),
    )
    const target = existing ?? (await onCreatePage(text))
    const r = s.getRangeAt(0)
    r.deleteContents()
    const tpl = document.createElement('template')
    tpl.innerHTML = wlSpan(target?.id ?? '', text)
    if (tpl.content.firstChild) r.insertNode(tpl.content.firstChild)
    s.removeAllRanges()
    setSelBar((b) => ({ ...b, open: false }))
    persist()
    ed.focus()
  }, [onCreatePage, persist])

  const setBlock = useCallback(
    (type: BlockType) => {
      const ed = edRef.current
      const blk = ed ? currentBlock(ed) : null
      setSelBar((b) => ({ ...b, blockOpen: false }))
      if (!blk) return
      transformBlock(blk, type)
      persist()
      ed?.focus()
      checkSelection()
    },
    [persist, checkSelection],
  )

  // --- hover preview ---
  const pvShow = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pvHide = useRef<ReturnType<typeof setTimeout> | null>(null)
  const showPreview = useCallback((id: string, el: HTMLElement) => {
    const host = hostRef.current
    const target = pagesRef.current.find((p) => p.id === id)
    if (!host || !target) return
    if (pvHide.current) clearTimeout(pvHide.current)
    const r = el.getBoundingClientRect()
    const hr = host.getBoundingClientRect()
    const sc = hr.width / (host.offsetWidth || 1) || 1
    let left = (r.left - hr.left) / sc
    let top = (r.bottom - hr.top) / sc + 8
    left = Math.max(10, Math.min(left, host.offsetWidth - 322))
    if (top > host.offsetHeight - 150) top = (r.top - hr.top) / sc - 140
    if (pvShow.current) clearTimeout(pvShow.current)
    pvShow.current = setTimeout(() => setPreview({ open: true, left, top, page: target }), 130)
  }, [])
  const hidePreview = useCallback(() => {
    if (pvShow.current) clearTimeout(pvShow.current)
    pvHide.current = setTimeout(() => setPreview((p) => ({ ...p, open: false })), 120)
  }, [])

  // --- editor event handlers ---
  const onClick = useCallback(
    (e: React.MouseEvent) => {
      const t = e.target as HTMLElement
      const box = t.closest?.('.task-box') as HTMLElement | null
      if (box) {
        e.preventDefault()
        const on = box.getAttribute('data-checked') === '1'
        box.setAttribute('data-checked', on ? '0' : '1')
        box.style.background = on ? 'transparent' : 'var(--accent)'
        box.style.borderColor = on ? 'var(--muted)' : 'var(--accent)'
        box.innerHTML = on ? '' : '<span style="color:#fff;font-size:11px;line-height:1;">✓</span>'
        persist()
        return
      }
      const a = t.closest?.('[data-link]') as HTMLElement | null
      if (a) {
        e.preventDefault()
        const id = a.getAttribute('data-link')
        if (id) onOpenPage(id)
      }
    },
    [persist, onOpenPage],
  )

  const onInput = useCallback(() => {
    persist()
    maybeLink()
    maybeSlash()
  }, [persist, maybeLink, maybeSlash])

  const onKeyUp = useCallback(
    (e: React.KeyboardEvent) => {
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
        maybeLink()
        maybeSlash()
      }
      checkSelection()
    },
    [maybeLink, maybeSlash, checkSelection],
  )

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (slashMenu.open) {
        const rows = slashRows(slashMenu.q)
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setSlashMenu((m) => ({ ...m, idx: Math.min(rows.length - 1, m.idx + 1) }))
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setSlashMenu((m) => ({ ...m, idx: Math.max(0, m.idx - 1) }))
          return
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault()
          const r = rows[slashMenu.idx]
          if (r) runSlash(r.type)
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          closeSlash()
          return
        }
      }
      if (linkMenu.open) {
        const rows = linkRows(linkMenu.q)
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setLinkMenu((m) => ({ ...m, idx: Math.min(rows.length - 1, m.idx + 1) }))
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setLinkMenu((m) => ({ ...m, idx: Math.max(0, m.idx - 1) }))
          return
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault()
          const r = rows[linkMenu.idx]
          if (r)
            r.kind === 'new'
              ? void insertNew(r.title)
              : void insertExisting(pagesRef.current.find((p) => p.id === r.id) as Context)
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          closeLinkMenu()
          return
        }
      }
      const ed = edRef.current
      if (!ed) return
      if (e.key === ' ') {
        const blk = currentBlock(ed)
        if (blk && blk.tagName !== 'PRE') {
          const pre = textBeforeCaret(blk)
          const tok: Record<string, BlockType> = {
            '#': 'h1',
            '##': 'h2',
            '###': 'h3',
            '>': 'quote',
            '-': 'ul',
            '*': 'ul',
            '[]': 'task',
            '[ ]': 'task',
          }
          const t = tok[pre]
          if (t) {
            e.preventDefault()
            stripLeading(blk, pre.length)
            transformBlock(blk, t)
            persist()
            return
          }
        }
      }
      if (e.key === 'Enter') {
        const blk = currentBlock(ed)
        if (blk && blk.tagName !== 'PRE') {
          const pre = textBeforeCaret(blk)
          if (pre === '---' || pre === '***') {
            e.preventDefault()
            stripLeading(blk, pre.length)
            transformBlock(blk, 'hr')
            persist()
          }
        }
      }
    },
    [
      slashMenu,
      linkMenu,
      linkRows,
      runSlash,
      closeSlash,
      insertNew,
      insertExisting,
      closeLinkMenu,
      persist,
    ],
  )

  const onOver = useCallback(
    (e: React.MouseEvent) => {
      const a = (e.target as HTMLElement).closest?.('[data-link]') as HTMLElement | null
      if (a) {
        const id = a.getAttribute('data-link')
        if (id) showPreview(id, a)
      }
    },
    [showPreview],
  )
  const onOut = useCallback(
    (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest?.('[data-link]')) hidePreview()
    },
    [hidePreview],
  )

  const copyMd = useCallback(() => {
    const text = md || (edRef.current ? htmlToMarkdown(edRef.current.innerHTML) : '')
    navigator.clipboard?.writeText(text).then(() => {
      setMdCopied(true)
      setTimeout(() => setMdCopied(false), 1400)
    })
  }, [md])

  const linkRowsRender = linkMenu.open ? linkRows(linkMenu.q) : []
  const slashRowsRender = slashMenu.open ? slashRows(slashMenu.q) : []

  return (
    <div
      ref={hostRef}
      style={sx('flex:1;min-width:0;min-height:0;display:flex;position:relative;')}
    >
      <div className="scroll" style={sx('flex:1;min-width:0;overflow-y:auto;')}>
        <div style={sx('max-width:720px;margin:0 auto;padding:34px 56px 120px;')}>
          <div
            data-editor=""
            contentEditable={!readOnly}
            suppressContentEditableWarning
            spellCheck={false}
            ref={edRef}
            onInput={onInput}
            onKeyUp={onKeyUp}
            onKeyDown={onKeyDown}
            onClick={onClick}
            onBlur={() => void autosave.flush()}
            onMouseUp={() => setTimeout(checkSelection, 0)}
            onMouseOver={onOver}
            onMouseOut={onOut}
            style={sx('min-height:340px;outline:none;')}
          />
          <div
            style={sx(
              "margin-top:30px;font:400 11px 'IBM Plex Mono';color:var(--muted);display:flex;gap:14px;",
            )}
          >
            <span>{words} words</span>
            <span>{Math.max(1, Math.round(words / 220))} min</span>
            <span style={sx('flex:1;')} />
            <SaveBadge status={autosave.status} />
          </div>
        </div>
      </div>

      {dual && (
        <div
          className="scroll"
          style={sx(
            'flex:1;min-width:0;overflow-y:auto;border-left:1px solid var(--border);background:var(--code-bg);',
          )}
        >
          <div style={sx('max-width:720px;margin:0 auto;padding:34px 40px 120px;')}>
            <div
              style={sx(
                'display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:18px;',
              )}
            >
              <span
                style={sx(
                  "font:500 10px 'IBM Plex Mono';letter-spacing:.09em;text-transform:uppercase;color:var(--muted);",
                )}
              >
                Markdown source
              </span>
              <button
                type="button"
                onClick={copyMd}
                style={sx(
                  "font:500 11px 'IBM Plex Mono';color:var(--ink-soft);background:var(--surface);border:1px solid var(--border);border-radius:7px;padding:3px 10px;cursor:pointer;",
                )}
              >
                {mdCopied ? 'Copied ✓' : 'Copy markdown'}
              </button>
            </div>
            <pre
              style={sx(
                "font:400 13.5px/1.72 'IBM Plex Mono',monospace;color:var(--ink-soft);white-space:pre-wrap;word-break:break-word;margin:0;",
              )}
            >
              {md}
            </pre>
          </div>
        </div>
      )}

      {linkMenu.open && (
        <div
          className="scroll"
          style={sx(
            `position:absolute;z-index:55;left:${linkMenu.left}px;top:${linkMenu.top}px;width:288px;max-height:${linkMenu.maxH || 1000}px;overflow-y:auto;background:var(--panel);border:1px solid var(--border);border-radius:11px;box-shadow:0 18px 44px -16px rgba(20,15,5,.5);padding:4px 0 6px;animation:mw-pop .12s ease;`,
          )}
        >
          <div
            style={sx(
              "font:500 10px 'IBM Plex Mono';letter-spacing:.08em;text-transform:uppercase;color:var(--muted);padding:8px 12px 6px;",
            )}
          >
            Link to page
          </div>
          {linkRowsRender.map((r, i) => (
            <div
              key={r.kind === 'new' ? `new-${r.title}` : r.id}
              onMouseDown={(e) => {
                e.preventDefault()
                r.kind === 'new'
                  ? void insertNew(r.title)
                  : void insertExisting(pagesRef.current.find((p) => p.id === r.id) as Context)
              }}
              onMouseEnter={() => setLinkMenu((m) => ({ ...m, idx: i }))}
              style={sx(
                `display:flex;align-items:center;gap:10px;padding:7px 11px;margin:1px 5px;border-radius:8px;cursor:pointer;${i === linkMenu.idx ? 'background:var(--accent-soft);' : ''}`,
              )}
            >
              <span
                style={sx(
                  `width:18px;text-align:center;font:400 13px 'IBM Plex Mono';color:${r.kind === 'new' ? 'var(--accent-ink)' : 'var(--muted)'};`,
                )}
              >
                {r.kind === 'new' ? '+' : '◆'}
              </span>
              <span
                style={sx(
                  "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:500 13px 'IBM Plex Sans';color:var(--ink);",
                )}
              >
                {r.kind === 'new' ? `Create “${r.title}”` : r.title}
              </span>
              <span style={sx("font:400 11px 'IBM Plex Mono';color:var(--muted);")}>{r.sub}</span>
            </div>
          ))}
        </div>
      )}

      {slashMenu.open && (
        <div
          className="scroll"
          style={sx(
            `position:absolute;z-index:55;left:${slashMenu.left}px;top:${slashMenu.top}px;width:228px;max-height:${slashMenu.maxH || 1000}px;overflow-y:auto;background:var(--panel);border:1px solid var(--border);border-radius:11px;box-shadow:0 18px 44px -16px rgba(20,15,5,.5);padding:4px 0 6px;animation:mw-pop .12s ease;`,
          )}
        >
          <div
            style={sx(
              "font:500 10px 'IBM Plex Mono';letter-spacing:.08em;text-transform:uppercase;color:var(--muted);padding:8px 12px 6px;",
            )}
          >
            Insert block
          </div>
          {slashRowsRender.map((r, i) => (
            <div
              key={r.type}
              onMouseDown={(e) => {
                e.preventDefault()
                runSlash(r.type)
              }}
              onMouseEnter={() => setSlashMenu((m) => ({ ...m, idx: i }))}
              style={sx(
                `display:flex;align-items:center;gap:11px;padding:7px 11px;margin:1px 5px;border-radius:8px;cursor:pointer;${i === slashMenu.idx ? 'background:var(--accent-soft);' : ''}`,
              )}
            >
              <span
                style={sx(
                  "width:30px;flex:0 0 30px;text-align:center;font:500 12px 'IBM Plex Mono';color:var(--muted);",
                )}
              >
                {r.hint}
              </span>
              <span style={sx("flex:1;font:500 13px 'IBM Plex Sans';color:var(--ink);")}>
                {r.label}
              </span>
            </div>
          ))}
        </div>
      )}

      {selBar.open && (
        <div
          style={sx(
            `position:absolute;z-index:56;left:${selBar.left}px;top:${selBar.top}px;transform:translateX(-50%);display:flex;align-items:center;gap:1px;background:#211d18;border-radius:9px;padding:4px;box-shadow:0 12px 28px -12px rgba(20,15,5,.7);animation:mw-pop .1s ease;`,
          )}
        >
          <span
            onMouseDown={(e) => {
              e.preventDefault()
              setSelBar((b) => ({ ...b, blockOpen: !b.blockOpen }))
            }}
            style={sx(
              `font:500 11.5px 'IBM Plex Sans';color:#f4efe6;padding:3px 9px;border-radius:6px;cursor:pointer;white-space:nowrap;${selBar.blockOpen ? 'background:rgba(255,255,255,.13);' : ''}`,
            )}
          >
            {blockLabel(selBar.blockType)} <span style={sx('font-size:8px;opacity:.65;')}>▾</span>
          </span>
          <span
            style={sx('width:1px;height:18px;background:rgba(255,255,255,.15);margin:0 4px;')}
          />
          <BarBtn
            label="B"
            active={selBar.fmt.bold}
            on={fmtBold}
            style="font:700 14px 'Spectral';"
          />
          <BarBtn
            label="i"
            active={selBar.fmt.italic}
            on={fmtItalic}
            style="font:italic 600 14px 'Spectral';"
          />
          <BarBtn
            label="</>"
            active={selBar.fmt.code}
            on={fmtCode}
            style="font:500 11px 'IBM Plex Mono';"
          />
          <BarBtn
            label="[[ ]]"
            active={selBar.fmt.link}
            on={() => void fmtLink()}
            style="font:500 12px 'IBM Plex Mono';color:#a8b0ff;"
          />
          <span
            onMouseDown={(e) => {
              e.preventDefault()
              fmtHighlight()
            }}
            title="Highlight"
            style={sx(
              `width:16px;height:16px;border-radius:4px;background:#fbe27a;margin:0 6px;cursor:pointer;display:inline-block;${selBar.fmt.highlight ? 'box-shadow:0 0 0 2px #f4efe6;' : ''}`,
            )}
          />
          {selBar.blockOpen && (
            <div
              className="scroll"
              style={sx(
                'position:absolute;top:calc(100% + 7px);left:0;min-width:176px;max-height:280px;overflow-y:auto;background:#211d18;border-radius:9px;padding:5px;box-shadow:0 16px 32px -12px rgba(20,15,5,.72);display:flex;flex-direction:column;gap:1px;z-index:57;',
              )}
            >
              {BLOCK_OPTIONS.map((o) => (
                <div
                  key={o.type}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    setBlock(o.type)
                  }}
                  style={sx(
                    `display:flex;align-items:center;gap:9px;padding:6px 9px;border-radius:6px;cursor:pointer;font:500 13px 'Spectral';color:#f4efe6;white-space:nowrap;${o.type === selBar.blockType ? 'background:rgba(168,176,255,.30);' : ''}`,
                  )}
                >
                  <span
                    style={sx(
                      "width:22px;text-align:center;font:500 10.5px 'IBM Plex Mono';color:#b9b3a5;",
                    )}
                  >
                    {o.hint}
                  </span>
                  {o.label}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {preview.open && preview.page && (
        <div
          style={sx(
            `position:absolute;z-index:52;left:${preview.left}px;top:${preview.top}px;width:300px;background:var(--panel);border:1px solid var(--border);border-radius:11px;box-shadow:0 18px 40px -16px rgba(20,15,5,.5);padding:13px 15px;animation:mw-fade .12s ease;pointer-events:none;`,
          )}
        >
          <div style={sx("font:600 14px 'Spectral',serif;color:var(--ink);")}>
            {preview.page.title}
          </div>
          <div
            style={sx("font:400 13px/1.55 'Spectral',serif;color:var(--ink-soft);margin-top:5px;")}
          >
            {excerpt(preview.page.body)}
          </div>
          <div
            style={sx(
              "display:flex;gap:9px;margin-top:9px;font:400 10.5px 'IBM Plex Mono';color:var(--muted);",
            )}
          >
            <span>{preview.page.pageType}</span>
          </div>
        </div>
      )}
    </div>
  )
}

function BarBtn({
  label,
  active,
  on,
  style,
}: {
  label: string
  active: boolean
  on: () => void
  style: string
}) {
  return (
    <span
      onMouseDown={(e) => {
        e.preventDefault()
        on()
      }}
      style={sx(
        `color:#f4efe6;padding:3px 10px;border-radius:6px;cursor:pointer;${style}${active ? 'background:rgba(168,176,255,.34);color:#fff;' : ''}`,
      )}
    >
      {label}
    </span>
  )
}

function SaveBadge({ status }: { status: SaveStatus }) {
  const label = status === 'saving' ? 'Saving…' : status === 'dirty' ? 'Unsaved' : 'Saved'
  const dot = status === 'saved' ? '#4caf7d' : status === 'saving' ? '#caa34a' : '#9a917f'
  return (
    <span style={sx('display:flex;align-items:center;gap:6px;')}>
      <span style={sx(`width:6px;height:6px;border-radius:50%;background:${dot};`)} />
      {label}
    </span>
  )
}

function slashRows(q: string) {
  const ql = q.toLowerCase()
  return SLASH_ITEMS.filter((x) => !ql || x.label.toLowerCase().includes(ql) || x.type.includes(ql))
}

function emptyFmt(): Fmt {
  return { bold: false, italic: false, code: false, highlight: false, link: false }
}

function inspectFormats(ed: HTMLElement): Fmt {
  const f = emptyFmt()
  try {
    f.bold = !!document.queryCommandState('bold')
    f.italic = !!document.queryCommandState('italic')
  } catch {
    /* queryCommandState unsupported */
  }
  const s = window.getSelection()
  if (s?.rangeCount) {
    let node: Node | null = s.getRangeAt(0).commonAncestorContainer
    if (node && node.nodeType === 3) node = node.parentNode
    let n = node
    while (n && n !== ed) {
      if (n.nodeType === 1) {
        const el = n as HTMLElement
        const st = el.getAttribute('style') || ''
        if (el.tagName === 'SPAN' && /code-bg/.test(st)) f.code = true
        if (el.tagName === 'SPAN' && /accent-soft/.test(st)) f.highlight = true
        if (el.hasAttribute('data-link')) f.link = true
      }
      n = n.parentNode
    }
  }
  return f
}

function currentBlockType(ed: HTMLElement): string {
  const blk = currentBlock(ed)
  if (!blk) return 'p'
  if (isTask(blk)) return 'task'
  if (isCallout(blk)) return 'callout'
  return blockTypeOf(blk)
}

function excerpt(body: string): string {
  // Parse inertly: `DOMParser` does NOT run scripts or load resources, unlike assigning a
  // stored body to `el.innerHTML` (which fires `<img onerror=...>` — a DOM-XSS sink).
  const parsed = new DOMParser().parseFromString(body, 'text/html').body.textContent ?? body
  const text = parsed.replace(/\s+/g, ' ').trim()
  return text.length > 140 ? `${text.slice(0, 140)}…` : text
}
