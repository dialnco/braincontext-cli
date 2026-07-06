import { useEffect, useState } from 'react'
import { Hov, sx } from '../../lib/dc'

interface Props {
  /** Dialog heading, e.g. "Delete column". */
  heading: string
  /** Body copy describing the action / consequences. */
  message: string
  /** Label for the confirm button (defaults to "Confirm"). */
  confirmLabel?: string
  /** When true the confirm button is styled destructive (red). */
  destructive?: boolean
  onConfirm: () => void | Promise<void>
  onCancel: () => void
}

/**
 * A generic confirm modal (heading + message + one confirm button). Copies the
 * ConfirmDeleteDialog scrim convention (fixed z-index:80 scrim + centered panel,
 * mw-fade/mw-pop, Escape/scrim-click cancel) — no portal exists in this app — but
 * without the delete-specific soft/hard checkbox, so it fits any destructive action.
 */
export function ConfirmDialog({
  heading,
  message,
  confirmLabel = 'Confirm',
  destructive = true,
  onConfirm,
  onCancel,
}: Props) {
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
      await onConfirm()
    } finally {
      setBusy(false)
    }
  }

  const confirmColor = destructive ? '#b4533f' : 'var(--accent-ink)'
  const confirmHover = destructive ? '#9c4536' : 'var(--accent)'

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
          style={sx("font:400 13px/1.55 'IBM Plex Sans';color:var(--ink-soft);margin-bottom:18px;")}
        >
          {message}
        </div>
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
              `font:500 11px 'IBM Plex Mono';color:#fff;background:${confirmColor};border:1px solid ${confirmColor};border-radius:7px;padding:5px 13px;cursor:pointer;${busy ? 'opacity:.6;pointer-events:none;' : ''}`,
            )}
            hover={sx(`background:${confirmHover};border-color:${confirmHover};`)}
            onClick={confirm}
            disabled={busy}
          >
            {confirmLabel}
          </Hov>
        </div>
      </div>
    </div>
  )
}
