import { useState } from 'react'
import { exportApi } from '../../api/export'
import { Hov, sx } from '../../lib/dc'
import { useApp } from '../../state/StoreContext'
import { useAsync } from '../../state/useAsync'

/**
 * Read-only preview of what `bctx export` would write from the current store —
 * AGENTS.md / CLAUDE.md / .cursor/rules/*.mdc. Re-renders whenever contexts change
 * (`refreshKey` / `app.rev`) so editing a rule updates the preview live. Nothing is
 * written; this just shows the canonical managed-block content.
 */
export function ExportPreview({ refreshKey }: { refreshKey: number }) {
  const app = useApp()
  const projectKey = app.project?.project ?? ''
  const state = useAsync(() => exportApi.preview(), [app.rev, refreshKey, projectKey])
  const files = state.data ?? []
  const [active, setActive] = useState(0)
  const file = files[active] ?? files[0]

  const copy = async () => {
    if (!file) return
    try {
      await navigator.clipboard.writeText(file.content)
      app.toast('Copied')
    } catch {
      app.toast('Copy failed')
    }
  }

  return (
    <div style={sx('max-width:860px;margin:0 auto;padding:30px 48px 80px;')}>
      <div style={sx('display:flex;align-items:center;gap:10px;margin-bottom:6px;')}>
        <span style={sx("font:600 22px/1.2 'Spectral',serif;color:var(--ink);")}>
          Export preview
        </span>
        <span style={sx('flex:1;')} />
        <Hov
          as="button"
          base={sx(
            "font:500 11px 'IBM Plex Mono';color:var(--accent-ink);background:var(--accent-soft);border:1px solid transparent;border-radius:7px;padding:4px 11px;cursor:pointer;",
          )}
          hover={sx('border-color:var(--accent);')}
          onClick={copy}
        >
          Copy file
        </Hov>
      </div>
      <div
        style={sx(
          "font:400 13px/1.6 'Spectral',serif;font-style:italic;color:var(--muted);margin-bottom:18px;",
        )}
      >
        What{' '}
        <code style={sx("font-style:normal;font-family:'IBM Plex Mono';font-size:12px;")}>
          bctx export
        </code>{' '}
        would write from this project. Read-only — nothing is saved.
      </div>

      {files.length === 0 ? (
        <div
          style={sx(
            "padding:24px 0;font:400 14px/1.6 'Spectral',serif;font-style:italic;color:var(--muted);",
          )}
        >
          {state.loading ? 'Rendering…' : 'No contexts to export yet. Add a note or rule first.'}
        </div>
      ) : (
        <>
          <div style={sx('display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px;')}>
            {files.map((f, i) => (
              <Hov
                key={f.path}
                base={sx(
                  `font:500 11.5px 'IBM Plex Mono';border-radius:7px;padding:5px 11px;cursor:pointer;border:1px solid var(--border);${
                    i === active
                      ? 'background:var(--accent-soft);color:var(--accent-ink);border-color:var(--accent);'
                      : 'background:var(--surface);color:var(--muted);'
                  }`,
                )}
                hover={sx('color:var(--ink);')}
                onClick={() => setActive(i)}
              >
                {f.path}
              </Hov>
            ))}
          </div>
          {file && (
            <pre
              className="scroll"
              style={sx(
                "margin:0;padding:18px 20px;background:var(--code-bg);border:1px solid var(--border);border-radius:10px;overflow:auto;font:400 12.5px/1.65 'IBM Plex Mono',monospace;color:var(--ink-soft);white-space:pre-wrap;word-break:break-word;",
              )}
            >
              {file.content}
            </pre>
          )}
        </>
      )}
    </div>
  )
}
