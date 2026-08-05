import { useState } from 'react'
import { ApiError } from '../api/client'
import { Hov, sx } from '../lib/dc'
import { useApp } from '../state/StoreContext'

const input =
  "width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--ink);font:400 13.5px 'IBM Plex Mono';outline:none;"

/**
 * Shown when the project has access control on and this browser has no identity.
 *
 * The person who launched `bctx studio` normally never sees it — the server adopts
 * the key their CLI already holds. It appears when there is no local key, when the
 * key was revoked, or after an explicit sign-out.
 */
export function LoginView({ message }: { message?: string | null }) {
  const app = useApp()
  // Reached from "Switch identity" rather than by being locked out.
  const switching = app.auth?.authenticated === true
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    const trimmed = key.trim()
    if (!trimmed) return
    setBusy(true)
    setError(null)
    try {
      await app.login(trimmed)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Sign-in failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      style={sx(
        'flex:1;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--bg);',
      )}
    >
      <div style={sx('width:100%;max-width:440px;')}>
        <h1 style={sx("font:600 24px 'Spectral',serif;color:var(--ink);margin:0 0 6px;")}>
          {switching
            ? 'Sign in as someone else'
            : `${app.project?.project ?? 'This project'} needs a key`}
        </h1>
        <p style={sx("font:400 13.5px/1.6 'IBM Plex Sans';color:var(--muted);margin:0 0 18px;")}>
          {switching
            ? `Currently ${app.auth?.identity?.handle ?? 'unknown'} (from this machine's stored key). Paste another key to use a different identity here.`
            : (message ??
              'This project has access control enabled. Paste the access key your project admin gave you.')}
        </p>

        <input
          style={sx(input)}
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="bctxk.…"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit()
          }}
        />

        {error && (
          <div style={sx("font:500 12.5px 'IBM Plex Sans';color:#d0554a;margin:10px 0 0;")}>
            {error}
          </div>
        )}

        <Hov
          base={sx(
            `display:inline-block;margin:16px 0 0;padding:9px 20px;border-radius:8px;border:1px solid var(--accent);background:var(--accent);color:#fff;font:600 13px 'IBM Plex Sans';cursor:${busy ? 'default' : 'pointer'};opacity:${busy || !key.trim() ? 0.55 : 1};`,
          )}
          hover={sx(busy ? '' : 'filter:brightness(1.06);')}
          onClick={() => {
            if (!busy) void submit()
          }}
        >
          {busy ? 'Checking…' : 'Sign in'}
        </Hov>

        {switching && (
          <Hov
            base={sx(
              "display:inline-block;margin:16px 0 0 10px;padding:9px 18px;border-radius:8px;border:1px solid var(--border);background:var(--surface);color:var(--ink-soft);font:600 13px 'IBM Plex Sans';cursor:pointer;",
            )}
            hover={sx('border-color:var(--accent);')}
            onClick={app.cancelSwitchIdentity}
          >
            Cancel
          </Hov>
        )}

        <p style={sx("font:400 12.5px/1.6 'IBM Plex Mono';color:var(--muted);margin:22px 0 0;")}>
          Have a join code instead? Run <code>bctx project join &lt;code&gt;</code> in a terminal —
          it stores the key for this machine, and Studio picks it up on reload.
        </p>
      </div>
    </div>
  )
}
