import { useCallback, useEffect, useState } from 'react'
import { ApiError } from '../api/client'
import { type FileMeta, fileContentUrl, filesApi, type StorageStatus } from '../api/files'
import { Icon } from '../components/common/Icon'
import { Hov, sx } from '../lib/dc'
import { useApp } from '../state/StoreContext'
import { AccessSection } from './AccessSection'

const label =
  "display:block;font:600 11px 'IBM Plex Mono';letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:14px 0 5px;"
const input =
  "width:100%;box-sizing:border-box;padding:8px 11px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--ink);font:400 13.5px 'IBM Plex Mono';outline:none;"
const btn = (primary: boolean) =>
  `padding:8px 16px;border-radius:8px;cursor:pointer;border:1px solid ${primary ? 'var(--accent)' : 'var(--border)'};background:${primary ? 'var(--accent)' : 'var(--surface)'};color:${primary ? '#fff' : 'var(--ink-soft)'};font:600 13px 'IBM Plex Sans';`

function human(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** A short, human-friendly type name derived from a MIME string (raw MIME is unreadable). */
function typeLabel(mime: string): string {
  const m = mime.toLowerCase()
  if (m.includes('wordprocessingml') || m === 'application/msword') return 'Word'
  if (m.includes('spreadsheetml') || m === 'application/vnd.ms-excel') return 'Excel'
  if (m.includes('presentationml') || m === 'application/vnd.ms-powerpoint') return 'PowerPoint'
  if (m === 'application/pdf') return 'PDF'
  if (m.startsWith('image/')) return 'Image'
  if (m.startsWith('video/')) return 'Video'
  if (m.startsWith('audio/')) return 'Audio'
  if (m === 'application/zip' || m.includes('compressed')) return 'Zip'
  if (m === 'application/json') return 'JSON'
  if (m.startsWith('text/')) return 'Text'
  // Fallback: the subtype minus vendor noise, capitalized (e.g. octet-stream → Octet-stream).
  const sub = m.split('/')[1] ?? m
  const clean = sub.split(/[.+]/).pop() || sub
  return clean ? clean.charAt(0).toUpperCase() + clean.slice(1) : 'File'
}

/** Calendar-month bucket key (`YYYY-MM`, sortable) + display label (`July 2026`). */
function monthBucket(iso: string): { key: string; label: string } {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return { key: '0000-00', label: 'Unknown date' }
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  return { key, label: d.toLocaleString('en-US', { month: 'long', year: 'numeric' }) }
}

interface FileGroup {
  key: string
  label: string
  items: FileMeta[]
}

/** Bucket files by month or friendly type; files within a group sorted largest-first. */
function groupFiles(files: FileMeta[], groupBy: 'date' | 'type'): FileGroup[] {
  const groups = new Map<string, FileGroup>()
  for (const f of files) {
    const { key, label } =
      groupBy === 'date'
        ? monthBucket(f.createdAt)
        : { key: typeLabel(f.mime), label: typeLabel(f.mime) }
    const g = groups.get(key) ?? { key, label, items: [] }
    g.items.push(f)
    groups.set(key, g)
  }
  const out = [...groups.values()]
  for (const g of out) g.items.sort((a, b) => b.size - a.size)
  if (groupBy === 'date') out.sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0))
  else out.sort((a, b) => b.items.length - a.items.length || a.label.localeCompare(b.label))
  return out
}

/**
 * Who you are on this store, plus a way out. Rendered only when the project has
 * access control on — otherwise there is no identity to show.
 */
function IdentityBadge() {
  const app = useApp()
  const identity = app.auth?.enabled ? app.auth.identity : null
  if (!identity) return null
  return (
    <>
      <span
        style={sx("font:500 12.5px 'IBM Plex Mono';color:var(--muted);")}
        title={`Capabilities: ${identity.capabilities.join(', ')}`}
      >
        {identity.handle} · {identity.role}
      </span>
      <Hov
        base={sx(
          "padding:4px 10px;border-radius:7px;border:1px solid var(--border);background:var(--surface);cursor:pointer;color:var(--ink-soft);font:500 12px 'IBM Plex Sans';",
        )}
        hover={sx('border-color:var(--accent);color:var(--accent-ink);')}
        // An adopted identity comes from the key on this machine, so signing out
        // would just re-adopt it. Offer the thing that actually works instead.
        onClick={() => (app.auth?.adopted ? app.beginSwitchIdentity() : void app.logout())}
        title={
          app.auth?.adopted
            ? "This identity comes from this machine's stored key — sign in to use another"
            : 'Sign out of Studio'
        }
      >
        {app.auth?.adopted ? 'Switch identity' : 'Sign out'}
      </Hov>
    </>
  )
}

/**
 * Store settings (#/settings). Two sections: S3/R2 file storage, and — for anyone
 * who can manage them — users and keys. The storage secret is write-only: it is
 * submitted only when the field is non-empty and is never echoed back by the API.
 */
export function SettingsView({ onNav }: { onNav: (v: 'wiki' | 'contexts' | 'settings') => void }) {
  const app = useApp()
  const [status, setStatus] = useState<StorageStatus | null>(null)
  const [files, setFiles] = useState<FileMeta[]>([])
  const [busy, setBusy] = useState(false)
  /** Two-click delete: first click arms the row, second click deletes. */
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  /** File-list grouping dimension + which group headers are collapsed. */
  const [groupBy, setGroupBy] = useState<'date' | 'type'>('date')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const [endpoint, setEndpoint] = useState('')
  const [region, setRegion] = useState('')
  const [bucket, setBucket] = useState('')
  const [accessKeyId, setAccessKeyId] = useState('')
  const [secret, setSecret] = useState('')
  const [prefix, setPrefix] = useState('')

  const refresh = useCallback(async () => {
    try {
      const s = await filesApi.status()
      setStatus(s)
      setEndpoint(s.endpoint ?? '')
      setRegion(s.region === 'auto' ? '' : (s.region ?? ''))
      setBucket(s.bucket ?? '')
      setPrefix(s.prefix ?? '')
      setFiles(s.configured ? await filesApi.list() : [])
    } catch (e) {
      app.toast(e instanceof ApiError ? e.message : 'Failed to load storage status')
    }
  }, [app.toast])

  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch on project switch/write
  useEffect(() => {
    void refresh()
  }, [refresh, app.rev])

  const save = async () => {
    if (!endpoint || !bucket || !accessKeyId) {
      app.toast('Endpoint, bucket and access key id are required')
      return
    }
    setBusy(true)
    try {
      await filesApi.saveConfig({
        endpoint,
        region: region || undefined,
        bucket,
        accessKeyId,
        // Write-only: only send when the user actually typed a new secret.
        secretAccessKey: secret || undefined,
        prefix,
      })
      setSecret('')
      setAccessKeyId('')
      app.toast('Storage config saved')
      await refresh()
    } catch (e) {
      app.toast(e instanceof ApiError ? e.message : 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  const test = async () => {
    setBusy(true)
    try {
      await filesApi.testConfig()
      app.toast('Connection OK — bucket is reachable')
    } catch (e) {
      app.toast(e instanceof ApiError ? `Connection failed: ${e.message}` : 'Connection failed')
    } finally {
      setBusy(false)
    }
  }

  const removeFile = async (f: FileMeta) => {
    if (pendingDelete !== f.id) {
      setPendingDelete(f.id)
      return
    }
    setPendingDelete(null)
    try {
      await filesApi.remove(f.id)
      app.toast(`Deleted ${f.filename}`)
      setFiles((fs) => fs.filter((x) => x.id !== f.id))
    } catch (e) {
      app.toast(e instanceof ApiError ? e.message : 'Delete failed')
    }
  }

  const toggleGroup = (key: string) =>
    setCollapsed((s) => {
      const n = new Set(s)
      if (n.has(key)) n.delete(key)
      else n.add(key)
      return n
    })

  return (
    <>
      <div
        style={sx(
          'height:50px;flex:0 0 50px;display:flex;align-items:center;gap:12px;padding:0 14px;background:var(--panel);border-bottom:1px solid var(--border);',
        )}
      >
        <Hov
          base={sx(
            "display:flex;align-items:center;gap:7px;cursor:pointer;padding:5px 10px;border-radius:8px;color:var(--ink-soft);font:500 13px 'IBM Plex Sans';",
          )}
          hover={sx('background:var(--accent-soft);color:var(--accent-ink);')}
          onClick={() => onNav('wiki')}
        >
          ← Back to wiki
        </Hov>
        <span style={sx("font:600 15px 'IBM Plex Sans';color:var(--ink);")}>Settings</span>
        <span style={sx('flex:1;')} />
        <IdentityBadge />
        <Hov
          base={sx(
            'width:32px;height:32px;border-radius:8px;border:1px solid var(--border);background:var(--surface);display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--ink-soft);',
          )}
          hover={sx('border-color:var(--accent);color:var(--accent-ink);')}
          onClick={app.toggleTheme}
          title="Toggle theme"
        >
          <Icon name={app.theme === 'dark' ? 'sun' : 'moon'} size={16} />
        </Hov>
      </div>

      <div className="scroll" style={sx('flex:1;overflow-y:auto;')}>
        <div style={sx('max-width:640px;margin:0 auto;padding:28px 24px 60px;')}>
          <h2 style={sx("font:600 19px 'Spectral',serif;color:var(--ink);margin:0 0 4px;")}>
            File storage (S3 / R2)
          </h2>
          <p style={sx("font:400 13.5px/1.6 'IBM Plex Sans';color:var(--muted);margin:0 0 6px;")}>
            Enables image, PDF and file attachments in wiki pages. Blobs go to your bucket; this
            store keeps only metadata. Credentials are stored in this project's database, so every
            device that opens it can use them — prefer a bucket-scoped R2 API token.
          </p>

          <div
            style={sx(
              `display:flex;align-items:center;gap:8px;font:500 12.5px 'IBM Plex Mono';color:${status?.configured ? '#4caf7d' : 'var(--muted)'};margin:10px 0 4px;`,
            )}
          >
            <span
              style={sx(
                `width:8px;height:8px;border-radius:50%;background:${status?.configured ? '#4caf7d' : 'var(--border)'};`,
              )}
            />
            {status?.configured
              ? `Configured — ${status.bucket} (key ${status.accessKeyIdMasked ?? '?'})`
              : 'Not configured'}
          </div>

          <label style={sx(label)}>Endpoint</label>
          <input
            style={sx(input)}
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder="https://<account-id>.r2.cloudflarestorage.com"
          />

          <div style={sx('display:flex;gap:14px;')}>
            <div style={sx('flex:1;')}>
              <label style={sx(label)}>Bucket</label>
              <input
                style={sx(input)}
                value={bucket}
                onChange={(e) => setBucket(e.target.value)}
                placeholder="my-bucket"
              />
            </div>
            <div style={sx('flex:1;')}>
              <label style={sx(label)}>Region</label>
              <input
                style={sx(input)}
                value={region}
                onChange={(e) => setRegion(e.target.value)}
                placeholder="auto"
              />
            </div>
          </div>

          <label style={sx(label)}>Access key id</label>
          <input
            style={sx(input)}
            value={accessKeyId}
            onChange={(e) => setAccessKeyId(e.target.value)}
            placeholder={status?.accessKeyIdMasked ?? ''}
          />

          <label style={sx(label)}>Secret access key</label>
          <input
            style={sx(input)}
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder={status?.configured ? '•••••••• (unchanged)' : ''}
            autoComplete="new-password"
          />

          <label style={sx(label)}>Key prefix (optional)</label>
          <input
            style={sx(input)}
            value={prefix}
            onChange={(e) => setPrefix(e.target.value)}
            placeholder="e.g. braincontext"
          />

          <div style={sx('display:flex;gap:10px;margin-top:20px;')}>
            <button type="button" style={sx(btn(true))} disabled={busy} onClick={save}>
              Save
            </button>
            <button
              type="button"
              style={sx(btn(false))}
              disabled={busy || !status?.configured}
              onClick={test}
            >
              Test connection
            </button>
          </div>

          {status?.configured && (
            <>
              <div
                style={sx(
                  'display:flex;align-items:center;justify-content:space-between;gap:12px;margin:36px 0 8px;',
                )}
              >
                <h3 style={sx("font:600 15px 'Spectral',serif;color:var(--ink);margin:0;")}>
                  Uploaded files ({files.length})
                </h3>
                {files.length > 0 && (
                  <div
                    style={sx(
                      'display:flex;border:1px solid var(--border);border-radius:8px;overflow:hidden;',
                    )}
                  >
                    {(['date', 'type'] as const).map((g) => (
                      <button
                        key={g}
                        type="button"
                        onClick={() => setGroupBy(g)}
                        style={sx(
                          `padding:4px 12px;border:none;cursor:pointer;font:600 11px 'IBM Plex Mono';text-transform:capitalize;${groupBy === g ? 'background:var(--accent);color:#fff;' : 'background:var(--surface);color:var(--ink-soft);'}`,
                        )}
                      >
                        {g}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {files.length === 0 && (
                <p style={sx("font:400 13px 'IBM Plex Sans';color:var(--muted);")}>
                  No files yet. Paste or drop a file into a wiki page, or run `bctx file add`.
                </p>
              )}
              {groupFiles(files, groupBy).map((group) => {
                const open = !collapsed.has(group.key)
                return (
                  <div key={group.key} style={sx('margin-bottom:6px;')}>
                    <Hov
                      base={sx(
                        "display:flex;align-items:center;gap:8px;padding:7px 4px;cursor:pointer;font:600 11px 'IBM Plex Mono';letter-spacing:.04em;text-transform:uppercase;color:var(--muted);border-bottom:1px solid var(--border);",
                      )}
                      hover={sx('color:var(--ink-soft);')}
                      onClick={() => toggleGroup(group.key)}
                    >
                      <span style={sx('width:10px;')}>{open ? '▾' : '▸'}</span>
                      <span>{group.label}</span>
                      <span style={sx('color:var(--border);')}>({group.items.length})</span>
                    </Hov>
                    {open &&
                      group.items.map((f) => (
                        <div
                          key={f.id}
                          style={sx(
                            'display:flex;align-items:center;gap:10px;padding:8px 4px;border-bottom:1px solid var(--border);',
                          )}
                        >
                          <a
                            href={fileContentUrl(f.id, true)}
                            title={`Download — ${f.id}`}
                            style={sx(
                              "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:500 13px 'IBM Plex Sans';color:var(--ink);text-decoration:none;",
                            )}
                          >
                            {f.filename}
                          </a>
                          <span
                            style={sx(
                              "flex:0 0 auto;white-space:nowrap;font:400 11.5px 'IBM Plex Mono';color:var(--muted);",
                            )}
                          >
                            {human(f.size)} · {typeLabel(f.mime)}
                          </span>
                          <Hov
                            as="span"
                            base={sx(
                              `cursor:pointer;font:500 12px 'IBM Plex Sans';color:${pendingDelete === f.id ? '#c0564a' : 'var(--muted)'};padding:3px 8px;border-radius:6px;`,
                            )}
                            hover={sx('background:var(--accent-soft);color:#c0564a;')}
                            onClick={() => removeFile(f)}
                            title={
                              pendingDelete === f.id
                                ? 'Pages embedding it will show a missing-file note'
                                : undefined
                            }
                          >
                            {pendingDelete === f.id ? 'Really delete?' : 'Delete'}
                          </Hov>
                        </div>
                      ))}
                  </div>
                )
              })}
            </>
          )}

          {/* Users & keys — only for an identity that can manage them. The routes
              enforce this too; hiding it just avoids showing a panel that 403s. */}
          {app.can('users.manage') && <AccessSection />}
        </div>
      </div>
    </>
  )
}
