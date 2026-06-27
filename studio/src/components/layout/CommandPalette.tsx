import { useEffect, useMemo, useRef, useState } from 'react'
import type { Context } from '../../api/types'
import { sx } from '../../lib/dc'
import { pageTypeGlyph } from '../../lib/theme'
import { Icon } from '../common/Icon'

export interface PaletteCommand {
  label: string
  hint: string
  run: () => void
}

interface Props {
  pages: Context[]
  commands: PaletteCommand[]
  onClose: () => void
  onOpen: (id: string) => void
  onCreate: (title: string) => void
}

type Row =
  | { kind: 'cmd'; label: string; hint: string; icon: string; run: () => void }
  | { kind: 'page'; label: string; hint: string; icon: string; run: () => void }

export function CommandPalette({ pages, commands, onClose, onOpen, onCreate }: Props) {
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const rows = useMemo<Row[]>(() => {
    const ql = q.toLowerCase().trim()
    const cmds: Row[] = commands.map((c) => ({
      kind: 'cmd',
      label: c.label,
      hint: c.hint,
      icon: '⌘',
      run: c.run,
    }))
    const pageRows: Row[] = pages.map((p) => ({
      kind: 'page',
      label: p.title || 'Untitled',
      hint: p.pageType ?? 'page',
      icon: pageTypeGlyph(p.pageType),
      run: () => {
        onClose()
        onOpen(p.id)
      },
    }))
    let all = [...cmds, ...pageRows]
    if (ql) all = all.filter((r) => r.label.toLowerCase().includes(ql))
    return all.slice(0, 8)
  }, [q, pages, commands, onClose, onOpen])

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIdx((i) => Math.min(rows.length - 1, i + 1))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIdx((i) => Math.max(0, i - 1))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const r = rows[idx]
      if (r) r.run()
      else if (q.trim()) {
        onClose()
        onCreate(q.trim())
      }
    }
  }

  return (
    <div
      onClick={onClose}
      style={sx(
        'position:fixed;inset:0;z-index:60;background:rgba(20,15,8,.32);display:flex;align-items:flex-start;justify-content:center;padding-top:96px;animation:mw-fade .14s ease;',
      )}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={sx(
          'width:560px;max-width:88%;background:var(--panel);border:1px solid var(--border);border-radius:13px;box-shadow:0 30px 70px -20px rgba(20,15,5,.5);overflow:hidden;animation:mw-pop .16s ease;',
        )}
      >
        <div
          style={sx(
            'display:flex;align-items:center;gap:11px;padding:14px 16px;border-bottom:1px solid var(--border);color:var(--muted);',
          )}
        >
          <Icon name="search" size={16} />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => {
              setQ(e.target.value)
              setIdx(0)
            }}
            onKeyDown={onKey}
            placeholder="Search pages or run a command…"
            style={sx(
              "flex:1;border:none;background:transparent;outline:none;font:400 16px 'IBM Plex Sans';color:var(--ink);",
            )}
          />
          <span
            style={sx(
              "font:500 11px 'IBM Plex Mono';background:var(--code-bg);border:1px solid var(--border);border-radius:5px;padding:1px 6px;",
            )}
          >
            esc
          </span>
        </div>
        <div className="scroll" style={sx('max-height:344px;overflow-y:auto;padding:7px;')}>
          {rows.map((r, i) => (
            <div
              key={`${r.kind}-${r.label}`}
              onMouseDown={r.run}
              onMouseEnter={() => setIdx(i)}
              style={sx(
                `display:flex;align-items:center;gap:11px;padding:9px 11px;border-radius:9px;cursor:pointer;${i === idx ? 'background:var(--accent-soft);' : ''}`,
              )}
            >
              <span
                style={sx(
                  `width:22px;text-align:center;font:400 14px 'IBM Plex Mono';color:${r.kind === 'cmd' ? 'var(--accent-ink)' : 'var(--muted)'};`,
                )}
              >
                {r.icon}
              </span>
              <span
                style={sx(
                  "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:500 14px 'IBM Plex Sans';color:var(--ink);",
                )}
              >
                {r.label}
              </span>
              <span style={sx("font:400 11px 'IBM Plex Mono';color:var(--muted);")}>{r.hint}</span>
            </div>
          ))}
          {rows.length === 0 && q.trim() && (
            <div
              style={sx(
                "padding:22px;text-align:center;font:400 14px 'Spectral',serif;font-style:italic;color:var(--muted);",
              )}
            >
              No matches. Press Enter to create this page.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
