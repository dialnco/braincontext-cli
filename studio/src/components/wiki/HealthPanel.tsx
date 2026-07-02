import { useMemo } from 'react'
import type { LintFinding, LintKind, LintReport, WikiLogRow } from '../../api/types'
import { Hov, sx } from '../../lib/dc'
import { relTime } from '../../lib/time'

interface Props {
  report: LintReport | null
  loading: boolean
  /** Recent wiki operations (ingest/verify/…), newest first. */
  log: WikiLogRow[]
  onOpen: (id: string) => void
  onClose: () => void
}

/** Display order + copy for each finding kind (worst first). */
const KIND_META: Array<{ kind: LintKind; label: string; hint: string; color: string }> = [
  {
    kind: 'dangling',
    label: 'Dangling links',
    hint: 'link to a missing or deleted page',
    color: '#b4533f',
  },
  {
    kind: 'stale',
    label: 'Stale pages',
    hint: 'verified long ago — re-verify or update',
    color: '#c98a6a',
  },
  {
    kind: 'never-verified',
    label: 'Never verified',
    hint: 'old content nobody has checked',
    color: '#c98a6a',
  },
  {
    kind: 'drift',
    label: 'Code drift',
    hint: 'documented source files changed since the last verify',
    color: '#b4533f',
  },
  {
    kind: 'wanted',
    label: 'Wanted pages',
    hint: '[[links]] to pages that do not exist yet',
    color: '#c98a6a',
  },
  { kind: 'orphan', label: 'Orphans', hint: 'no other page links here', color: 'var(--muted)' },
  {
    kind: 'ambiguous-wikilink',
    label: 'Ambiguous titles',
    hint: 'several pages share a title',
    color: '#b4533f',
  },
  {
    kind: 'source-without-page',
    label: 'Undigested sources',
    hint: 'no page derives from this source',
    color: 'var(--muted)',
  },
  {
    kind: 'missing-from-index',
    label: 'Missing from index',
    hint: 'not linked from the index page',
    color: 'var(--muted)',
  },
]

export function HealthPanel({ report, loading, log, onOpen, onClose }: Props) {
  const grouped = useMemo(() => {
    const byKind = new Map<string, LintFinding[]>()
    for (const f of report?.findings ?? []) {
      const list = byKind.get(f.kind) ?? []
      list.push(f)
      byKind.set(f.kind, list)
    }
    return byKind
  }, [report])

  const total = report?.findings.length ?? 0

  return (
    <div
      style={sx(
        'position:absolute;inset:0;z-index:20;background:var(--bg);display:flex;flex-direction:column;animation:mw-fade .18s ease;',
      )}
    >
      <div
        style={sx(
          'height:52px;flex:0 0 52px;display:flex;align-items:center;gap:14px;padding:0 18px;border-bottom:1px solid var(--border);background:var(--panel);',
        )}
      >
        <span style={sx("font:600 14px 'IBM Plex Sans';color:var(--ink);")}>Wiki health</span>
        <span style={sx("font:400 12px 'IBM Plex Mono';color:var(--muted);")}>
          {loading
            ? 'checking…'
            : total === 0
              ? 'no findings'
              : `${total} finding${total === 1 ? '' : 's'}`}
        </span>
        <span style={sx('flex:1;')} />
        <Hov
          base={sx(
            "width:30px;height:30px;border-radius:8px;border:1px solid var(--border);background:var(--surface);display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--ink-soft);font:300 18px/1 'IBM Plex Sans';",
          )}
          hover={sx('border-color:var(--accent);')}
          onClick={onClose}
        >
          ✕
        </Hov>
      </div>

      <div className="scroll" style={sx('flex:1;min-height:0;overflow-y:auto;')}>
        <div style={sx('max-width:720px;margin:0 auto;padding:30px 40px 80px;')}>
          {total === 0 && !loading && (
            <div
              style={sx(
                "font:400 15px 'Spectral',serif;font-style:italic;color:var(--muted);text-align:center;padding:60px 0;",
              )}
            >
              The wiki is healthy — every page linked, nothing stale.
            </div>
          )}
          {KIND_META.map(({ kind, label, hint, color }) => {
            const findings = grouped.get(kind)
            if (!findings || findings.length === 0) return null
            return (
              <div key={kind} style={sx('margin-bottom:26px;')}>
                <div style={sx('display:flex;align-items:baseline;gap:9px;margin-bottom:4px;')}>
                  <span
                    style={sx(
                      `width:8px;height:8px;border-radius:50%;background:${color};flex:0 0 auto;align-self:center;`,
                    )}
                  />
                  <span style={sx("font:600 13px 'IBM Plex Sans';color:var(--ink);")}>
                    {label} · {findings.length}
                  </span>
                  <span
                    style={sx(
                      "font:400 12px 'Spectral',serif;font-style:italic;color:var(--muted);",
                    )}
                  >
                    {hint}
                  </span>
                </div>
                {findings.map((f, i) => (
                  <Hov
                    key={`${f.kind}-${f.pageId ?? f.title ?? i}-${i}`}
                    base={sx(
                      `display:flex;align-items:center;gap:10px;padding:7px 10px;margin:2px 0;border-radius:8px;border:1px solid var(--border);background:var(--surface);${f.pageId ? 'cursor:pointer;' : ''}`,
                    )}
                    hover={sx(f.pageId ? 'border-color:var(--accent);' : '')}
                    onClick={() => f.pageId && onOpen(f.pageId)}
                  >
                    <span
                      style={sx(
                        "min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:500 13px 'IBM Plex Sans';color:var(--ink-soft);",
                      )}
                    >
                      {f.title || f.pageId || '—'}
                    </span>
                    <span style={sx('flex:1;')} />
                    <span
                      style={sx(
                        "flex:0 0 auto;font:400 11px 'IBM Plex Mono';color:var(--muted);white-space:nowrap;max-width:340px;overflow:hidden;text-overflow:ellipsis;",
                      )}
                    >
                      {f.detail}
                    </span>
                  </Hov>
                ))}
              </div>
            )
          })}

          {log.length > 0 && (
            <div style={sx('margin-top:36px;')}>
              <div
                style={sx(
                  "font:600 11px 'IBM Plex Mono';letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin-bottom:10px;",
                )}
              >
                Activity
              </div>
              {log.map((e, i) => (
                <Hov
                  key={`${e.createdAt}-${e.op}-${i}`}
                  base={sx(
                    `display:flex;align-items:center;gap:10px;padding:6px 10px;margin:1px 0;border-radius:8px;${e.refId ? 'cursor:pointer;' : ''}`,
                  )}
                  hover={sx(e.refId ? 'background:var(--accent-soft);' : '')}
                  onClick={() => e.refId && onOpen(e.refId)}
                >
                  <span
                    style={sx(
                      "flex:0 0 60px;font:500 11px 'IBM Plex Mono';color:var(--accent-ink);",
                    )}
                  >
                    {e.op}
                  </span>
                  <span
                    style={sx(
                      "min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:400 13px 'IBM Plex Sans';color:var(--ink-soft);",
                    )}
                  >
                    {e.title ?? e.detail ?? '—'}
                  </span>
                  <span style={sx('flex:1;')} />
                  {e.agentSource && (
                    <span
                      style={sx("flex:0 0 auto;font:400 11px 'IBM Plex Mono';color:var(--muted);")}
                    >
                      {e.agentSource}
                    </span>
                  )}
                  <span
                    style={sx(
                      "flex:0 0 auto;font:400 11px 'IBM Plex Mono';color:var(--muted);white-space:nowrap;",
                    )}
                  >
                    {relTime(e.createdAt)}
                  </span>
                </Hov>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
