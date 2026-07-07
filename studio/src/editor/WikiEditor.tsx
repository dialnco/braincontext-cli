import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { type FileMeta, fileContentUrl, filesApi } from '../api/files'
import type { Context } from '../api/types'
import { wikiApi } from '../api/wiki'
import { ConfirmDialog } from '../components/common/ConfirmDialog'
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
import { fileEmbedHtml, fileImgHtml, htmlToMarkdown, markdownToHtml } from '../lib/markdown'
import { S } from '../lib/theme'
import { estimateTokens, formatTokens } from '../lib/tokens'
import { wlSpan } from '../lib/wikilinks'
import { useApp } from '../state/StoreContext'
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
  /** True while an edit is buffered but not yet saved (pauses the live-refresh poller). */
  isDirty: () => boolean
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

/** A small "✕ Remove" button that drops this `![[..]]` embed from the consuming page. */
function embedRemoveBtn(onRemove: () => void): HTMLButtonElement {
  const rm = document.createElement('button')
  rm.type = 'button'
  rm.setAttribute('contenteditable', 'false')
  rm.title = 'Remove this embed from the page (the linked table is kept)'
  rm.setAttribute(
    'style',
    "cursor:pointer;font:600 11px 'IBM Plex Mono',monospace;color:#b4533f;background:transparent;border:1px solid var(--border);border-radius:7px;padding:3px 9px;",
  )
  rm.textContent = '✕ Remove'
  rm.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    onRemove()
  })
  return rm
}

/** Fill an embed placeholder with a header (title + Open-to-edit) and, if given, a rendered table. */
function renderEmbedOpen(
  node: HTMLElement,
  target: Context,
  resolveTitle: (title: string) => string,
  onOpen: (id: string) => void,
  altLabel?: string,
  body?: string,
  onRemove?: () => void,
): void {
  node.innerHTML = ''
  const head = document.createElement('div')
  head.setAttribute(
    'style',
    'display:flex;align-items:center;gap:8px;padding:9px 14px;background:var(--code-bg);border-bottom:1px solid var(--border);',
  )
  const label = document.createElement('span')
  label.setAttribute('style', "font:600 12px/1 'IBM Plex Mono',monospace;color:var(--muted);")
  label.textContent = `▦ ${target.title ?? ''}`
  const spacer = document.createElement('span')
  spacer.setAttribute('style', 'flex:1;')
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.setAttribute('contenteditable', 'false')
  btn.setAttribute(
    'style',
    "cursor:pointer;font:600 11px 'IBM Plex Mono',monospace;color:var(--accent-ink);background:transparent;border:1px solid var(--border);border-radius:7px;padding:3px 10px;",
  )
  btn.textContent = altLabel ?? 'Open to edit ↗'
  btn.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    onOpen(target.id)
  })
  head.append(label, spacer)
  if (onRemove) head.append(embedRemoveBtn(onRemove))
  head.append(btn)
  node.appendChild(head)
  if (body !== undefined) {
    const wrap = document.createElement('div')
    wrap.innerHTML = markdownToHtml(body, resolveTitle)
    node.appendChild(wrap)
  }
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Fill a `![[file:<id>|name]]` placeholder with an attachment card: filename + size,
 * a Download link, and — for PDFs — an inline viewer. The iframe/link URLs hit the
 * same-origin /api/files content endpoint, which 302s to a presigned bucket URL.
 */
function renderFileEmbed(node: HTMLElement, meta: FileMeta, onRemove?: () => void): void {
  node.innerHTML = ''
  const head = document.createElement('div')
  head.setAttribute(
    'style',
    'display:flex;align-items:center;gap:8px;padding:9px 14px;background:var(--code-bg);',
  )
  const label = document.createElement('span')
  label.setAttribute(
    'style',
    "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:600 12px/1 'IBM Plex Mono',monospace;color:var(--muted);",
  )
  label.textContent = `📎 ${meta.filename} · ${humanSize(meta.size)}`
  label.title = meta.mime
  const dl = document.createElement('a')
  dl.href = fileContentUrl(meta.id, true)
  dl.setAttribute('contenteditable', 'false')
  dl.setAttribute(
    'style',
    "cursor:pointer;font:600 11px 'IBM Plex Mono',monospace;color:var(--accent-ink);background:transparent;border:1px solid var(--border);border-radius:7px;padding:3px 10px;text-decoration:none;",
  )
  dl.textContent = 'Download ↓'
  head.append(label, dl)
  if (onRemove) head.append(embedRemoveBtn(onRemove))
  node.appendChild(head)
  if (meta.mime === 'application/pdf') {
    const frame = document.createElement('iframe')
    frame.src = fileContentUrl(meta.id)
    frame.title = meta.filename
    frame.setAttribute(
      'style',
      'width:100%;height:480px;border:0;display:block;border-top:1px solid var(--border);background:#fff;',
    )
    node.appendChild(frame)
  }
}

/** Fill an embed placeholder with a plain note (unresolved / wanted embed) + a remove affordance. */
function renderEmbedNote(node: HTMLElement, msg: string, onRemove?: () => void): void {
  node.innerHTML = ''
  const d = document.createElement('div')
  d.setAttribute(
    'style',
    "display:flex;align-items:center;gap:8px;padding:11px 14px;font:400 13px/1.5 'IBM Plex Mono',monospace;color:var(--muted);",
  )
  const span = document.createElement('span')
  span.setAttribute('style', 'flex:1;')
  span.textContent = msg
  d.append(span)
  if (onRemove) d.append(embedRemoveBtn(onRemove))
  node.appendChild(d)
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
  const paneRef = useRef<HTMLDivElement>(null)
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
  const [tokens, setTokens] = useState(0)
  const [mdCopied, setMdCopied] = useState(false)
  // A `![[..]]` embed the user asked to remove, pending confirm (the linked table is kept).
  const [pendingEmbedRemove, setPendingEmbedRemove] = useState<{
    node: HTMLElement
    title: string
    /** 'file' = attachment embed (the uploaded blob is kept); default = datatable embed. */
    kind?: 'file'
  } | null>(null)

  const app = useApp()
  // File storage gating: uploads/attach affordances only when the store has S3/R2
  // config. Refetched per project (the editor remounts on view/project changes).
  const [storageOn, setStorageOn] = useState(false)
  const projectKey = app.project?.project ?? ''
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch when the project changes
  useEffect(() => {
    let alive = true
    filesApi
      .status()
      .then((s) => alive && setStorageOn(s.configured))
      .catch(() => alive && setStorageOn(false))
    return () => {
      alive = false
    }
  }, [projectKey])

  const pagesRef = useRef(pages)
  pagesRef.current = pages

  const resolveTitle = useCallback((title: string): string => {
    const hit = pagesRef.current.find((p) => (p.title ?? '').toLowerCase() === title.toLowerCase())
    return hit?.id ?? ''
  }, [])

  // Size each table's scroll box to break out of the 720px prose column and span
  // the full pane width (left-aligned to the content). CSS can't do this: the pane
  // width varies with the sidebar / right panel / dual pane, so we measure the live
  // layout. The table keeps width:max-content, so this max-width is what clamps it
  // and turns on its internal horizontal scroll. Re-run on every layout change (see
  // the ResizeObserver below) and after edits that may add/resize a table.
  const sizeTables = useCallback(() => {
    const ed = edRef.current
    const pane = paneRef.current
    if (!ed || !pane) return
    const paneRect = pane.getBoundingClientRect()
    const availRight = paneRect.left + pane.clientWidth // clientWidth excludes the scrollbar
    for (const el of ed.querySelectorAll('table')) {
      const table = el as HTMLElement
      const left = table.getBoundingClientRect().left // block flow left, independent of width
      table.style.maxWidth = `${Math.round(Math.max(120, availRight - left - 24))}px`
    }
  }, [])

  // Re-fit tables whenever the pane resizes: window resize, or any panel toggling
  // (sidebar / right panel / dual pane) that changes the available width.
  useEffect(() => {
    const pane = paneRef.current
    if (!pane) return
    const ro = new ResizeObserver(() => sizeTables())
    ro.observe(pane)
    return () => ro.disconnect()
  }, [sizeTables])

  // Fill each `![[Title]]` embed placeholder with the referenced datatable's rendered table
  // (read-only) + an "Open to edit" header that jumps to its grid editor. The stored body keeps
  // the `![[Title]]` marker (the wrapper is contenteditable=false and htmlToMarkdown re-emits it),
  // so hydrating here never rewrites the consuming page. Fetches fresh so edits elsewhere show.
  const hydrateEmbeds = useCallback(() => {
    const ed = edRef.current
    if (!ed) return
    const cache = new Map<string, Promise<Context | null>>()
    for (const node of ed.querySelectorAll<HTMLElement>('[data-embed-title]')) {
      if (node.dataset.embedHydrated === '1') continue
      const title = node.getAttribute('data-embed-title') ?? ''
      // On editable pages, every embed carries a "✕ Remove" that drops its `![[..]]` marker.
      const onRemove = readOnly ? undefined : () => setPendingEmbedRemove({ node, title })
      const target = pagesRef.current.find(
        (p) => (p.title ?? '').toLowerCase() === title.trim().toLowerCase(),
      )
      if (!target) {
        // The page list may not have loaded yet (initial mount / hard reload). Don't lock in the
        // "no such page" note in that case — leave the node UNHYDRATED so the pages-change effect
        // below re-resolves it once the list arrives. Only mark hydrated when pages are actually
        // loaded and the title genuinely has no match.
        renderEmbedNote(node, `⚠ no page titled “${title}”`, onRemove)
        if (pagesRef.current.length > 0) node.dataset.embedHydrated = '1'
        continue
      }
      node.dataset.embedHydrated = '1'
      if (target.pageType !== 'datatable') {
        renderEmbedOpen(
          node,
          target,
          resolveTitle,
          onOpenPage,
          '(not a datatable — open)',
          undefined,
          onRemove,
        )
        continue
      }
      let pending = cache.get(target.id)
      if (!pending) {
        pending = wikiApi.get(target.id).catch(() => null)
        cache.set(target.id, pending)
      }
      void pending.then((full) => {
        if (!node.isConnected) return
        renderEmbedOpen(
          node,
          target,
          resolveTitle,
          onOpenPage,
          undefined,
          full?.body ?? target.body,
          onRemove,
        )
        sizeTables()
      })
    }
  }, [resolveTitle, onOpenPage, sizeTables, readOnly])

  // Fill each `![[file:<id>|name]]` placeholder with its attachment card (download link,
  // inline PDF viewer). Same never-serialize rule as datatable embeds: the wrapper is
  // contenteditable=false and htmlToMarkdown re-emits the marker from its data attributes.
  const hydrateFileEmbeds = useCallback(() => {
    const ed = edRef.current
    if (!ed) return
    const cache = new Map<string, Promise<FileMeta | null>>()
    for (const node of ed.querySelectorAll<HTMLElement>('[data-file-embed]')) {
      if (node.dataset.embedHydrated === '1') continue
      node.dataset.embedHydrated = '1'
      const id = node.getAttribute('data-file-embed') ?? ''
      const name = node.getAttribute('data-file-name') || 'attachment'
      const onRemove = readOnly
        ? undefined
        : () => setPendingEmbedRemove({ node, title: name, kind: 'file' })
      let pending = cache.get(id)
      if (!pending) {
        pending = filesApi.meta(id).catch(() => null)
        cache.set(id, pending)
      }
      void pending.then((meta) => {
        if (!node.isConnected) return
        if (!meta) {
          renderEmbedNote(node, `⚠ attachment missing (${name})`, onRemove)
          return
        }
        renderFileEmbed(node, meta, onRemove)
      })
    }
  }, [readOnly])

  // Re-resolve embeds when the page list arrives or changes. On a hard reload the load effect
  // hydrates before `pages` has loaded, so `![[Title]]` embeds can't find their target and fall
  // back to the "no such page" note; re-running hydration once the list is available resolves
  // them (already-resolved nodes are skipped). Navigating away and back masked this by rebuilding
  // the editor HTML after pages had loaded — this makes a plain reload behave the same.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run on the pages-list identity
  useEffect(() => {
    hydrateEmbeds()
    hydrateFileEmbeds()
  }, [pages, hydrateEmbeds, hydrateFileEmbeds])

  const autosave = useAutosave(onSave)
  useEffect(() => {
    if (handleRef) handleRef.current = { flush: autosave.flush, isDirty: autosave.isDirty }
  }, [handleRef, autosave.flush, autosave.isDirty])
  useEffect(() => {
    onSaved?.(autosave.status)
  }, [autosave.status, onSaved])

  // The markdown this editor last loaded or scheduled for save. External writes are
  // detected by exact string comparison against this — NOT against a re-derived
  // htmlToMarkdown(innerHTML) round-trip, which may normalize and false-positive.
  const lastSyncedMd = useRef('')

  // Load the page body into the editor when the active page changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-render on page identity + body
  useEffect(() => {
    const ed = edRef.current
    if (!ed) return
    ed.innerHTML = markdownToHtml(page.body, resolveTitle)
    ed.scrollTop = 0
    lastSyncedMd.current = page.body
    setWords((ed.textContent?.trim().match(/\S+/g) || []).length)
    setTokens(estimateTokens(page.body))
    sizeTables()
    hydrateEmbeds()
    hydrateFileEmbeds()
  }, [page.id])

  // Reflect EXTERNAL edits to the open page (an agent/CLI wrote it; the live-refresh
  // poller refetched). Only when the local buffer is clean — a dirty buffer wins and
  // will be saved (last-writer semantics, same as concurrent CLI edits).
  // biome-ignore lint/correctness/useExhaustiveDependencies: compare vs lastSyncedMd only
  useEffect(() => {
    const ed = edRef.current
    if (!ed || page.body === lastSyncedMd.current || autosave.isDirty()) return
    ed.innerHTML = markdownToHtml(page.body, resolveTitle)
    lastSyncedMd.current = page.body
    setWords((ed.textContent?.trim().match(/\S+/g) || []).length)
    setTokens(estimateTokens(page.body))
    if (dual) setMd(page.body)
    sizeTables()
    hydrateEmbeds()
    hydrateFileEmbeds()
  }, [page.body])

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
    const nextMd = htmlToMarkdown(ed.innerHTML)
    lastSyncedMd.current = nextMd // our own save echoing back must not read as external
    setTokens(estimateTokens(nextMd))
    autosave.schedule(nextMd)
    if (dual) setMd(nextMd)
  }, [autosave, dual])

  // --- file uploads (paste / drop / attach button) ---

  /** Insert block-level HTML after the caret's top-level block (or append at the end). */
  const insertBlockAtCaret = useCallback(
    (html: string) => {
      const ed = edRef.current
      if (!ed) return
      const tpl = document.createElement('template')
      tpl.innerHTML = html
      const nodes = [...tpl.content.childNodes]
      const s = window.getSelection()
      let anchorBlock: HTMLElement | null = null
      if (s?.rangeCount) {
        let n: Node | null = s.getRangeAt(0).commonAncestorContainer
        while (n && n !== ed && n.parentNode !== ed) n = n.parentNode
        if (n && n !== ed && n.parentNode === ed) anchorBlock = n as HTMLElement
      }
      if (anchorBlock) anchorBlock.after(...nodes)
      else ed.append(...nodes)
      persist()
    },
    [persist],
  )

  const uploadFiles = useCallback(
    async (list: File[]) => {
      if (readOnly || list.length === 0) return
      if (!storageOn) {
        app.toast('File storage isn’t configured — set it up in Settings (⚙)')
        return
      }
      for (const f of list) {
        try {
          app.toast(`Uploading ${f.name}…`)
          const meta = await filesApi.upload(f)
          if (meta.mime.startsWith('image/') && meta.mime !== 'image/svg+xml') {
            insertBlockAtCaret(fileImgHtml(meta.id, meta.filename))
          } else {
            insertBlockAtCaret(fileEmbedHtml(meta.id, meta.filename))
            hydrateFileEmbeds()
          }
          app.toast(`Uploaded ${f.name}`)
        } catch (e) {
          app.toast(e instanceof Error ? `Upload failed: ${e.message}` : `Upload failed: ${f.name}`)
        }
      }
      void autosave.flush()
    },
    [readOnly, storageOn, app.toast, insertBlockAtCaret, hydrateFileEmbeds, autosave.flush],
  )

  const onPaste = useCallback(
    (e: React.ClipboardEvent) => {
      const files = [...(e.clipboardData?.files ?? [])]
      if (files.length === 0) return
      // Always intercept file pastes: without storage the default contenteditable
      // behavior inserts a data: image that the serializer drops silently.
      e.preventDefault()
      void uploadFiles(files)
    },
    [uploadFiles],
  )

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      const files = [...(e.dataTransfer?.files ?? [])]
      if (files.length === 0) return
      e.preventDefault()
      void uploadFiles(files)
    },
    [uploadFiles],
  )

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer?.types.includes('Files')) e.preventDefault()
  }, [])

  const fileInputRef = useRef<HTMLInputElement>(null)

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
      // Titles are the [[link]] resolution key — when several pages share one, show
      // each candidate's slug so the user can tell which page they are linking.
      const titleCounts = new Map<string, number>()
      for (const p of pagesRef.current) {
        const t = (p.title ?? '').toLowerCase().trim()
        if (t) titleCounts.set(t, (titleCounts.get(t) ?? 0) + 1)
      }
      const rows: LinkRow[] = list.slice(0, 6).map((p) => {
        const ambiguous = (titleCounts.get((p.title ?? '').toLowerCase().trim()) ?? 0) > 1
        const sub = ambiguous
          ? `${p.pageType ?? 'page'} · ${p.slug ?? p.id} — ambiguous title`
          : (p.pageType ?? 'page')
        return { kind: 'page', id: p.id, title: p.title ?? p.id, sub }
      })
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
    sizeTables()
    maybeLink()
    maybeSlash()
  }, [persist, sizeTables, maybeLink, maybeSlash])

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
      <div
        ref={paneRef}
        className="scroll"
        style={sx('flex:1;min-width:0;overflow-x:hidden;overflow-y:auto;')}
      >
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
            onPaste={onPaste}
            onDrop={onDrop}
            onDragOver={onDragOver}
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
            <span title="Estimated cost for an agent to read this page">
              {formatTokens(tokens)}
            </span>
            <span style={sx('flex:1;')} />
            {!readOnly && storageOn && (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const files = [...(e.target.files ?? [])]
                    e.target.value = ''
                    void uploadFiles(files)
                  }}
                />
                <span
                  onClick={() => fileInputRef.current?.click()}
                  title="Upload a file to the bucket and embed it here (or paste / drop)"
                  style={sx(
                    'cursor:pointer;color:var(--ink-soft);border:1px solid var(--border);border-radius:6px;padding:2px 8px;',
                  )}
                >
                  📎 Attach
                </span>
              </>
            )}
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

      {pendingEmbedRemove && (
        <ConfirmDialog
          heading="Remove embed"
          message={
            pendingEmbedRemove.kind === 'file'
              ? `Remove the “${pendingEmbedRemove.title}” attachment from this page? Only this reference is removed — the uploaded file stays in the bucket.`
              : `Remove the embedded “${pendingEmbedRemove.title}” table from this page? Only this reference is removed — the datatable itself is kept.`
          }
          confirmLabel="Remove embed"
          onConfirm={() => {
            pendingEmbedRemove.node.remove()
            setPendingEmbedRemove(null)
            persist()
            void autosave.flush()
          }}
          onCancel={() => setPendingEmbedRemove(null)}
        />
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
