import { useMemo, useState } from 'react'
import type { Context, HistoryEntry, LinkView } from '../../api/types'
import { Hov, sx } from '../../lib/dc'
import { pageFreshness } from '../../lib/freshness'
import { relTime } from '../../lib/time'
import { estimateTokens, formatTokens } from '../../lib/tokens'
import { ConfirmDialog } from '../common/ConfirmDialog'

interface Props {
  page: Context
  pages: Context[]
  links: LinkView[]
  backlinks: LinkView[]
  /** Audit trail for this page, newest first. */
  history: HistoryEntry[]
  onOpen: (id: string) => void
  onExpandGraph: () => void
  onLinkMention: (mentionId: string) => void
  tagFilter: string | null
  onTagClick: (tag: string) => void
  onAddTag: (tag: string) => void
  onRemoveTag: (tag: string) => void
  /** Set (or delete, with null) one typed property; null value removes the key. */
  onSetProp: (key: string, value: string | number | boolean | null) => void
  /** Restore the page body to a past revision (that revision's post-edit state). */
  onRestoreRevision?: (entry: HistoryEntry) => void
}

/** A scalar value stored in metadata.props, coerced from a text input. */
type PropScalar = string | number | boolean

/** Read metadata.props as display-ready [key, value] pairs (scalars only, sorted). */
function readPageProps(metadata: Record<string, unknown>): [string, PropScalar][] {
  const raw = metadata.props
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
  const out: [string, PropScalar][] = []
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string' || typeof v === 'boolean') out.push([k, v])
    else if (typeof v === 'number' && Number.isFinite(v)) out.push([k, v])
  }
  return out.sort((a, b) => a[0].localeCompare(b[0]))
}

/** Coerce a text value to a typed scalar (number / boolean / string) — mirrors the CLI. */
function coerceProp(value: string): PropScalar {
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  if (value === 'true' || value === 'false') return value === 'true'
  return value
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
  history,
  onOpen,
  onExpandGraph,
  onLinkMention,
  tagFilter,
  onTagClick,
  onAddTag,
  onRemoveTag,
  onSetProp,
  onRestoreRevision,
}: Props) {
  const [tab, setTab] = useState<'linked' | 'unlinked' | 'history'>('linked')
  const [pendingRestore, setPendingRestore] = useState<HistoryEntry | null>(null)
  const fresh = pageFreshness(page)
  const props = useMemo(() => readPageProps(page.metadata), [page.metadata])
  // Fields are editable on authored pages; source is immutable and view/index are generated.
  const fieldsEditable =
    page.pageType !== 'source' && page.pageType !== 'index' && page.pageType !== 'view'

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
        <Prop label="tokens" value={formatTokens(estimateTokens(page.body))} mono />
        {fresh.verifiedAt && (
          <Prop
            label="verified"
            value={`${fresh.verifiedAt.slice(0, 10)}${fresh.verifiedBy ? ` · ${fresh.verifiedBy}` : ''}`}
            mono
          />
        )}
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

      {(props.length > 0 || fieldsEditable || page.pageType === 'view') && (
        <>
          <div style={sx(DIVIDER)} />
          <div
            style={sx(
              'display:flex;align-items:center;justify-content:space-between;margin-bottom:11px;',
            )}
          >
            <span style={sx(HEADING)}>Fields</span>
            <span style={sx("font:400 10px 'IBM Plex Mono';color:var(--muted);")}>queryable</span>
          </div>
          {page.pageType === 'view' ? (
            <ViewQuery metadata={page.metadata} />
          ) : (
            <div style={sx('display:flex;flex-direction:column;gap:8px;')}>
              {props.map(([k, v]) => (
                <PropRow
                  key={k}
                  name={k}
                  value={v}
                  editable={fieldsEditable}
                  onSet={(val) => onSetProp(k, val)}
                  onRemove={() => onSetProp(k, null)}
                />
              ))}
              {props.length === 0 && (
                <div
                  style={sx(
                    "font:400 12px/1.5 'Spectral',serif;color:var(--muted);font-style:italic;",
                  )}
                >
                  No fields yet — add typed properties to filter this page in queries and views.
                </div>
              )}
              {fieldsEditable && <PropAdd existing={props.map(([k]) => k)} onAdd={onSetProp} />}
            </div>
          )}
        </>
      )}

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
        <span onClick={() => setTab('history')} style={sx(tabSty(tab === 'history'))}>
          History · {history.length}
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
      {tab === 'history' &&
        (history.length === 0 ? (
          <Empty text="No recorded changes yet." />
        ) : (
          history.map((h, idx) => (
            <div
              key={h.id}
              style={sx(
                'display:flex;align-items:center;gap:8px;padding:6px 4px;border-bottom:1px solid var(--border);',
              )}
            >
              <span
                style={sx(
                  `flex:0 0 52px;font:500 10.5px 'IBM Plex Mono';color:${
                    h.event === 'delete' ? '#b4533f' : 'var(--accent-ink)'
                  };`,
                )}
              >
                {h.event}
              </span>
              <span
                style={sx(
                  "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:400 12px 'IBM Plex Sans';color:var(--ink-soft);",
                )}
                title={h.agentSource ?? undefined}
              >
                {h.agentSource ?? '—'}
              </span>
              <span
                style={sx(
                  "flex:0 0 auto;font:400 10.5px 'IBM Plex Mono';color:var(--muted);white-space:nowrap;",
                )}
                title={h.changedAt}
              >
                {relTime(h.changedAt)}
              </span>
              {onRestoreRevision && idx > 0 && h.newBody != null && (
                <Hov
                  as="button"
                  base={sx(
                    "flex:0 0 auto;font:500 10px 'IBM Plex Mono';color:var(--accent-ink);background:transparent;border:1px solid var(--border);border-radius:6px;padding:2px 7px;cursor:pointer;",
                  )}
                  hover={sx('background:var(--accent-soft);border-color:var(--accent);')}
                  title="Restore this version"
                  onClick={() => setPendingRestore(h)}
                >
                  ↩ Restore
                </Hov>
              )}
            </div>
          ))
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

      {pendingRestore && (
        <ConfirmDialog
          heading="Restore version"
          message={`Restore this page to its ${pendingRestore.event} from ${relTime(
            pendingRestore.changedAt,
          )}? The current version is kept in history, so you can undo this.`}
          confirmLabel="Restore"
          destructive={false}
          onConfirm={() => {
            const entry = pendingRestore
            setPendingRestore(null)
            onRestoreRevision?.(entry)
          }}
          onCancel={() => setPendingRestore(null)}
        />
      )}
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

/** One editable typed property: mono key + inline-editable value + delete. */
function PropRow({
  name,
  value,
  editable,
  onSet,
  onRemove,
}: {
  name: string
  value: PropScalar
  editable: boolean
  onSet: (value: PropScalar) => void
  onRemove: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [val, setVal] = useState(String(value))

  const commit = () => {
    const next = val.trim()
    setEditing(false)
    if (next && next !== String(value)) onSet(coerceProp(next))
    else setVal(String(value))
  }

  return (
    <div style={sx('display:flex;align-items:center;gap:10px;')}>
      <span
        style={sx(
          "width:72px;flex:0 0 72px;overflow:hidden;text-overflow:ellipsis;font:400 12px 'IBM Plex Mono';color:var(--muted);",
        )}
        title={name}
      >
        {name}
      </span>
      {editing ? (
        <input
          autoFocus
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commit()
            } else if (e.key === 'Escape') {
              setVal(String(value))
              setEditing(false)
            }
          }}
          onBlur={commit}
          style={sx(
            "flex:1;min-width:0;border:1px solid var(--accent);background:transparent;outline:none;border-radius:6px;padding:2px 7px;font:400 12px 'IBM Plex Mono';color:var(--accent-ink);",
          )}
        />
      ) : (
        <Hov
          base={sx(
            `flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;font:400 13px 'IBM Plex Mono';color:var(--ink-soft);border-radius:6px;padding:1px 5px;${editable ? 'cursor:text;' : ''}`,
          )}
          hover={sx(editable ? 'background:var(--accent-soft);' : '')}
          onClick={() => editable && setEditing(true)}
          title={editable ? 'Click to edit' : undefined}
        >
          {String(value)}
        </Hov>
      )}
      {editable && !editing && (
        <Hov
          as="span"
          base={sx('display:inline-flex;opacity:.4;cursor:pointer;flex:0 0 auto;')}
          hover={sx('opacity:1;color:#b4533f;')}
          onClick={onRemove}
          title="Remove field"
        >
          ✕
        </Hov>
      )}
    </div>
  )
}

/** The `+ field` control: opens a `key=value` input that sets a new typed property. */
function PropAdd({
  existing,
  onAdd,
}: {
  existing: string[]
  onAdd: (key: string, value: PropScalar) => void
}) {
  const [open, setOpen] = useState(false)
  const [val, setVal] = useState('')

  const commit = () => {
    const eq = val.indexOf('=')
    if (eq > 0) {
      const key = val.slice(0, eq).trim()
      const value = val.slice(eq + 1).trim()
      if (key && value && !existing.includes(key)) onAdd(key, coerceProp(value))
    }
    setVal('')
    setOpen(false)
  }

  if (!open) {
    return (
      <Hov
        as="span"
        base={sx(
          "align-self:flex-start;font:500 11px 'IBM Plex Mono';color:var(--accent-ink);border:1px solid var(--accent);border-radius:6px;padding:2px 8px;cursor:pointer;margin-top:2px;",
        )}
        hover={sx('background:var(--accent-soft);')}
        onClick={() => setOpen(true)}
        title="Add a typed field (key=value)"
      >
        + field
      </Hov>
    )
  }

  return (
    <input
      autoFocus
      value={val}
      onChange={(e) => setVal(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          commit()
        } else if (e.key === 'Escape') {
          setVal('')
          setOpen(false)
        }
      }}
      onBlur={commit}
      placeholder="status=active"
      style={sx(
        "border:1px solid var(--accent);background:transparent;outline:none;border-radius:6px;padding:3px 8px;font:400 12px 'IBM Plex Mono';color:var(--accent-ink);",
      )}
    />
  )
}

/** Read-only summary of a saved view's query + projected columns. */
function ViewQuery({ metadata }: { metadata: Record<string, unknown> }) {
  const where =
    metadata.query && typeof metadata.query === 'object'
      ? (metadata.query as { where?: unknown }).where
      : undefined
  const columns = Array.isArray(metadata.columns)
    ? (metadata.columns as unknown[]).filter((x): x is string => typeof x === 'string')
    : []
  return (
    <div style={sx('display:flex;flex-direction:column;gap:8px;')}>
      <div
        style={sx(
          "font:400 12px/1.5 'IBM Plex Mono';color:var(--ink-soft);background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:8px 10px;overflow-wrap:anywhere;",
        )}
      >
        {where ? JSON.stringify(where) : 'all pages'}
      </div>
      {columns.length > 0 && (
        <div style={sx("font:400 11px 'IBM Plex Mono';color:var(--muted);")}>
          columns: {columns.join(', ')}
        </div>
      )}
      <div style={sx("font:400 11.5px/1.5 'Spectral',serif;color:var(--muted);font-style:italic;")}>
        This view renders live from its query. Edit the query with the CLI/MCP.
      </div>
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
