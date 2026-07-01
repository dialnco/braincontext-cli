import { useMemo, useState } from 'react'
import type { Context, LinkView } from '../../api/types'
import { Hov, sx } from '../../lib/dc'

interface Props {
  page: Context
  pages: Context[]
  links: LinkView[]
  backlinks: LinkView[]
  onOpen: (id: string) => void
  onExpandGraph: () => void
  onLinkMention: (mentionId: string) => void
  tagFilter: string | null
  onTagClick: (tag: string) => void
  onAddTag: (tag: string) => void
  onRemoveTag: (tag: string) => void
}

const DIVIDER = 'height:1px;background:var(--border);margin:18px 0;'
const HEADING =
  "font:600 11px 'IBM Plex Mono';letter-spacing:.1em;text-transform:uppercase;color:var(--muted);"

function stripWikilinks(md: string): string {
  return md
    .replace(/\[\[[^\]]*\]\]/g, ' ')
    .replace(/[#>*`_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

function excerpt(body: string): string {
  const text = body
    .replace(/\[\[[^\]|]*\|?([^\]]*)\]\]/g, '$1')
    .replace(/[#>*`_]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > 110 ? `${text.slice(0, 110)}…` : text
}

export function RightPanel({
  page,
  pages,
  links,
  backlinks,
  onOpen,
  onExpandGraph,
  onLinkMention,
  tagFilter,
  onTagClick,
  onAddTag,
  onRemoveTag,
}: Props) {
  const [tab, setTab] = useState<'linked' | 'unlinked'>('linked')

  const outline = useMemo(() => {
    const out: string[] = []
    for (const line of page.body.split('\n')) {
      const m = line.match(/^##\s+(.+)$/)
      if (m?.[1]) out.push(m[1].trim())
    }
    return out
  }, [page.body])

  const pageById = useMemo(() => new Map(pages.map((p) => [p.id, p])), [pages])
  const resolved = links.filter((l) => !l.wanted && l.pageId)
  const wanted = links.filter((l) => l.wanted)

  const unlinked = useMemo(() => {
    const title = (page.title ?? '').toLowerCase().trim()
    if (title.length < 3) return []
    const linkedIds = new Set(backlinks.map((b) => b.pageId))
    return pages.filter(
      (p) => p.id !== page.id && !linkedIds.has(p.id) && stripWikilinks(p.body).includes(title),
    )
  }, [page, pages, backlinks])

  const tabSty = (on: boolean) =>
    `font:${on ? 600 : 500} 12px 'IBM Plex Sans';color:${on ? 'var(--ink)' : 'var(--muted)'};cursor:pointer;padding-bottom:11px;margin-bottom:-1px;border-bottom:2px solid ${on ? 'var(--accent)' : 'transparent'};`

  const localGraph = useMemo(() => buildLocalGraph(resolved, backlinks), [resolved, backlinks])

  return (
    <div
      className="scroll"
      style={sx(
        'width:300px;flex:0 0 300px;background:var(--panel);border-left:1px solid var(--border);overflow-y:auto;padding:18px 17px 28px;',
      )}
    >
      <div style={sx(`${HEADING}margin-bottom:13px;`)}>Properties</div>
      <div style={sx('display:flex;flex-direction:column;gap:11px;')}>
        <Prop label="type" value={page.pageType ?? '—'} />
        <Prop label="slug" value={page.slug ?? '—'} mono />
        <Prop label="created" value={page.createdAt.slice(0, 10)} mono />
        <Prop label="updated" value={page.updatedAt.slice(0, 10)} mono />
      </div>
      <div style={sx('display:flex;flex-wrap:wrap;gap:6px;margin-top:12px;align-items:center;')}>
        {page.tags.map((t) => (
          <TagChip
            key={t}
            tag={t}
            active={t === tagFilter}
            onFilter={() => onTagClick(t)}
            onRemove={() => onRemoveTag(t)}
          />
        ))}
        <TagAdd key="__add" existing={page.tags} onAdd={onAddTag} />
      </div>

      {outline.length > 0 && (
        <>
          <div style={sx(DIVIDER)} />
          <div style={sx(`${HEADING}margin-bottom:11px;`)}>On this page</div>
          {outline.map((text, i) => (
            <Hov
              key={`${text}-${i}`}
              base={sx(
                "font:400 13px/1.5 'IBM Plex Sans';color:var(--ink-soft);padding:3px 0;cursor:pointer;",
              )}
              hover={sx('color:var(--accent-ink);')}
              onClick={() => scrollToHeading(i)}
            >
              {text}
            </Hov>
          ))}
        </>
      )}

      <div style={sx(DIVIDER)} />
      <div
        style={sx(
          'display:flex;align-items:center;justify-content:space-between;margin-bottom:11px;',
        )}
      >
        <span style={sx(HEADING)}>Links</span>
        <span style={sx("font:400 11px 'IBM Plex Mono';color:var(--muted);")}>
          {resolved.length} out · {backlinks.length} in
        </span>
      </div>
      {resolved.map((lk) => (
        <Hov
          key={lk.id}
          base={sx(
            'display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:7px;cursor:pointer;',
          )}
          hover={sx('background:var(--accent-soft);')}
          onClick={() => lk.pageId && onOpen(lk.pageId)}
        >
          <span style={sx("flex:0 0 auto;color:var(--accent);font:400 12px 'IBM Plex Mono';")}>
            →
          </span>
          <span
            style={sx(
              "flex:1;min-width:0;overflow-wrap:anywhere;font:400 13px 'IBM Plex Sans';color:var(--ink-soft);",
            )}
          >
            {lk.title}
          </span>
          <span
            style={sx(
              "flex:0 0 auto;white-space:nowrap;font:400 10px 'IBM Plex Mono';color:var(--muted);",
            )}
          >
            {lk.type}
          </span>
        </Hov>
      ))}
      {wanted.map((lk) => (
        <div key={lk.id} style={sx('display:flex;align-items:center;gap:8px;padding:5px 8px;')}>
          <span style={sx("flex:0 0 auto;color:#c98a6a;font:400 12px 'IBM Plex Mono';")}>→</span>
          <span
            style={sx(
              "flex:1;min-width:0;overflow-wrap:anywhere;font:400 13px 'IBM Plex Sans';color:var(--muted);font-style:italic;",
            )}
          >
            {lk.title}
          </span>
          <span
            style={sx(
              "flex:0 0 auto;white-space:nowrap;font:400 10px 'IBM Plex Mono';color:#c98a6a;",
            )}
          >
            wanted
          </span>
        </div>
      ))}

      <div style={sx(DIVIDER)} />
      <div
        style={sx(
          'display:flex;align-items:center;gap:16px;border-bottom:1px solid var(--border);margin-bottom:13px;',
        )}
      >
        <span onClick={() => setTab('linked')} style={sx(tabSty(tab === 'linked'))}>
          Linked · {backlinks.length}
        </span>
        <span onClick={() => setTab('unlinked')} style={sx(tabSty(tab === 'unlinked'))}>
          Unlinked · {unlinked.length}
        </span>
      </div>
      {tab === 'linked' &&
        (backlinks.length === 0 ? (
          <Empty text="No pages link here yet — a quiet corner of the wiki." />
        ) : (
          backlinks.map((bl) => {
            const src = bl.pageId ? pageById.get(bl.pageId) : undefined
            return (
              <Hov
                key={bl.id}
                base={sx(
                  'border:1px solid var(--border);border-radius:9px;padding:9px 11px;margin-bottom:8px;cursor:pointer;background:var(--surface);',
                )}
                hover={sx('border-color:var(--accent);')}
                onClick={() => bl.pageId && onOpen(bl.pageId)}
              >
                <div
                  style={sx(
                    "overflow-wrap:anywhere;font:500 12.5px 'IBM Plex Sans';color:var(--ink);margin-bottom:3px;",
                  )}
                >
                  {bl.title}
                </div>
                {src && (
                  <div style={sx("font:400 12px/1.5 'Spectral',serif;color:var(--muted);")}>
                    {excerpt(src.body)}
                  </div>
                )}
              </Hov>
            )
          })
        ))}
      {tab === 'unlinked' &&
        (unlinked.length === 0 ? (
          <Empty text="No unlinked mentions — every reference is already a link." />
        ) : (
          unlinked.map((um) => (
            <Hov
              key={um.id}
              base={sx(
                'border:1px solid var(--border);border-radius:9px;padding:9px 11px;margin-bottom:8px;cursor:pointer;background:var(--surface);',
              )}
              hover={sx('border-color:var(--accent);')}
              onClick={() => onOpen(um.id)}
            >
              <div
                style={sx('display:flex;align-items:center;justify-content:space-between;gap:8px;')}
              >
                <div
                  style={sx(
                    "min-width:0;overflow-wrap:anywhere;font:500 12.5px 'IBM Plex Sans';color:var(--ink);",
                  )}
                >
                  {um.title || 'Untitled'}
                </div>
                <Hov
                  as="span"
                  base={sx(
                    "font:500 10.5px 'IBM Plex Mono';color:var(--accent-ink);border:1px solid var(--accent);border-radius:6px;padding:2px 7px;cursor:pointer;flex:0 0 auto;",
                  )}
                  hover={sx('background:var(--accent-soft);')}
                  onClick={(e: React.MouseEvent) => {
                    e.stopPropagation()
                    onLinkMention(um.id)
                  }}
                >
                  + link
                </Hov>
              </div>
              <div
                style={sx("font:400 12px/1.5 'Spectral',serif;color:var(--muted);margin-top:4px;")}
              >
                {excerpt(um.body)}
              </div>
            </Hov>
          ))
        ))}

      <div style={sx(DIVIDER)} />
      <div
        style={sx(
          'display:flex;align-items:center;justify-content:space-between;margin-bottom:11px;',
        )}
      >
        <span style={sx(HEADING)}>Local graph</span>
        <Hov
          as="span"
          base={sx("font:400 11px 'IBM Plex Sans';color:var(--accent-ink);cursor:pointer;")}
          hover={sx('text-decoration:underline;')}
          onClick={onExpandGraph}
        >
          Expand →
        </Hov>
      </div>
      <div
        onClick={onExpandGraph}
        style={sx(
          'border:1px solid var(--border);border-radius:10px;background:var(--surface);height:150px;cursor:pointer;overflow:hidden;',
        )}
      >
        <svg viewBox="0 0 260 150" style={sx('width:100%;height:100%;display:block;')}>
          {localGraph.edges.map((e, i) => (
            <line
              key={`e-${i}`}
              x1={e.x1}
              y1={e.y1}
              x2={e.x2}
              y2={e.y2}
              stroke="var(--border)"
              strokeWidth="1"
            />
          ))}
          {localGraph.nodes.map((n, i) => (
            <circle
              key={`n-${i}`}
              cx={n.x}
              cy={n.y}
              r={n.r}
              fill={n.fill}
              stroke={n.stroke}
              strokeWidth="1.5"
            />
          ))}
        </svg>
      </div>
    </div>
  )
}

function Prop({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={sx('display:flex;align-items:center;gap:10px;')}>
      <span
        style={sx("width:64px;flex:0 0 64px;font:400 12px 'IBM Plex Mono';color:var(--muted);")}
      >
        {label}
      </span>
      <span
        style={sx(
          `font:${mono ? "400 13px 'IBM Plex Mono'" : "500 13px 'IBM Plex Sans'"};color:var(--ink-soft);overflow:hidden;text-overflow:ellipsis;`,
        )}
      >
        {value}
      </span>
    </div>
  )
}

function TagChip({
  tag,
  active,
  onFilter,
  onRemove,
}: {
  tag: string
  active: boolean
  onFilter: () => void
  onRemove: () => void
}) {
  return (
    <Hov
      as="span"
      base={sx(
        `display:inline-flex;align-items:center;gap:5px;font:500 11px 'IBM Plex Mono';border-radius:6px;padding:2px 8px;cursor:pointer;${active ? 'color:#fff;background:var(--accent);' : 'color:var(--accent-ink);background:var(--accent-soft);'}`,
      )}
      hover={sx(
        active ? 'background:var(--accent);' : 'background:var(--accent-soft);color:var(--accent);',
      )}
      onClick={onFilter}
      title={active ? 'Clear tag filter' : `Filter pages tagged #${tag}`}
    >
      #{tag}
      <Hov
        as="span"
        base={sx('display:inline-flex;opacity:.45;cursor:pointer;')}
        hover={sx('opacity:1;')}
        onClick={(e: React.MouseEvent) => {
          e.stopPropagation()
          onRemove()
        }}
        title="Remove tag"
      >
        ✕
      </Hov>
    </Hov>
  )
}

function TagAdd({ existing, onAdd }: { existing: string[]; onAdd: (tag: string) => void }) {
  const [open, setOpen] = useState(false)
  const [val, setVal] = useState('')

  const commit = () => {
    const parts = val
      .split(',')
      .map((t) => t.trim().replace(/^#+/, '').trim())
      .filter(Boolean)
    for (const t of parts) if (!existing.includes(t)) onAdd(t)
    setVal('')
  }

  if (!open) {
    return (
      <Hov
        as="span"
        base={sx(
          "font:500 11px 'IBM Plex Mono';color:var(--accent-ink);border:1px solid var(--accent);border-radius:6px;padding:2px 7px;cursor:pointer;",
        )}
        hover={sx('background:var(--accent-soft);')}
        onClick={() => setOpen(true)}
        title="Add tag"
      >
        +
      </Hov>
    )
  }

  return (
    <input
      autoFocus
      value={val}
      onChange={(e) => setVal(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ',') {
          e.preventDefault()
          commit()
        } else if (e.key === 'Escape') {
          setVal('')
          setOpen(false)
        }
      }}
      onBlur={() => {
        if (val.trim()) commit()
        setOpen(false)
      }}
      placeholder="add tag"
      style={sx(
        "width:88px;border:1px solid var(--accent);background:transparent;outline:none;border-radius:6px;padding:2px 7px;font:400 11px 'IBM Plex Mono';color:var(--accent-ink);",
      )}
    />
  )
}

function Empty({ text }: { text: string }) {
  return (
    <div style={sx("font:400 12.5px/1.5 'Spectral',serif;color:var(--muted);font-style:italic;")}>
      {text}
    </div>
  )
}

function scrollToHeading(i: number): void {
  const hs = document.querySelectorAll('[data-editor] h2')
  const h = hs[i] as HTMLElement | undefined
  if (h) h.scrollIntoView({ block: 'start', behavior: 'smooth' })
}

function buildLocalGraph(out: LinkView[], back: LinkView[]) {
  const ids = [...new Set([...out, ...back].map((l) => l.pageId).filter(Boolean))].slice(
    0,
    7,
  ) as string[]
  const cx = 130
  const cy = 75
  const R = 52
  const nodes: { x: number; y: number; r: number; fill: string; stroke: string }[] = []
  const edges: { x1: number; y1: number; x2: number; y2: number }[] = []
  ids.forEach((_, i) => {
    const ang = (i / Math.max(1, ids.length)) * Math.PI * 2 - Math.PI / 2
    const x = cx + Math.cos(ang) * R
    const y = cy + Math.sin(ang) * (R * 0.78)
    edges.push({ x1: cx, y1: cy, x2: x, y2: y })
    nodes.push({ x, y, r: 4.5, fill: 'var(--surface)', stroke: 'var(--muted)' })
  })
  nodes.push({ x: cx, y: cy, r: 7, fill: 'var(--accent)', stroke: 'var(--accent)' })
  return { nodes, edges }
}
