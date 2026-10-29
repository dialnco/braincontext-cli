import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError } from '../api/client'
import {
  INBOX_KINDS,
  type InboxAction,
  type InboxBox,
  type InboxKind,
  type InboxMessage,
  inboxApi,
  OPEN_STATUSES,
  type ThreadSummary,
  type ThreadView,
} from '../api/inbox'
import { wikiApi } from '../api/wiki'
import { ProjectSwitcher } from '../components/layout/ProjectSwitcher'
import { TopBar } from '../components/layout/TopBar'
import { Hov, sx } from '../lib/dc'
import { renderInboxBody } from '../lib/inboxText'
import { relTime } from '../lib/time'
import { pageHref, useRoute, type View } from '../state/router'
import { useApp } from '../state/StoreContext'
import { useAsync } from '../state/useAsync'

const KIND_COLOR: Record<InboxKind, string> = { ask: '#6a7cff', task: '#c98a6a', fyi: '#5fb3a3' }
const STATUS_COLOR: Record<string, string> = {
  open: 'var(--accent)',
  in_progress: '#b07bd1',
  resolved: '#5fb3a3',
  declined: '#c98a6a',
  cancelled: 'var(--muted)',
}
const BOXES: Array<[InboxBox, string]> = [
  ['mine', 'Mine'],
  ['assigned', 'Assigned'],
  ['sent', 'Sent'],
  ['team', 'Team'],
  ['all', 'All'],
]
const STATUS_FILTERS: Array<[string, string]> = [
  ['active', 'Active'],
  ['closed', 'Closed'],
  ['any', 'Any'],
]

const label =
  "font:600 11px 'IBM Plex Mono';letter-spacing:.1em;text-transform:uppercase;color:var(--muted);"
const input =
  "width:100%;box-sizing:border-box;padding:8px 11px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--ink);font:400 13.5px 'IBM Plex Sans';outline:none;"
const btn = (primary: boolean) =>
  `padding:7px 14px;border-radius:8px;cursor:pointer;border:1px solid ${primary ? 'var(--accent)' : 'var(--border)'};background:${primary ? 'var(--accent)' : 'var(--surface)'};color:${primary ? '#fff' : 'var(--ink-soft)'};font:600 12.5px 'IBM Plex Sans';white-space:nowrap;`
const chip = (on: boolean) =>
  `padding:3px 9px;border-radius:6px;cursor:pointer;font:500 12px 'IBM Plex Sans';color:${on ? 'var(--ink)' : 'var(--muted)'};background:${on ? 'var(--accent-soft)' : 'transparent'};`

const VISIBILITY =
  'Visible to every member of this project (and anyone with the database token) — no secrets.'

function who(p: { handle: string; removed: boolean } | null): string {
  if (!p) return '@team'
  return `@${p.handle}${p.removed ? ' (removed)' : ''}`
}

function Pill({ text, color }: { text: string; color: string }) {
  return (
    <span
      style={sx(
        `font:600 10.5px 'IBM Plex Mono';padding:1px 7px;border-radius:5px;border:1px solid ${color};color:${color};white-space:nowrap;`,
      )}
    >
      {text}
    </span>
  )
}

export function InboxView({ onNav }: { onNav: (v: View) => void }) {
  const app = useApp()
  const route = useRoute()
  const [box, setBox] = useState<InboxBox>('mine')
  const [status, setStatus] = useState('active')
  const [composing, setComposing] = useState(false)
  const [projectsOpen, setProjectsOpen] = useState(false)
  const [localRev, setLocalRev] = useState(0)
  const selected = route.parts[1] ? Number(route.parts[1]) : null
  const available = app.inbox.info?.available === true

  const listState = useAsync(
    () => (available ? inboxApi.list({ box, status }) : Promise.resolve([] as ThreadSummary[])),
    [box, status, available, localRev, app.project?.project],
  )
  // Keep the list fresh while the tab is visible.
  const { reload } = listState
  useEffect(() => {
    const id = window.setInterval(() => {
      if (!document.hidden) reload()
    }, 10_000)
    return () => window.clearInterval(id)
  }, [reload])

  // Stable on purpose: it is a dependency of the thread poller, and `app` changes
  // identity on every inbox refresh — depending on it would re-arm the poller in a loop.
  const { refreshInbox } = app
  const changed = useCallback(() => {
    setLocalRev((r) => r + 1)
    refreshInbox()
  }, [refreshInbox])

  const open = (num: number) => {
    setComposing(false)
    route.navigate(`/inbox/${num}`)
  }

  return (
    <>
      <TopBar
        project={app.project}
        onOpenProjects={() => setProjectsOpen((o) => !o)}
        onSync={app.syncProject}
        view="inbox"
        onNav={onNav}
        onOpenPalette={() => {}}
        layout="three"
        setLayout={() => {}}
        graphOpen={false}
        onEditor={() => {}}
        onGraph={() => {}}
        theme={app.theme}
        onToggleTheme={app.toggleTheme}
      />
      <div style={sx('flex:1;min-height:0;display:flex;position:relative;')}>
        <div
          className="scroll"
          style={sx(
            'width:360px;flex:0 0 360px;background:var(--panel);border-right:1px solid var(--border);overflow-y:auto;display:flex;flex-direction:column;',
          )}
        >
          <div
            style={sx(
              'padding:12px 12px 10px;display:flex;flex-direction:column;gap:8px;border-bottom:1px solid var(--border);',
            )}
          >
            <div style={sx('display:flex;align-items:center;justify-content:space-between;')}>
              <span style={sx(label)}>Inbox</span>
              {available && app.can('inbox.write') && (
                <Hov
                  as="span"
                  base={sx(btn(true))}
                  hover={sx('filter:brightness(1.08);')}
                  onClick={() => {
                    setComposing(true)
                    route.navigate('/inbox')
                  }}
                >
                  + New
                </Hov>
              )}
            </div>
            {available && (
              <>
                <div style={sx('display:flex;gap:2px;flex-wrap:wrap;')}>
                  {BOXES.map(([b, text]) => (
                    <div key={b} onClick={() => setBox(b)} style={sx(chip(box === b))}>
                      {text}
                    </div>
                  ))}
                </div>
                <div style={sx('display:flex;gap:2px;')}>
                  {STATUS_FILTERS.map(([s, text]) => (
                    <div key={s} onClick={() => setStatus(s)} style={sx(chip(status === s))}>
                      {text}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
          {!available ? null : listState.loading && !listState.data ? (
            <div style={sx('padding:16px;color:var(--muted);font:400 13px IBM Plex Sans;')}>
              Loading…
            </div>
          ) : (listState.data ?? []).length === 0 ? (
            <div style={sx("padding:16px;color:var(--muted);font:400 13px 'IBM Plex Sans';")}>
              Nothing here.
            </div>
          ) : (
            (listState.data ?? []).map((t) => (
              <ThreadRow key={t.id} t={t} active={t.num === selected} onClick={() => open(t.num)} />
            ))
          )}
        </div>

        <div
          className="scroll"
          style={sx('flex:1;min-width:0;overflow-y:auto;background:var(--bg);')}
        >
          {!app.inbox.info ? null : !available ? (
            <Unavailable steps={app.inbox.info.steps} reason={app.inbox.info.reason} />
          ) : composing ? (
            <Composer
              onCancel={() => setComposing(false)}
              onSent={(t) => {
                changed()
                open(t.num)
              }}
            />
          ) : selected ? (
            <Thread num={selected} onChanged={changed} />
          ) : (
            <div
              style={sx(
                "height:100%;display:flex;align-items:center;justify-content:center;color:var(--muted);font:400 14px 'IBM Plex Sans';",
              )}
            >
              Select a thread, or start a new one.
            </div>
          )}
        </div>
        {projectsOpen && (
          <ProjectSwitcher
            projects={app.projects}
            onSwitch={app.switchProject}
            onClose={() => setProjectsOpen(false)}
          />
        )}
      </div>
    </>
  )
}

function ThreadRow({
  t,
  active,
  onClick,
}: {
  t: ThreadSummary
  active: boolean
  onClick: () => void
}) {
  return (
    <Hov
      data-thread={t.num}
      base={sx(
        `padding:10px 12px;border-bottom:1px solid var(--border);cursor:pointer;display:flex;flex-direction:column;gap:4px;background:${active ? 'var(--accent-soft)' : 'transparent'};`,
      )}
      hover={sx(active ? '' : 'background:var(--surface);')}
      onClick={onClick}
    >
      <div style={sx('display:flex;align-items:center;gap:7px;')}>
        <span
          style={sx(
            `width:7px;height:7px;border-radius:50%;flex:0 0 7px;background:${t.unread ? 'var(--accent)' : 'transparent'};`,
          )}
        />
        <span style={sx("font:500 11.5px 'IBM Plex Mono';color:var(--muted);")}>#{t.num}</span>
        <Pill text={t.kind} color={KIND_COLOR[t.kind]} />
        {t.urgent && <Pill text="urgent" color="#d9534f" />}
        <span style={sx('flex:1;')} />
        <span style={sx(`font:500 11px 'IBM Plex Mono';color:${STATUS_COLOR[t.status]};`)}>
          {t.status.replace('_', ' ')}
        </span>
      </div>
      <div
        style={sx(
          `font:${t.unread ? 600 : 500} 13.5px 'IBM Plex Sans';color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`,
        )}
      >
        {t.title}
      </div>
      <div style={sx("font:400 11.5px 'IBM Plex Sans';color:var(--muted);display:flex;gap:6px;")}>
        <span>
          {who(t.from)} → {who(t.assignee)}
        </span>
        {t.awaiting && <span>· awaiting @{t.awaiting}</span>}
        <span style={sx('margin-left:auto;')}>{relTime(t.updatedAt)}</span>
      </div>
    </Hov>
  )
}

function Unavailable({ steps, reason }: { steps: string | null; reason: string | null }) {
  const head =
    reason === 'local_project'
      ? 'The inbox needs a shared (online) project.'
      : reason === 'access_off'
        ? 'The inbox needs access control: members are addressed by identity.'
        : 'Sign in to use the inbox.'
  return (
    <div style={sx('max-width:640px;margin:48px auto;padding:0 24px;')}>
      <div style={sx("font:600 20px 'Spectral',serif;color:var(--ink);margin-bottom:10px;")}>
        Inbox
      </div>
      <p style={sx("font:400 14px 'IBM Plex Sans';color:var(--ink-soft);line-height:1.6;")}>
        Members — and their agents — leave each other questions, tasks, and heads-ups here. {head}
      </p>
      {steps && (
        <pre
          style={sx(
            "font:400 12.5px 'IBM Plex Mono';background:var(--code-bg);border:1px solid var(--border);border-radius:8px;padding:12px 14px;white-space:pre-wrap;color:var(--ink-soft);",
          )}
        >
          {steps}
        </pre>
      )}
    </div>
  )
}

function Composer({ onCancel, onSent }: { onCancel: () => void; onSent: (t: ThreadView) => void }) {
  const app = useApp()
  const members = useAsync(() => inboxApi.members(), [])
  const [to, setTo] = useState('')
  const [kind, setKind] = useState<InboxKind>('task')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [urgent, setUrgent] = useState(false)
  const [busy, setBusy] = useState(false)

  const send = async () => {
    if (!to || !body.trim()) {
      app.toast('Pick a recipient and write a message.')
      return
    }
    setBusy(true)
    try {
      onSent(await inboxApi.send({ to, body, title: title || undefined, kind, urgent }))
    } catch (e) {
      app.toast(e instanceof ApiError ? e.message : 'Send failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      style={sx(
        'max-width:720px;margin:28px auto;padding:0 24px;display:flex;flex-direction:column;gap:12px;',
      )}
    >
      <div style={sx("font:600 20px 'Spectral',serif;color:var(--ink);")}>New thread</div>
      <div style={sx('display:flex;gap:10px;')}>
        <label style={sx('flex:1;display:flex;flex-direction:column;gap:5px;')}>
          <span style={sx(label)}>To</span>
          <select
            data-field="to"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            style={sx(input)}
          >
            <option value="">Choose…</option>
            <option value="@team">@team — the pool (first to claim takes it)</option>
            {(members.data ?? []).map((m) => (
              <option key={m.handle} value={`@${m.handle}`}>
                @{m.handle}
                {m.displayName ? ` — ${m.displayName}` : ''}
              </option>
            ))}
          </select>
        </label>
        <label style={sx('width:170px;display:flex;flex-direction:column;gap:5px;')}>
          <span style={sx(label)}>Kind</span>
          <select
            data-field="kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as InboxKind)}
            style={sx(input)}
          >
            {INBOX_KINDS.map((k) => (
              <option key={k} value={k}>
                {k === 'ask'
                  ? 'ask — a question'
                  : k === 'task'
                    ? 'task — please do'
                    : 'fyi — no action'}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label style={sx('display:flex;flex-direction:column;gap:5px;')}>
        <span style={sx(label)}>Title (optional — defaults to the first line)</span>
        <input
          data-field="title"
          value={title}
          maxLength={120}
          onChange={(e) => setTitle(e.target.value)}
          style={sx(input)}
        />
      </label>
      <label style={sx('display:flex;flex-direction:column;gap:5px;')}>
        <span style={sx(label)}>Message</span>
        <textarea
          data-field="body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={9}
          placeholder="Markdown-lite: **bold**, `code`, [[Wiki Page]], links."
          style={sx(`${input}resize:vertical;font-family:'IBM Plex Sans';line-height:1.5;`)}
        />
      </label>
      <label
        style={sx(
          "display:flex;align-items:center;gap:8px;font:400 13px 'IBM Plex Sans';color:var(--ink-soft);",
        )}
      >
        <input type="checkbox" checked={urgent} onChange={(e) => setUrgent(e.target.checked)} />{' '}
        Urgent
      </label>
      <div style={sx("font:400 12px 'IBM Plex Sans';color:var(--muted);")}>{VISIBILITY}</div>
      <div style={sx('display:flex;gap:8px;justify-content:flex-end;')}>
        <span style={sx(btn(false))} onClick={onCancel}>
          Cancel
        </span>
        <span
          data-action="send"
          style={sx(`${btn(true)}${busy ? 'opacity:.6;' : ''}`)}
          onClick={busy ? undefined : send}
        >
          Send
        </span>
      </div>
    </div>
  )
}

interface Prompt {
  action: InboxAction
  label: string
  needsNote: boolean
  placeholder: string
  needsTo?: boolean
}

function Thread({ num, onChanged }: { num: number; onChanged: () => void }) {
  const app = useApp()
  const route = useRoute()
  const [view, setView] = useState<ThreadView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reply, setReply] = useState('')
  const [busy, setBusy] = useState(false)
  const [prompt, setPrompt] = useState<Prompt | null>(null)
  const [note, setNote] = useState('')
  const [reassignTo, setReassignTo] = useState('')
  const members = useAsync(() => inboxApi.members(), [])
  const lastSeq = useRef(0)
  const onChangedRef = useRef(onChanged)
  onChangedRef.current = onChanged
  const { refreshInbox } = app

  const load = useCallback(async () => {
    try {
      const v = await inboxApi.get(num)
      if (v.lastSeq !== lastSeq.current) {
        if (lastSeq.current) onChangedRef.current()
        lastSeq.current = v.lastSeq
      }
      setView(v)
      setError(null)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to load thread')
    }
  }, [num])

  useEffect(() => {
    lastSeq.current = 0
    setView(null)
    void load().then(() => refreshInbox())
    const id = window.setInterval(() => {
      if (!document.hidden) void load()
    }, 3000)
    return () => window.clearInterval(id)
  }, [load, refreshInbox])

  const run = async (fn: () => Promise<ThreadView>, done?: string) => {
    setBusy(true)
    try {
      const v = await fn()
      setView(v)
      lastSeq.current = v.lastSeq
      onChanged()
      if (done) app.toast(done)
      return true
    } catch (e) {
      app.toast(e instanceof ApiError ? e.message : 'Failed')
      return false
    } finally {
      setBusy(false)
    }
  }

  // Message bodies hold wikilinks as data attributes; resolve on click.
  const onBodyClick = async (e: React.MouseEvent) => {
    const el = (e.target as HTMLElement).closest('[data-wikilink]') as HTMLElement | null
    if (!el) return
    const title = el.dataset.wikilink ?? ''
    const page = await wikiApi.resolve(title).catch(() => null)
    if (page) route.navigate(pageHref(page.id))
    else app.toast(`No page titled “${title}”`)
  }

  if (error) return <div style={sx('padding:24px;color:var(--muted);')}>{error}</div>
  if (!view) return <div style={sx('padding:24px;color:var(--muted);')}>Loading…</div>

  const me = app.auth?.identity?.handle?.toLowerCase()
  const isAdmin = app.auth?.identity?.role === 'owner' || app.auth?.identity?.role === 'admin'
  const isSender = view.from.handle.toLowerCase() === me && !view.from.removed
  const isAssignee = view.assignee?.handle.toLowerCase() === me
  const isPool = !view.assignee
  const isOpen = OPEN_STATUSES.includes(view.status)
  const canWrite = app.can('inbox.write')
  const canReply = canWrite && (isSender || isAssignee || isPool || isAdmin)

  const actions: Prompt[] = []
  if (canWrite) {
    if (isOpen) {
      if (view.status === 'open' && (isAssignee || isPool))
        actions.push({ action: 'claim', label: 'Claim', needsNote: false, placeholder: '' })
      if (view.status === 'in_progress' && (isAssignee || isAdmin))
        actions.push({ action: 'unclaim', label: 'Unclaim', needsNote: false, placeholder: '' })
      if (isAssignee || isSender || isPool || isAdmin)
        actions.push({
          action: 'resolve',
          label: 'Resolve',
          needsNote: view.kind === 'ask',
          placeholder:
            view.kind === 'ask' ? 'The answer (or reply first)' : 'Resolution note (optional)',
        })
      if (isAssignee)
        actions.push({
          action: 'decline',
          label: 'Decline',
          needsNote: true,
          placeholder: 'Why are you declining?',
        })
      if (isSender || isAssignee || isAdmin)
        actions.push({
          action: 'reassign',
          label: 'Reassign',
          needsNote: false,
          placeholder: 'Note (optional)',
          needsTo: true,
        })
      if (isSender || isAdmin)
        actions.push({
          action: 'cancel',
          label: 'Cancel',
          needsNote: false,
          placeholder: 'Reason (optional)',
        })
    } else if (
      view.status === 'cancelled' ? isSender || isAdmin : isSender || isAssignee || isAdmin
    ) {
      actions.push({
        action: 'reopen',
        label: 'Reopen',
        needsNote: false,
        placeholder: 'Why reopen? (optional)',
      })
    }
  }

  const doAction = async (p: Prompt) => {
    if (
      !p.needsNote &&
      !p.needsTo &&
      p.action !== 'resolve' &&
      p.action !== 'cancel' &&
      p.action !== 'reopen'
    ) {
      await run(() => inboxApi.act(view.num, p.action))
      return
    }
    setNote('')
    setReassignTo('')
    setPrompt(p)
  }

  const confirmPrompt = async () => {
    if (!prompt) return
    const ok = await run(() =>
      inboxApi.act(view.num, prompt.action, {
        note: note.trim() || undefined,
        to: prompt.needsTo ? reassignTo : undefined,
      }),
    )
    if (ok) setPrompt(null)
  }

  return (
    <div
      style={sx(
        'max-width:780px;margin:0 auto;padding:22px 24px 40px;display:flex;flex-direction:column;gap:14px;',
      )}
    >
      <div style={sx('display:flex;flex-direction:column;gap:8px;')}>
        <div style={sx('display:flex;align-items:center;gap:8px;flex-wrap:wrap;')}>
          <span style={sx("font:500 12px 'IBM Plex Mono';color:var(--muted);")}>#{view.num}</span>
          <Pill text={view.kind} color={KIND_COLOR[view.kind]} />
          <Pill
            text={view.status.replace('_', ' ')}
            color={STATUS_COLOR[view.status] ?? 'var(--muted)'}
          />
          {view.urgent && <Pill text="urgent" color="#d9534f" />}
        </div>
        <div
          data-thread-title
          style={sx("font:600 22px 'Spectral',serif;color:var(--ink);line-height:1.3;")}
        >
          {view.title}
        </div>
        <div
          style={sx(
            "font:400 13px 'IBM Plex Sans';color:var(--ink-soft);display:flex;gap:10px;flex-wrap:wrap;",
          )}
        >
          <span>
            {who(view.from)} → {who(view.assignee)}
          </span>
          {view.awaiting && <span>· awaiting @{view.awaiting}</span>}
          {view.status === 'in_progress' && view.claimed && (
            <span>
              · claimed {view.claimed.agent ? `via ${view.claimed.agent}` : ''}{' '}
              {relTime(view.claimed.at)}
            </span>
          )}
          {view.closedBy && !isOpen && (
            <span>
              · {view.status} by @{view.closedBy}
            </span>
          )}
        </div>
        {view.refs.length > 0 && (
          <div style={sx('display:flex;gap:6px;flex-wrap:wrap;')}>
            {view.refs.map((r) => (
              <Hov
                key={r.id}
                as="span"
                base={sx(
                  `${chip(false)}border:1px solid var(--border);font-family:'IBM Plex Mono';font-size:11px;`,
                )}
                hover={sx('border-color:var(--accent);')}
                onClick={() =>
                  r.type === 'page'
                    ? route.navigate(pageHref(r.id))
                    : r.type === 'context'
                      ? route.navigate(`/contexts/${r.id}`)
                      : route.navigate('/settings')
                }
              >
                {r.type}:{r.id.slice(-6)}
              </Hov>
            ))}
          </div>
        )}
        {actions.length > 0 && (
          <div style={sx('display:flex;gap:6px;flex-wrap:wrap;margin-top:4px;')}>
            {actions.map((a) => (
              <span
                key={a.action}
                data-action={a.action}
                style={sx(
                  `${btn(a.action === 'resolve' || a.action === 'claim')}${busy ? 'opacity:.6;' : ''}`,
                )}
                onClick={busy ? undefined : () => void doAction(a)}
              >
                {a.label}
              </span>
            ))}
          </div>
        )}
        {prompt && (
          <div
            style={sx(
              'display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid var(--border);border-radius:10px;background:var(--panel);',
            )}
          >
            <span style={sx(label)}>{prompt.label}</span>
            {prompt.needsTo && (
              <select
                data-field="reassign-to"
                value={reassignTo}
                onChange={(e) => setReassignTo(e.target.value)}
                style={sx(input)}
              >
                <option value="">Choose…</option>
                <option value="@team">@team — back to the pool</option>
                {(members.data ?? []).map((m) => (
                  <option key={m.handle} value={`@${m.handle}`}>
                    @{m.handle}
                  </option>
                ))}
              </select>
            )}
            <input
              data-field="note"
              value={note}
              placeholder={prompt.placeholder}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void confirmPrompt()
              }}
              style={sx(input)}
            />
            <div style={sx('display:flex;gap:8px;justify-content:flex-end;')}>
              <span style={sx(btn(false))} onClick={() => setPrompt(null)}>
                Back
              </span>
              <span
                data-action="confirm"
                style={sx(btn(true))}
                onClick={() => {
                  if (prompt.needsTo && !reassignTo) return app.toast('Choose who to reassign to.')
                  if (prompt.needsNote && !note.trim() && !(prompt.action === 'resolve')) {
                    return app.toast('A note is required.')
                  }
                  void confirmPrompt()
                }}
              >
                {prompt.label}
              </span>
            </div>
          </div>
        )}
      </div>

      <div onClick={onBodyClick} style={sx('display:flex;flex-direction:column;gap:10px;')}>
        {view.messages.map((m) => (
          <MessageItem key={m.id} m={m} />
        ))}
      </div>

      {canReply && (
        <div style={sx('display:flex;flex-direction:column;gap:8px;')}>
          <textarea
            data-field="reply"
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            rows={4}
            placeholder="Reply…"
            style={sx(`${input}resize:vertical;line-height:1.5;`)}
          />
          <div style={sx('display:flex;gap:8px;justify-content:flex-end;align-items:center;')}>
            <span
              style={sx("font:400 11.5px 'IBM Plex Sans';color:var(--muted);margin-right:auto;")}
            >
              {VISIBILITY}
            </span>
            {isOpen && (isAssignee || isSender || isPool || isAdmin) && (
              <span
                data-action="reply-resolve"
                style={sx(btn(false))}
                onClick={async () => {
                  if (!reply.trim() || busy) return
                  if (
                    await run(
                      () => inboxApi.reply(view.num, reply, 'resolve'),
                      'Replied and resolved',
                    )
                  )
                    setReply('')
                }}
              >
                Reply & resolve
              </span>
            )}
            <span
              data-action="reply"
              style={sx(`${btn(true)}${busy ? 'opacity:.6;' : ''}`)}
              onClick={async () => {
                if (!reply.trim() || busy) return
                if (await run(() => inboxApi.reply(view.num, reply))) setReply('')
              }}
            >
              Reply
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

function eventText(m: InboxMessage): string {
  const ev = m.event ?? ''
  const actor = `@${m.author.handle}`
  if (ev.startsWith('reassigned:')) return `${actor} reassigned this to ${ev.slice(11)}`
  return `${actor} ${ev} this`
}

function MessageItem({ m }: { m: InboxMessage }) {
  if (m.type === 'event') {
    return (
      <div
        style={sx(
          "font:400 12.5px 'IBM Plex Sans';color:var(--muted);padding:2px 4px;display:flex;gap:6px;flex-wrap:wrap;",
        )}
      >
        <span>•</span>
        <span>{eventText(m)}</span>
        {m.body && <span style={sx('color:var(--ink-soft);')}>— {m.body}</span>}
        <span style={sx('margin-left:auto;')}>{relTime(m.createdAt)}</span>
      </div>
    )
  }
  return (
    <div
      data-message={m.seq}
      style={sx(
        'border:1px solid var(--border);border-radius:10px;background:var(--surface);padding:11px 14px;',
      )}
    >
      <div
        style={sx(
          "display:flex;gap:8px;align-items:center;font:500 12px 'IBM Plex Sans';color:var(--ink-soft);margin-bottom:6px;",
        )}
      >
        <span style={sx('font-weight:600;color:var(--ink);')}>
          @{m.author.handle}
          {m.author.removed ? ' (removed)' : ''}
        </span>
        <span style={sx("font:400 11px 'IBM Plex Mono';color:var(--muted);")}>
          {m.surface === 'studio' ? 'studio' : m.agentSource ? `via ${m.agentSource}` : m.surface}
        </span>
        <span style={sx("margin-left:auto;font:400 11px 'IBM Plex Mono';color:var(--muted);")}>
          {relTime(m.createdAt)}
        </span>
      </div>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: renderInboxBody escapes every character first and emits only a fixed tag set (lib/inboxText.ts, XSS-tested) */}
      <div className="inbox-body" dangerouslySetInnerHTML={{ __html: renderInboxBody(m.body) }} />
    </div>
  )
}
