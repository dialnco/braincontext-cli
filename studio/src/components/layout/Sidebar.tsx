import { useMemo, useState } from 'react'
import type { Context } from '../../api/types'
import { Hov, sx } from '../../lib/dc'
import { pageTypeGlyph, pageTypeLabel } from '../../lib/theme'
import { buildPageTree, type TreeFolder } from '../../lib/tree'

/** Sidebar order for the page-type groups (the wiki taxonomy as "folders"). */
const GROUP_ORDER = ['index', 'entity', 'concept', 'summary', 'comparison', 'analysis', 'source']

const baseRow =
  'display:flex;align-items:center;gap:6px;padding:4px 9px;margin:1px 4px;border-radius:7px;cursor:pointer;transition:background .12s;'

interface Props {
  pages: Context[]
  activeId: string | null
  edgeCount: number
  onOpen: (id: string) => void
  onNew: () => void
  /** Active tag filter, if any (the `pages` arrive already filtered to it). */
  tagFilter?: string | null
  onClearTag?: () => void
}

type Mode = 'folder' | 'type'

export function Sidebar({
  pages,
  activeId,
  edgeCount,
  onOpen,
  onNew,
  tagFilter,
  onClearTag,
}: Props) {
  const [mode, setMode] = useState<Mode>('folder')
  // `collapsed[key]` is an explicit user override: true = closed, false = open. In
  // folder mode `key` is a folder path; in type mode it's a page-type. The two modes
  // never render together, so they can share the map.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  const tree = useMemo(() => buildPageTree(pages), [pages])

  // Folder paths leading to the active page — these default to open so the active
  // page is revealed on load. A user toggle (recorded in `collapsed`) always wins.
  const activeAncestors = useMemo(() => {
    const set = new Set<string>()
    const ap = pages.find((p) => p.id === activeId)
    if (ap) {
      const segs = (ap.title ?? '')
        .split('/')
        .map((s) => s.trim())
        .filter(Boolean)
      let acc = ''
      for (let k = 0; k < segs.length - 1; k++) {
        const s = segs[k]
        if (s === undefined) continue
        acc = acc ? `${acc}/${s}` : s
        set.add(acc)
      }
    }
    return set
  }, [pages, activeId])

  const isOpen = (path: string): boolean =>
    collapsed[path] !== undefined ? collapsed[path] === false : activeAncestors.has(path)
  // Trade-off: a folder the user explicitly collapsed stays closed even if it later
  // becomes an ancestor of a newly-opened page. Acceptable; predictable.
  const toggle = (path: string) => setCollapsed((c) => ({ ...c, [path]: isOpen(path) }))

  // Type-mode groups (preserved from the original sidebar).
  const groups = new Map<string, Context[]>()
  for (const p of pages) {
    const key = p.pageType || 'other'
    const list = groups.get(key) ?? []
    list.push(p)
    groups.set(key, list)
  }
  const typeKeys = [...groups.keys()].sort((a, b) => {
    const ia = GROUP_ORDER.indexOf(a)
    const ib = GROUP_ORDER.indexOf(b)
    return (ia < 0 ? 9 : ia) - (ib < 0 ? 9 : ib)
  })

  const seg = (on: boolean) =>
    `padding:3px 9px;border-radius:6px;cursor:pointer;font:${on ? 600 : 500} 11px 'IBM Plex Sans';color:${on ? 'var(--ink)' : 'var(--muted)'};background:${on ? 'var(--accent-soft)' : 'transparent'};`

  return (
    <div
      className="scroll"
      style={sx(
        'width:250px;flex:0 0 250px;background:var(--panel);border-right:1px solid var(--border);overflow-y:auto;padding:12px 6px 18px;display:flex;flex-direction:column;',
      )}
    >
      <div style={sx('display:flex;align-items:center;gap:6px;padding:2px 8px 9px;')}>
        <span
          style={sx(
            "font:600 11px 'IBM Plex Mono';letter-spacing:.1em;text-transform:uppercase;color:var(--muted);",
          )}
        >
          Pages
        </span>
        <span style={sx('flex:1;')} />
        <div
          style={sx(
            'display:flex;background:var(--surface);border:1px solid var(--border);border-radius:7px;padding:2px;gap:1px;',
          )}
        >
          <span onClick={() => setMode('folder')} style={sx(seg(mode === 'folder'))}>
            Folder
          </span>
          <span onClick={() => setMode('type')} style={sx(seg(mode === 'type'))}>
            Type
          </span>
        </div>
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

      {tagFilter && (
        <div style={sx('padding:0 8px 9px;')}>
          <Hov
            as="span"
            base={sx(
              "display:inline-flex;align-items:center;gap:7px;font:500 11px 'IBM Plex Mono';color:var(--accent-ink);background:var(--accent-soft);border-radius:7px;padding:4px 9px;cursor:pointer;max-width:100%;",
            )}
            hover={sx('color:var(--accent);')}
            onClick={onClearTag}
            title="Clear tag filter"
          >
            <span
              style={sx('overflow:hidden;text-overflow:ellipsis;white-space:nowrap;')}
            >{`#${tagFilter} · ${pages.length}`}</span>
            <span style={sx('font-size:13px;line-height:1;')}>✕</span>
          </Hov>
        </div>
      )}

      {pages.length === 0 && (
        <div
          style={sx(
            "font:400 12.5px/1.5 'Spectral',serif;color:var(--muted);font-style:italic;padding:6px 12px;",
          )}
        >
          {tagFilter
            ? `No pages tagged #${tagFilter}.`
            : 'No pages yet. Press + to create the first one.'}
        </div>
      )}

      {mode === 'folder' ? (
        <TreeRows
          folder={tree}
          depth={0}
          activeId={activeId}
          isOpen={isOpen}
          onToggle={toggle}
          onOpen={onOpen}
        />
      ) : (
        typeKeys.map((key) => {
          const list = groups.get(key) ?? []
          const open = collapsed[key] !== true
          return (
            <div key={key}>
              <Hov
                base={sx(baseRow)}
                hover={sx('background:var(--accent-soft);')}
                onClick={() => setCollapsed((c) => ({ ...c, [key]: open }))}
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
        })
      )}

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

/** Recursively render a folder's subfolders (collapsible) then its files. */
function TreeRows({
  folder,
  depth,
  activeId,
  isOpen,
  onToggle,
  onOpen,
}: {
  folder: TreeFolder
  depth: number
  activeId: string | null
  isOpen: (path: string) => boolean
  onToggle: (path: string) => void
  onOpen: (id: string) => void
}) {
  return (
    <>
      {folder.folders.map((child) => {
        const open = isOpen(child.path)
        return (
          <div key={`d:${child.path}`}>
            <Hov
              base={sx(`${baseRow}padding-left:${depth * 14 + 9}px;`)}
              hover={sx('background:var(--accent-soft);')}
              onClick={() => onToggle(child.path)}
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
                  "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:600 13px 'IBM Plex Sans';color:var(--ink);letter-spacing:.01em;",
                )}
              >
                {child.name}
              </span>
              <span style={sx("font:400 11px 'IBM Plex Mono';color:var(--muted);")}>
                {child.count}
              </span>
            </Hov>
            {open && (
              <TreeRows
                folder={child}
                depth={depth + 1}
                activeId={activeId}
                isOpen={isOpen}
                onToggle={onToggle}
                onOpen={onOpen}
              />
            )}
          </div>
        )
      })}
      {folder.files.map((file) => {
        const active = file.page.id === activeId
        return (
          <Hov
            key={file.page.id}
            base={sx(
              `${baseRow}padding-left:${depth * 14 + 26}px;${active ? 'background:var(--accent-soft);' : ''}`,
            )}
            hover={sx('background:var(--accent-soft);')}
            onClick={() => onOpen(file.page.id)}
          >
            <span
              style={sx(
                `width:14px;text-align:center;font:400 11px 'IBM Plex Mono';color:${active ? 'var(--accent)' : 'var(--muted)'};`,
              )}
            >
              {pageTypeGlyph(file.page.pageType)}
            </span>
            <span
              style={sx(
                `flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:${active ? 500 : 400} 13px 'IBM Plex Sans';color:${active ? 'var(--ink)' : 'var(--ink-soft)'};`,
              )}
            >
              {file.name}
            </span>
          </Hov>
        )
      })}
    </>
  )
}
