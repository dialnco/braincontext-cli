import { useCallback, useEffect, useState } from 'react'
import {
  type AccessLogEntry,
  accessApi,
  type IssuedSecret,
  type KeyRecord,
  ROLE_OPTIONS,
  type Role,
  type User,
} from '../api/access'
import { ApiError } from '../api/client'
import { Hov, sx } from '../lib/dc'
import { useApp } from '../state/StoreContext'

const label =
  "display:block;font:600 11px 'IBM Plex Mono';letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:14px 0 5px;"
const input =
  "width:100%;box-sizing:border-box;padding:8px 11px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--ink);font:400 13.5px 'IBM Plex Mono';outline:none;"
const btn = (primary: boolean) =>
  `padding:8px 16px;border-radius:8px;cursor:pointer;border:1px solid ${primary ? 'var(--accent)' : 'var(--border)'};background:${primary ? 'var(--accent)' : 'var(--surface)'};color:${primary ? '#fff' : 'var(--ink-soft)'};font:600 13px 'IBM Plex Sans';`
const chip =
  "display:inline-block;padding:2px 8px;border-radius:999px;font:600 11px 'IBM Plex Mono';border:1px solid var(--border);color:var(--muted);"

const ROLE_HINT: Record<Role, string> = {
  owner: 'everything, including access control itself',
  admin: 'everything except removing the last owner',
  writer: 'read and write pages, files and entries',
  reader: 'read only',
}

/**
 * Users & access, rendered inside #/settings for anyone holding `users.manage`.
 *
 * The one-time secret panel is the load-bearing part: a key exists in the response
 * that created it and nowhere else, so this is the only moment it can be copied.
 */
export function AccessSection() {
  const app = useApp()
  const [users, setUsers] = useState<User[] | null>(null)
  const [keys, setKeys] = useState<Record<string, KeyRecord[]>>({})
  const [expanded, setExpanded] = useState<string | null>(null)
  const [log, setLog] = useState<AccessLogEntry[]>([])
  const [showLog, setShowLog] = useState(false)
  const [busy, setBusy] = useState(false)

  // The freshly minted secret, held until dismissed. Never refetched.
  const [issued, setIssued] = useState<(IssuedSecret & { handle: string }) | null>(null)

  const [newHandle, setNewHandle] = useState('')
  const [newRole, setNewRole] = useState<Role>('writer')
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)

  const fail = useCallback(
    (e: unknown, fallback: string) => app.toast(e instanceof ApiError ? e.message : fallback),
    [app.toast],
  )

  const refresh = useCallback(async () => {
    try {
      setUsers(await accessApi.users())
    } catch (e) {
      fail(e, 'Failed to load users')
    }
  }, [fail])

  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch on project switch/write
  useEffect(() => {
    void refresh()
  }, [refresh, app.rev])

  const loadKeys = async (handle: string) => {
    if (expanded === handle) {
      setExpanded(null)
      return
    }
    setExpanded(handle)
    try {
      setKeys((k) => ({ ...k, [handle]: [] }))
      const list = await accessApi.keys(handle)
      setKeys((k) => ({ ...k, [handle]: list }))
    } catch (e) {
      fail(e, 'Failed to load keys')
    }
  }

  const addUser = async () => {
    const handle = newHandle.trim()
    if (!handle) return
    setBusy(true)
    try {
      const res = await accessApi.createUser({ handle, role: newRole })
      setIssued({ ...res, handle })
      setNewHandle('')
      await refresh()
    } catch (e) {
      fail(e, 'Could not create the user')
    } finally {
      setBusy(false)
    }
  }

  const changeRole = async (handle: string, role: Role) => {
    try {
      await accessApi.updateUser(handle, { role })
      await refresh()
      app.toast(`${handle} is now ${role}`)
    } catch (e) {
      fail(e, 'Could not change the role')
    }
  }

  const toggleStatus = async (user: User) => {
    const status = user.status === 'active' ? 'disabled' : 'active'
    try {
      await accessApi.updateUser(user.handle, { status })
      await refresh()
    } catch (e) {
      fail(e, 'Could not change the status')
    }
  }

  const removeUser = async (handle: string) => {
    if (pendingDelete !== handle) {
      setPendingDelete(handle)
      return
    }
    setPendingDelete(null)
    try {
      await accessApi.deleteUser(handle)
      await refresh()
      app.toast(`Removed ${handle}`)
    } catch (e) {
      fail(e, 'Could not remove the user')
    }
  }

  const issueKey = async (handle: string) => {
    try {
      const res = await accessApi.issueKey(handle)
      setIssued({ ...res, handle })
      if (expanded === handle) setKeys((k) => ({ ...k, [handle]: [] }))
      await loadKeysSilently(handle)
    } catch (e) {
      fail(e, 'Could not issue a key')
    }
  }

  const loadKeysSilently = async (handle: string) => {
    try {
      const list = await accessApi.keys(handle)
      setKeys((k) => ({ ...k, [handle]: list }))
    } catch {
      /* the listing is refreshed on the next expand */
    }
  }

  const revoke = async (handle: string, id: string) => {
    try {
      await accessApi.revokeKey(id)
      await loadKeysSilently(handle)
      app.toast('Key revoked')
    } catch (e) {
      fail(e, 'Could not revoke the key')
    }
  }

  const openLog = async () => {
    setShowLog((s) => !s)
    if (showLog) return
    try {
      setLog(await accessApi.log({ limit: 40 }))
    } catch (e) {
      fail(e, 'Failed to load the access log')
    }
  }

  const copy = (text: string, what: string) => {
    void navigator.clipboard?.writeText(text).then(
      () => app.toast(`${what} copied`),
      () => app.toast('Could not copy — select the text instead'),
    )
  }

  return (
    <>
      <h2 style={sx("font:600 19px 'Spectral',serif;color:var(--ink);margin:38px 0 4px;")}>
        Users &amp; access
      </h2>
      <p style={sx("font:400 13.5px/1.6 'IBM Plex Sans';color:var(--muted);margin:0 0 6px;")}>
        Roles are enforced by every bctx surface — this UI, the CLI, and the MCP server. They are
        not a barrier against someone using the raw database token directly, so only hand that token
        to people you would trust with full access.
      </p>

      {issued && <SecretPanel issued={issued} onCopy={copy} onDismiss={() => setIssued(null)} />}

      {/* ── add ─────────────────────────────────────────────────────────── */}
      <label style={sx(label)}>Add a user</label>
      <div style={sx('display:flex;gap:8px;align-items:center;')}>
        <input
          style={sx(`${input}flex:1;`)}
          placeholder="handle"
          value={newHandle}
          spellCheck={false}
          onChange={(e) => setNewHandle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !busy) void addUser()
          }}
        />
        <select
          style={sx(`${input}width:auto;cursor:pointer;`)}
          value={newRole}
          onChange={(e) => setNewRole(e.target.value as Role)}
        >
          {ROLE_OPTIONS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <Hov
          base={sx(btn(true))}
          hover={sx('filter:brightness(1.06);')}
          onClick={() => {
            if (!busy) void addUser()
          }}
        >
          {busy ? 'Adding…' : 'Add'}
        </Hov>
      </div>
      <p style={sx("font:400 12px 'IBM Plex Sans';color:var(--muted);margin:6px 0 0;")}>
        {newRole}: {ROLE_HINT[newRole]}
      </p>

      {/* ── list ────────────────────────────────────────────────────────── */}
      <label style={sx(label)}>Users</label>
      {users === null ? (
        <div style={sx("font:400 13px 'IBM Plex Sans';color:var(--muted);")}>Loading…</div>
      ) : users.length === 0 ? (
        <div style={sx("font:400 13px 'IBM Plex Sans';color:var(--muted);")}>No users yet.</div>
      ) : (
        <div style={sx('border:1px solid var(--border);border-radius:10px;overflow:hidden;')}>
          {users.map((u, i) => (
            <div
              key={u.id}
              style={sx(
                `padding:11px 13px;${i > 0 ? 'border-top:1px solid var(--border);' : ''}background:var(--surface);`,
              )}
            >
              <div style={sx('display:flex;align-items:center;gap:9px;')}>
                <span style={sx("font:600 13.5px 'IBM Plex Sans';color:var(--ink);")}>
                  {u.handle}
                </span>
                {u.handle === app.auth?.identity?.handle && <span style={sx(chip)}>you</span>}
                {u.status === 'disabled' && (
                  <span style={sx(`${chip}color:#d0554a;border-color:#d0554a;`)}>disabled</span>
                )}
                <span style={sx('flex:1;')} />
                <select
                  style={sx(`${input}width:auto;padding:4px 8px;cursor:pointer;`)}
                  value={u.role}
                  onChange={(e) => void changeRole(u.handle, e.target.value as Role)}
                >
                  {ROLE_OPTIONS.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
                <Action onClick={() => void loadKeys(u.handle)}>
                  {expanded === u.handle ? 'Hide keys' : 'Keys'}
                </Action>
                <Action onClick={() => void toggleStatus(u)}>
                  {u.status === 'active' ? 'Disable' : 'Enable'}
                </Action>
                <Action danger onClick={() => void removeUser(u.handle)}>
                  {pendingDelete === u.handle ? 'Confirm?' : 'Remove'}
                </Action>
              </div>

              {expanded === u.handle && (
                <div style={sx('margin:10px 0 2px;padding-left:2px;')}>
                  {(keys[u.handle] ?? []).length === 0 ? (
                    <div style={sx("font:400 12.5px 'IBM Plex Mono';color:var(--muted);")}>
                      No keys.
                    </div>
                  ) : (
                    (keys[u.handle] ?? []).map((k) => (
                      <div
                        key={k.id}
                        style={sx(
                          "display:flex;align-items:center;gap:9px;font:400 12.5px 'IBM Plex Mono';color:var(--muted);padding:3px 0;",
                        )}
                      >
                        <span>{k.prefix}…</span>
                        <span>{k.revokedAt ? 'revoked' : k.active ? 'active' : 'expired'}</span>
                        <span>{k.lastUsedAt ? `used ${k.lastUsedAt.slice(0, 10)}` : 'unused'}</span>
                        <span style={sx('flex:1;')} />
                        {!k.revokedAt && (
                          <Action danger onClick={() => void revoke(u.handle, k.id)}>
                            Revoke
                          </Action>
                        )}
                      </div>
                    ))
                  )}
                  <Action onClick={() => void issueKey(u.handle)}>Issue a new key</Action>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── audit ───────────────────────────────────────────────────────── */}
      <div style={sx('margin:18px 0 0;')}>
        <Hov base={sx(btn(false))} hover={sx('border-color:var(--accent);')} onClick={openLog}>
          {showLog ? 'Hide access log' : 'Show access log'}
        </Hov>
      </div>
      {showLog && (
        <div style={sx('margin:12px 0 0;')}>
          {log.length === 0 ? (
            <div style={sx("font:400 13px 'IBM Plex Sans';color:var(--muted);")}>
              Nothing logged yet. Denials are always recorded; allowed reads are not.
            </div>
          ) : (
            log.map((e) => (
              <div
                key={e.id}
                style={sx(
                  `display:flex;gap:10px;font:400 12px 'IBM Plex Mono';padding:3px 0;color:${e.decision === 'deny' ? '#d0554a' : 'var(--muted)'};`,
                )}
              >
                <span>{e.at.slice(0, 19).replace('T', ' ')}</span>
                <span>{e.decision === 'deny' ? 'DENY' : 'allow'}</span>
                <span>{e.handle ?? '—'}</span>
                <span>{e.surface}</span>
                <span>{e.action}</span>
              </div>
            ))
          )}
        </div>
      )}
    </>
  )
}

function Action({
  children,
  onClick,
  danger,
}: {
  children: React.ReactNode
  onClick: () => void
  danger?: boolean
}) {
  return (
    <Hov
      base={sx(
        `padding:3px 9px;border-radius:6px;cursor:pointer;font:500 12px 'IBM Plex Sans';color:${danger ? '#d0554a' : 'var(--ink-soft)'};border:1px solid var(--border);background:transparent;`,
      )}
      hover={sx(`border-color:${danger ? '#d0554a' : 'var(--accent)'};`)}
      onClick={onClick}
    >
      {children}
    </Hov>
  )
}

/** The only place a raw key is ever visible. Dismissing it loses the secret for good. */
function SecretPanel({
  issued,
  onCopy,
  onDismiss,
}: {
  issued: IssuedSecret & { handle: string }
  onCopy: (text: string, what: string) => void
  onDismiss: () => void
}) {
  return (
    <div
      style={sx(
        'margin:14px 0 4px;padding:14px;border:1px solid var(--accent);border-radius:10px;background:var(--accent-soft);',
      )}
    >
      <div style={sx("font:600 13px 'IBM Plex Sans';color:var(--ink);margin:0 0 6px;")}>
        Credentials for “{issued.handle}” — shown once
      </div>

      {issued.joinCode ? (
        <>
          <div style={sx("font:400 12px 'IBM Plex Sans';color:var(--ink-soft);margin:0 0 4px;")}>
            Join code — they run <code>bctx project join &lt;code&gt;</code>
          </div>
          <Secret
            value={issued.joinCode}
            onCopy={() => onCopy(issued.joinCode as string, 'Join code')}
          />
        </>
      ) : (
        <div style={sx("font:400 12px 'IBM Plex Sans';color:var(--ink-soft);margin:0 0 4px;")}>
          This project has no remote, so there is no join code — hand over the key itself.
        </div>
      )}

      <div style={sx("font:400 12px 'IBM Plex Sans';color:var(--ink-soft);margin:10px 0 4px;")}>
        Raw key
      </div>
      <Secret value={issued.key} onCopy={() => onCopy(issued.key, 'Key')} />

      <div
        style={sx(
          "font:400 12px/1.55 'IBM Plex Sans';color:var(--ink-soft);margin:10px 0 0;white-space:pre-wrap;",
        )}
      >
        {issued.warning}
      </div>

      <Hov
        base={sx(`${btn(false)}margin:12px 0 0;display:inline-block;`)}
        hover={sx('border-color:var(--accent);')}
        onClick={onDismiss}
      >
        I have saved it
      </Hov>
    </div>
  )
}

function Secret({ value, onCopy }: { value: string; onCopy: () => void }) {
  return (
    <div style={sx('display:flex;gap:8px;align-items:stretch;')}>
      <input
        readOnly
        value={value}
        onFocus={(e) => e.currentTarget.select()}
        style={sx(`${input}flex:1;font-size:12px;`)}
      />
      <Hov base={sx(btn(false))} hover={sx('border-color:var(--accent);')} onClick={onCopy}>
        Copy
      </Hov>
    </div>
  )
}
