import { useEffect, useState } from 'react'
import { Hov, sx } from '../../lib/dc'

interface Props {
  /** Dialog heading, e.g. "Delete page" or "Delete context". */
  heading: string
  /** The entry's title, shown (quoted) in the body copy. */
  name: string
  /** Confirm callback; `hard` is true when the user opted into a permanent delete. */
  onConfirm: (hard: boolean) => void | Promise<void>
  onCancel: () => void
}

/**
 * A small destructive-action confirmation modal. Reuses the CommandPalette overlay
 * pattern (fixed scrim + centered panel, mw-fade/mw-pop animations). Defaults to a
 * recoverable soft delete; the "Delete permanently" checkbox opts into a hard delete.
 */
export function ConfirmDeleteDialog({ heading, name, onConfirm, onCancel }: Props) {
  const [hard, setHard] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel])

  const confirm = async () => {
    setBusy(true)
    try {
      await onConfirm(hard)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      onClick={onCancel}
      style={sx(
        'position:fixed;inset:0;z-index:80;background:rgba(20,15,8,.32);display:flex;align-items:center;justify-content:center;animation:mw-fade .14s ease;',
      )}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={sx(
          'width:380px;max-width:88%;background:var(--panel);border:1px solid var(--border);border-radius:13px;box-shadow:0 30px 70px -20px rgba(20,15,5,.5);padding:20px 22px;animation:mw-pop .16s ease;',
        )}
      >
        <div style={sx("font:600 16px 'Spectral',serif;color:var(--ink);margin-bottom:9px;")}>
          {heading}
        </div>
        <div
          style={sx("font:400 13px/1.55 'IBM Plex Sans';color:var(--ink-soft);margin-bottom:16px;")}
        >
          Delete “{name || 'Untitled'}”?{' '}
          {hard ? 'This cannot be undone.' : 'It can be restored from history.'}
        </div>
        <label
          style={sx(
            "display:flex;align-items:center;gap:8px;cursor:pointer;font:400 12px 'IBM Plex Mono';color:var(--muted);margin-bottom:18px;",
          )}
        >
          <input type="checkbox" checked={hard} onChange={(e) => setHard(e.target.checked)} />
          Delete permanently
        </label>
        <div style={sx('display:flex;justify-content:flex-end;gap:8px;')}>
          <Hov
            as="button"
            base={sx(
              "font:500 11px 'IBM Plex Mono';color:var(--ink-soft);background:transparent;border:1px solid var(--border);border-radius:7px;padding:5px 13px;cursor:pointer;",
            )}
            hover={sx('background:var(--accent-soft);')}
            onClick={onCancel}
          >
            Cancel
          </Hov>
          <Hov
            as="button"
            base={sx(
              `font:500 11px 'IBM Plex Mono';color:#fff;background:#b4533f;border:1px solid #b4533f;border-radius:7px;padding:5px 13px;cursor:pointer;${busy ? 'opacity:.6;pointer-events:none;' : ''}`,
            )}
            hover={sx('background:#9c4536;border-color:#9c4536;')}
            onClick={confirm}
            disabled={busy}
          >
            {hard ? 'Delete permanently' : 'Delete'}
          </Hov>
        </div>
      </div>
    </div>
  )
}
