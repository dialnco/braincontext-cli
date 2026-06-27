import { useState } from 'react'
import type { Context } from '../../api/types'
import { Hov, sx } from '../../lib/dc'
import { pageTypeGlyph, pageTypeLabel } from '../../lib/theme'

/** Sidebar order for the page-type groups (the wiki taxonomy as "folders"). */
const GROUP_ORDER = ['index', 'entity', 'concept', 'summary', 'comparison', 'analysis', 'source']

interface Props {
  pages: Context[]
  activeId: string | null
  edgeCount: number
  onOpen: (id: string) => void
  onNew: () => void
}

export function Sidebar({ pages, activeId, edgeCount, onOpen, onNew }: Props) {
  const groups = new Map<string, Context[]>()
  for (const p of pages) {
    const key = p.pageType || 'other'
    const list = groups.get(key) ?? []
    list.push(p)
    groups.set(key, list)
  }
  const keys = [...groups.keys()].sort((a, b) => {
    const ia = GROUP_ORDER.indexOf(a)
    const ib = GROUP_ORDER.indexOf(b)
    return (ia < 0 ? 9 : ia) - (ib < 0 ? 9 : ib)
  })

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const baseRow =
    'display:flex;align-items:center;gap:6px;padding:4px 9px;margin:1px 4px;border-radius:7px;cursor:pointer;transition:background .12s;'

  return (
    <div
      className="scroll"
      style={sx(
        'width:250px;flex:0 0 250px;background:var(--panel);border-right:1px solid var(--border);overflow-y:auto;padding:12px 6px 18px;display:flex;flex-direction:column;',
      )}
    >
      <div
        style={sx(
          'display:flex;align-items:center;justify-content:space-between;padding:2px 10px 10px;',
        )}
      >
        <span
          style={sx(
            "font:600 11px 'IBM Plex Mono';letter-spacing:.1em;text-transform:uppercase;color:var(--muted);",
          )}
        >
          Pages
        </span>
        <Hov
          as="span"
          base={sx(
            "width:22px;height:22px;border-radius:6px;display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--muted);font:300 18px/1 'IBM Plex Sans';",
          )}
          hover={sx('background:var(--accent-soft);color:var(--accent-ink);')}
          onClick={onNew}
          title="New page"
        >
          +
        </Hov>
      </div>

      {pages.length === 0 && (
        <div
          style={sx(
            "font:400 12.5px/1.5 'Spectral',serif;color:var(--muted);font-style:italic;padding:6px 12px;",
          )}
        >
          No pages yet. Press + to create the first one.
        </div>
      )}

      {keys.map((key) => {
        const list = groups.get(key) ?? []
        const open = !collapsed[key]
        return (
          <div key={key}>
            <Hov
              base={sx(baseRow)}
              hover={sx('background:var(--accent-soft);')}
              onClick={() => setCollapsed((c) => ({ ...c, [key]: !!open }))}
            >
              <span
                style={sx(
                  "width:12px;font:400 10px 'IBM Plex Mono';color:var(--muted);text-align:center;",
                )}
              >
                {open ? '▾' : '▸'}
              </span>
              <span
                style={sx(
                  "flex:1;font:600 13px 'IBM Plex Sans';color:var(--ink);letter-spacing:.01em;",
                )}
              >
                {pageTypeLabel(key === 'other' ? null : key)}
              </span>
              <span style={sx("font:400 11px 'IBM Plex Mono';color:var(--muted);")}>
                {list.length}
              </span>
            </Hov>
            {open &&
              list.map((p) => {
                const active = p.id === activeId
                return (
                  <Hov
                    key={p.id}
                    base={sx(
                      `${baseRow}padding-left:26px;${active ? 'background:var(--accent-soft);' : ''}`,
                    )}
                    hover={sx('background:var(--accent-soft);')}
                    onClick={() => onOpen(p.id)}
                  >
                    <span
                      style={sx(
                        `width:14px;text-align:center;font:400 11px 'IBM Plex Mono';color:${active ? 'var(--accent)' : 'var(--muted)'};`,
                      )}
                    >
                      {pageTypeGlyph(p.pageType)}
                    </span>
                    <span
                      style={sx(
                        `flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:${active ? 500 : 400} 13px 'IBM Plex Sans';color:${active ? 'var(--ink)' : 'var(--ink-soft)'};`,
                      )}
                    >
                      {p.title || 'Untitled'}
                    </span>
                  </Hov>
                )
              })}
          </div>
        )
      })}

      <div style={sx('flex:1;')} />
      <div
        style={sx(
          'display:flex;align-items:center;gap:8px;padding:9px 11px 2px;margin-top:10px;border-top:1px solid var(--border);',
        )}
      >
        <span style={sx('width:7px;height:7px;border-radius:50%;background:#4caf7d;')} />
        <span style={sx("font:400 11px 'IBM Plex Mono';color:var(--muted);")}>
          {pages.length} pages · {edgeCount} links
        </span>
      </div>
    </div>
  )
}
