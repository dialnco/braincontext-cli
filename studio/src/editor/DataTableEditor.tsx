import { type Align, parseTables, type TableData } from '@core/lib/mdtable'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError } from '../api/client'
import type { Context } from '../api/types'
import type { TableOp } from '../api/wiki'
import { wikiApi } from '../api/wiki'
import { ConfirmDialog } from '../components/common/ConfirmDialog'
import { sx } from '../lib/dc'

/** Imperative handle so a parent (WikiView's ⌘Z handler) can drive undo/redo. */
export interface DataTableHandle {
  undo: () => void
  redo: () => void
  canUndo: () => boolean
  canRedo: () => boolean
}

interface Props {
  page: Context
  readOnly?: boolean
  /** Called after any successful mutation so the parent can refetch links/history. */
  onSaved?: (page: Context) => void
  /** Exposes undo/redo to the parent for ⌘Z / ⌘⇧Z routing. */
  handleRef?: React.MutableRefObject<DataTableHandle | null>
}

/** Parse a datatable body into its single table (null if it isn't exactly one clean table). */
function parseSingle(body: string): TableData | null {
  const tables = parseTables(body)
  const only = tables[0]
  if (!only || tables.length !== 1) return null
  return { header: only.header, alignments: only.alignments, rows: only.rows }
}

const ALIGN_CYCLE: Array<Align | null> = [null, 'left', 'center', 'right']
const ALIGN_GLYPH: Record<string, string> = { left: '⇤', center: '↔', right: '⇥', '': '≡' }

/**
 * Full-bleed grid editor for a `datatable` page (its body IS one canonical GFM table).
 * Server-authoritative: every cell/row/column mutation POSTs a single splice op to
 * `/pages/:id/table/op` and RESEEDS local state from the returned page — so the grid always
 * mirrors stored truth, alignment is preserved, and there is no lossy whole-body PATCH. A
 * stale-rev 409 refetches and re-seeds; a bad op surfaces the server's message inline.
 */
export function DataTableEditor({ page, readOnly, onSaved, handleRef }: Props) {
  const [table, setTable] = useState<TableData | null>(() => parseSingle(page.body))
  const revRef = useRef<string | undefined>(page.rev)
  const [status, setStatus] = useState<{ kind: 'idle' | 'busy' | 'error' | 'note'; msg?: string }>({
    kind: 'idle',
  })
  // Bumped only when row/column INDICES shift, so uncontrolled inputs remount and re-read their
  // values; a plain cell edit keeps the key stable so a cell being typed elsewhere isn't reset.
  const [seedKey, setSeedKey] = useState(0)
  // Serializes ops through one promise chain so each reads the latest rev (no self-inflicted 409s).
  const chain = useRef<Promise<void>>(Promise.resolve())
  // Pending column-delete awaiting confirmation (mirrors WikiView's `pendingDelete`).
  const [pendingCol, setPendingCol] = useState<number | null>(null)
  // Client-owned undo timeline: body snapshots oldest→newest + a cursor. Seeded from persisted
  // history so ⌘Z survives reloads; rebuilt only on page change / external conflict (never from
  // its own restore-writes), so undo/redo never oscillates over the restore rows it appends.
  const histRef = useRef<string[]>([])
  const curRef = useRef<number>(-1)

  const seed = useCallback((p: Context, remount: boolean) => {
    setTable(parseSingle(p.body))
    revRef.current = p.rev
    if (remount) setSeedKey((k) => k + 1)
  }, [])

  const pageId = page.id
  const pageRev = page.rev

  // Rebuild the undo timeline from the doc's saved revisions (newest→oldest → chronological body
  // list, deduped), ending at the current body. Called on page change and after a 409.
  const rebuildTimeline = useCallback(
    async (currentBody: string) => {
      try {
        const entries = await wikiApi.history(pageId, 200)
        const bodies: string[] = []
        for (const e of [...entries].reverse()) {
          const b = e.newBody ?? ''
          if (bodies[bodies.length - 1] !== b) bodies.push(b)
        }
        if (bodies[bodies.length - 1] !== currentBody) bodies.push(currentBody)
        histRef.current = bodies
        curRef.current = bodies.length - 1
      } catch {
        histRef.current = [currentBody]
        curRef.current = 0
      }
    },
    [pageId],
  )

  // biome-ignore lint/correctness/useExhaustiveDependencies: reseed only on page identity/rev change, not every render
  useEffect(() => {
    seed(page, true)
  }, [pageId, pageRev, seed])

  // biome-ignore lint/correctness/useExhaustiveDependencies: build the timeline once per page (uses the body at mount)
  useEffect(() => {
    void rebuildTimeline(page.body)
  }, [pageId, rebuildTimeline])

  const apply = useCallback(
    (op: TableOp): Promise<void> => {
      if (readOnly) return Promise.resolve()
      const run = async () => {
        setStatus({ kind: 'busy' })
        try {
          const updated = await wikiApi.tableOp(pageId, { ...op, ifRev: revRef.current })
          // A cell edit doesn't move indices → skip the remount (preserve an in-flight edit
          // elsewhere); every structural op reshapes the grid → remount from server truth.
          seed(updated, op.op !== 'setCell')
          // Record this edit in the undo timeline, dropping any redo-future.
          histRef.current = [...histRef.current.slice(0, curRef.current + 1), updated.body]
          curRef.current = histRef.current.length - 1
          setStatus({ kind: 'idle' })
          onSaved?.(updated)
        } catch (e) {
          if (e instanceof ApiError && e.status === 409) {
            const fresh = await wikiApi.get(pageId).catch(() => null)
            if (fresh) {
              seed(fresh, true)
              await rebuildTimeline(fresh.body)
            }
            setStatus({
              kind: 'note',
              msg: 'Reloaded — the table changed elsewhere. Retry your edit.',
            })
          } else {
            setStatus({ kind: 'error', msg: e instanceof Error ? e.message : 'Edit failed' })
          }
        }
      }
      chain.current = chain.current.then(run)
      return chain.current
    },
    [pageId, readOnly, seed, onSaved, rebuildTimeline],
  )

  // Restore a body snapshot (undo/redo). Whole-body write via updatePage (re-derives links);
  // does NOT push to the timeline — the cursor already points at the target.
  const restore = useCallback(
    (body: string, label: string): Promise<void> => {
      if (readOnly) return Promise.resolve()
      const run = async () => {
        setStatus({ kind: 'busy' })
        try {
          const updated = await wikiApi.update(pageId, {
            body,
            ifRev: revRef.current,
            agentSource: label,
          })
          seed(updated, true)
          setStatus({ kind: 'note', msg: label === 'redo' ? 'Redid an edit.' : 'Undid an edit.' })
          onSaved?.(updated)
        } catch (e) {
          if (e instanceof ApiError && e.status === 409) {
            const fresh = await wikiApi.get(pageId).catch(() => null)
            if (fresh) {
              seed(fresh, true)
              await rebuildTimeline(fresh.body)
            }
            setStatus({ kind: 'note', msg: 'Reloaded — the table changed elsewhere.' })
          } else {
            setStatus({ kind: 'error', msg: e instanceof Error ? e.message : 'Restore failed' })
          }
        }
      }
      chain.current = chain.current.then(run)
      return chain.current
    },
    [pageId, readOnly, seed, onSaved, rebuildTimeline],
  )

  const undo = useCallback(() => {
    if (curRef.current > 0) {
      curRef.current -= 1
      void restore(histRef.current[curRef.current] ?? '', 'undo')
    }
  }, [restore])
  const redo = useCallback(() => {
    if (curRef.current < histRef.current.length - 1) {
      curRef.current += 1
      void restore(histRef.current[curRef.current] ?? '', 'redo')
    }
  }, [restore])

  useEffect(() => {
    if (!handleRef) return
    handleRef.current = {
      undo,
      redo,
      canUndo: () => curRef.current > 0,
      canRedo: () => curRef.current < histRef.current.length - 1,
    }
    return () => {
      handleRef.current = null
    }
  }, [handleRef, undo, redo])

  const cols = useMemo(() => (table ? table.header.map((_, i) => i) : []), [table])

  if (!table) {
    return (
      <div
        style={sx('flex:1;display:flex;align-items:center;justify-content:center;padding:40px;')}
      >
        <div
          style={sx(
            "max-width:420px;text-align:center;font:400 15px/1.6 'Spectral',serif;color:var(--muted);",
          )}
        >
          This datatable doesn’t contain exactly one GFM table, so the grid editor can’t open it
          safely. Switch to the standard editor (layout toggle) to fix the body by hand.
        </div>
      </div>
    )
  }

  const alignOf = (ci: number): Align | null => table.alignments[ci] ?? null
  const cellStyle = (ci: number): string => {
    const a = alignOf(ci)
    return `border-right:1px solid var(--border);border-bottom:1px solid var(--border);padding:0;${a ? `text-align:${a};` : ''}`
  }
  const inputStyle = (ci: number): React.CSSProperties => ({
    ...sx(
      `width:100%;min-width:90px;box-sizing:border-box;border:none;outline:none;background:transparent;padding:8px 12px;font:400 15px/1.5 'Spectral',serif;color:var(--ink-soft);`,
    ),
    textAlign: (alignOf(ci) ?? 'left') as React.CSSProperties['textAlign'],
  })

  return (
    <div style={sx('flex:1;min-height:0;display:flex;flex-direction:column;')}>
      {/* Toolbar */}
      <div
        style={sx(
          'flex:0 0 auto;display:flex;align-items:center;gap:10px;padding:10px 20px;border-bottom:1px solid var(--border);background:var(--panel);',
        )}
      >
        {!readOnly && (
          <>
            <button type="button" onClick={() => apply({ op: 'addRow' })} style={toolBtn}>
              + Row
            </button>
            <button
              type="button"
              onClick={() => apply({ op: 'addColumn', name: `Column ${table.header.length + 1}` })}
              style={toolBtn}
            >
              + Column
            </button>
          </>
        )}
        <div style={sx('flex:1;')} />
        <div
          style={sx(
            `font:500 12px/1.4 'IBM Plex Mono',monospace;color:${status.kind === 'error' ? 'var(--accent-ink)' : 'var(--muted)'};max-width:50%;text-align:right;`,
          )}
        >
          {status.kind === 'busy'
            ? 'saving…'
            : status.kind === 'error'
              ? `⚠ ${status.msg}`
              : status.kind === 'note'
                ? status.msg
                : `${table.rows.length} rows · ${table.header.length} cols`}
        </div>
      </div>

      {/* Grid */}
      <div style={sx('flex:1;min-height:0;overflow:auto;')} className="scroll">
        <table
          style={sx(
            'border-collapse:separate;border-spacing:0;width:max-content;min-width:100%;margin:0;',
          )}
        >
          <thead>
            <tr>
              {!readOnly && <th style={sx(cornerStyle)} />}
              {cols.map((ci) => (
                <th key={`h${seedKey}:${ci}`} style={sx(headStyle)}>
                  <div style={sx('display:flex;align-items:center;gap:4px;')}>
                    <input
                      defaultValue={table.header[ci] ?? ''}
                      readOnly={readOnly}
                      onBlur={(e) => {
                        const name = e.currentTarget.value
                        if (!readOnly && name !== (table.header[ci] ?? '')) {
                          apply({ op: 'renameColumn', col: ci, name })
                        }
                      }}
                      style={{
                        ...sx(
                          "width:100%;min-width:80px;box-sizing:border-box;border:none;outline:none;background:transparent;padding:8px 10px;font:600 13px/1.4 'IBM Plex Sans',sans-serif;color:var(--ink);",
                        ),
                      }}
                    />
                    {!readOnly && (
                      <>
                        <button
                          type="button"
                          title="Cycle alignment"
                          onClick={() => {
                            const cur = alignOf(ci)
                            const next =
                              ALIGN_CYCLE[(ALIGN_CYCLE.indexOf(cur) + 1) % ALIGN_CYCLE.length] ??
                              null
                            apply({ op: 'setAlign', col: ci, align: next })
                          }}
                          style={miniBtn}
                        >
                          {ALIGN_GLYPH[alignOf(ci) ?? ''] ?? '≡'}
                        </button>
                        <button
                          type="button"
                          title="Delete column"
                          onClick={() => setPendingCol(ci)}
                          style={miniBtn}
                        >
                          ×
                        </button>
                      </>
                    )}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, ri) => (
              <tr key={`r${seedKey}:${ri}`}>
                {!readOnly && (
                  <td style={sx(rowHeadStyle)}>
                    <button
                      type="button"
                      title="Delete row"
                      onClick={() => apply({ op: 'deleteRow', row: ri })}
                      style={miniBtn}
                    >
                      ×
                    </button>
                  </td>
                )}
                {cols.map((ci) => (
                  <td key={ci} style={sx(cellStyle(ci))}>
                    <input
                      defaultValue={row[ci] ?? ''}
                      readOnly={readOnly}
                      onBlur={(e) => {
                        const value = e.currentTarget.value
                        if (!readOnly && value !== (row[ci] ?? '')) {
                          apply({ op: 'setCell', row: ri, col: ci, value })
                        }
                      }}
                      style={inputStyle(ci)}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {table.rows.length === 0 && (
          <div style={sx("padding:20px;font:400 14px/1.6 'Spectral',serif;color:var(--muted);")}>
            No rows yet — use “+ Row” to add one.
          </div>
        )}
      </div>

      {pendingCol !== null && (
        <ConfirmDialog
          heading="Delete column"
          message={`Remove “${table.header[pendingCol] || 'this column'}” and all ${table.rows.length} of its cells? You can undo with ⌘Z.`}
          confirmLabel="Delete column"
          onConfirm={() => {
            const col = pendingCol
            setPendingCol(null)
            void apply({ op: 'deleteColumn', col })
          }}
          onCancel={() => setPendingCol(null)}
        />
      )}
    </div>
  )
}

const toolBtn = sx(
  "cursor:pointer;border:1px solid var(--border);background:var(--surface);color:var(--ink);border-radius:7px;padding:5px 12px;font:600 12.5px/1 'IBM Plex Sans',sans-serif;",
)
const miniBtn = sx(
  "cursor:pointer;border:none;background:transparent;color:var(--muted);border-radius:5px;padding:2px 5px;font:600 12px/1 'IBM Plex Mono',monospace;flex:0 0 auto;",
)
const headStyle =
  'position:sticky;top:0;z-index:1;background:var(--code-bg);border-right:1px solid var(--border);border-bottom:1px solid var(--border);padding:0;'
const cornerStyle =
  'position:sticky;top:0;left:0;z-index:2;width:34px;background:var(--code-bg);border-right:1px solid var(--border);border-bottom:1px solid var(--border);'
const rowHeadStyle =
  'width:34px;text-align:center;background:var(--panel);border-right:1px solid var(--border);border-bottom:1px solid var(--border);'
