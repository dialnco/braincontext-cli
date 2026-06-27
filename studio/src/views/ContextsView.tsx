import { useCallback, useRef, useState } from 'react'
import { contextsApi } from '../api/contexts'
import { type Context, KINDS, type Kind, SCOPES, type Scope } from '../api/types'
import { ExportPreview } from '../components/contexts/ExportPreview'
import { ProjectSwitcher } from '../components/layout/ProjectSwitcher'
import { TopBar } from '../components/layout/TopBar'
import { Hov, sx } from '../lib/dc'
import { useApp } from '../state/StoreContext'
import { useAsync } from '../state/useAsync'
import { useAutosave } from '../state/useAutosave'

const KIND_DOT: Record<string, string> = {
  rule: '#6a7cff',
  note: '#5fb3a3',
  snippet: '#c98a6a',
  decision: '#b07bd1',
  skill: '#cf7d9e',
}

export function ContextsView({ onNav }: { onNav: (v: 'wiki' | 'contexts') => void }) {
  const app = useApp()
  const [kind, setKind] = useState<Kind | ''>('')
  const [scope, setScope] = useState<Scope | ''>('')
  const [q, setQ] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [projectsOpen, setProjectsOpen] = useState(false)
  const [showExport, setShowExport] = useState(false)
  const [localRev, setLocalRev] = useState(0)

  const projectKey = app.project?.project ?? ''
  const listState = useAsync(
    () =>
      contextsApi.list({
        kind: kind || undefined,
        scope: scope || undefined,
        q: q || undefined,
        limit: 500,
      }),
    [kind, scope, q, app.rev, localRev, projectKey],
  )
  const list = listState.data ?? []

  const detail = useAsync<Context | null>(
    () => (selectedId ? contextsApi.get(selectedId).catch(() => null) : Promise.resolve(null)),
    [selectedId, app.rev, localRev],
  )

  const onCreate = useCallback(async () => {
    try {
      const created = await contextsApi.create({
        body: 'New context — edit me.',
        kind: 'note',
        title: 'Untitled',
      })
      setLocalRev((r) => r + 1)
      setSelectedId(created.id)
      setShowExport(false)
    } catch (e) {
      app.toast(e instanceof Error ? e.message : 'Create failed')
    }
  }, [app])

  const onDelete = useCallback(
    async (id: string) => {
      try {
        await contextsApi.remove(id)
        setSelectedId((s) => (s === id ? null : s))
        setLocalRev((r) => r + 1)
        app.toast('Deleted')
      } catch (e) {
        app.toast(e instanceof Error ? e.message : 'Delete failed')
      }
    },
    [app],
  )

  return (
    <>
      <TopBar
        project={app.project}
        onOpenProjects={() => setProjectsOpen((o) => !o)}
        onSync={app.syncProject}
        view="contexts"
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
        {/* List + filters */}
        <div
          className="scroll"
          style={sx(
            'width:340px;flex:0 0 340px;background:var(--panel);border-right:1px solid var(--border);overflow-y:auto;display:flex;flex-direction:column;',
          )}
        >
          <div
            style={sx(
              'padding:12px 12px 10px;display:flex;flex-direction:column;gap:8px;border-bottom:1px solid var(--border);',
            )}
          >
            <div style={sx('display:flex;align-items:center;justify-content:space-between;')}>
              <span
                style={sx(
                  "font:600 11px 'IBM Plex Mono';letter-spacing:.1em;text-transform:uppercase;color:var(--muted);",
                )}
              >
                Contexts
              </span>
              <div style={sx('display:flex;align-items:center;gap:4px;')}>
                <Hov
                  as="span"
                  base={sx(
                    `height:22px;padding:0 8px;border-radius:6px;display:flex;align-items:center;cursor:pointer;font:500 10px 'IBM Plex Mono';letter-spacing:.04em;${showExport ? 'background:var(--accent-soft);color:var(--accent-ink);' : 'color:var(--muted);'}`,
                  )}
                  hover={sx('background:var(--accent-soft);color:var(--accent-ink);')}
                  onClick={() => setShowExport((s) => !s)}
                  title="Preview AGENTS.md / CLAUDE.md export"
                >
                  Export
                </Hov>
                <Hov
                  as="span"
                  base={sx(
                    "width:22px;height:22px;border-radius:6px;display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--muted);font:300 18px/1 'IBM Plex Sans';",
                  )}
                  hover={sx('background:var(--accent-soft);color:var(--accent-ink);')}
                  onClick={onCreate}
                  title="New context"
                >
                  +
                </Hov>
              </div>
            </div>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search…"
              style={sx(
                "height:30px;padding:0 10px;background:var(--surface);border:1px solid var(--border);border-radius:7px;outline:none;font:400 13px 'IBM Plex Sans';color:var(--ink);",
              )}
            />
            <div style={sx('display:flex;gap:6px;')}>
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value as Kind | '')}
                style={selectSx}
              >
                <option value="">all kinds</option>
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
              <select
                value={scope}
                onChange={(e) => setScope(e.target.value as Scope | '')}
                style={selectSx}
              >
                <option value="">all scopes</option>
                {SCOPES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {list.length === 0 && (
            <div
              style={sx(
                "padding:18px 14px;font:400 13px/1.5 'Spectral',serif;color:var(--muted);font-style:italic;",
              )}
            >
              {listState.loading ? 'Loading…' : 'No contexts. Press + to add one.'}
            </div>
          )}
          {list.map((c) => (
            <Hov
              key={c.id}
              base={sx(
                `padding:11px 13px;border-bottom:1px solid var(--border);cursor:pointer;${c.id === selectedId ? 'background:var(--accent-soft);' : ''}`,
              )}
              hover={sx('background:var(--accent-soft);')}
              onClick={() => {
                setSelectedId(c.id)
                setShowExport(false)
              }}
            >
              <div style={sx('display:flex;align-items:center;gap:8px;')}>
                <span
                  style={sx(
                    `width:7px;height:7px;border-radius:50%;flex:0 0 7px;background:${KIND_DOT[c.kind] ?? 'var(--muted)'};`,
                  )}
                />
                <span
                  style={sx(
                    "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:500 13.5px 'IBM Plex Sans';color:var(--ink);",
                  )}
                >
                  {c.title || firstLine(c.body)}
                </span>
                <span style={sx("font:400 10px 'IBM Plex Mono';color:var(--muted);")}>
                  {c.kind}
                </span>
              </div>
              <div
                style={sx(
                  "font:400 12px/1.5 'Spectral',serif;color:var(--muted);margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
                )}
              >
                {firstLine(c.body)}
              </div>
            </Hov>
          ))}
        </div>

        {/* Detail editor */}
        <div
          style={sx('flex:1;min-width:0;background:var(--surface);overflow-y:auto;')}
          className="scroll"
        >
          {showExport ? (
            <ExportPreview refreshKey={localRev} />
          ) : detail.data ? (
            <ContextEditor
              key={detail.data.id}
              ctx={detail.data}
              onSaved={() => setLocalRev((r) => r + 1)}
              onDelete={() => onDelete(detail.data!.id)}
              toast={app.toast}
            />
          ) : (
            <div
              style={sx(
                "height:100%;display:flex;align-items:center;justify-content:center;font:400 16px 'Spectral',serif;font-style:italic;color:var(--muted);",
              )}
            >
              Select a context to edit, or create one.
            </div>
          )}
        </div>
      </div>

      {projectsOpen && (
        <ProjectSwitcher
          projects={app.projects}
          onSwitch={app.switchProject}
          onClose={() => setProjectsOpen(false)}
        />
      )}
    </>
  )
}

const selectSx = {
  flex: 1,
  height: 30,
  padding: '0 8px',
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 7,
  outline: 'none',
  font: "400 12px 'IBM Plex Sans'",
  color: 'var(--ink-soft)',
} as const

function ContextEditor({
  ctx,
  onSaved,
  onDelete,
  toast,
}: {
  ctx: Context
  onSaved: () => void
  onDelete: () => void
  toast: (m: string) => void
}) {
  const [title, setTitle] = useState(ctx.title ?? '')
  const [body, setBody] = useState(ctx.body)
  const [tags, setTags] = useState(ctx.tags.join(', '))
  const savedRef = useRef({ title: ctx.title ?? '', tags: ctx.tags.join(', ') })

  const autosave = useAutosave(async (value: string) => {
    await contextsApi.update(ctx.id, { body: value })
    onSaved()
  })

  const saveMeta = useCallback(async () => {
    const nextTags = tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
    const prevTags = savedRef.current.tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
    const addTags = nextTags.filter((t) => !prevTags.includes(t))
    const removeTags = prevTags.filter((t) => !nextTags.includes(t))
    const patch: Record<string, unknown> = {}
    if (title !== savedRef.current.title) patch.title = title || null
    if (addTags.length) patch.addTags = addTags
    if (removeTags.length) patch.removeTags = removeTags
    if (Object.keys(patch).length === 0) return
    try {
      await contextsApi.update(ctx.id, patch)
      savedRef.current = { title, tags }
      onSaved()
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Save failed')
    }
  }, [title, tags, ctx.id, onSaved, toast])

  return (
    <div style={sx('max-width:760px;margin:0 auto;padding:30px 48px 80px;')}>
      <div style={sx('display:flex;align-items:center;gap:10px;margin-bottom:14px;')}>
        <span
          style={sx(
            "font:500 11px 'IBM Plex Mono';color:var(--accent-ink);background:var(--accent-soft);border-radius:6px;padding:2px 9px;",
          )}
        >
          {ctx.kind}
        </span>
        <span
          style={sx(
            "font:500 11px 'IBM Plex Mono';color:var(--muted);background:var(--code-bg);border:1px solid var(--border);border-radius:6px;padding:2px 9px;",
          )}
        >
          {ctx.scope}
        </span>
        <span style={sx('flex:1;')} />
        <Hov
          as="button"
          base={sx(
            "font:500 11px 'IBM Plex Mono';color:#b4533f;background:transparent;border:1px solid var(--border);border-radius:7px;padding:4px 11px;cursor:pointer;",
          )}
          hover={sx('border-color:#b4533f;')}
          onClick={onDelete}
        >
          Delete
        </Hov>
      </div>
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={saveMeta}
        placeholder="Title"
        style={sx(
          "width:100%;border:none;background:transparent;outline:none;font:600 28px/1.2 'Spectral',serif;color:var(--ink);margin-bottom:10px;",
        )}
      />
      <input
        value={tags}
        onChange={(e) => setTags(e.target.value)}
        onBlur={saveMeta}
        placeholder="tags, comma, separated"
        style={sx(
          "width:100%;border:none;background:transparent;outline:none;font:400 13px 'IBM Plex Mono';color:var(--accent-ink);margin-bottom:16px;",
        )}
      />
      <div style={sx('height:1px;background:var(--border);margin-bottom:18px;')} />
      <textarea
        value={body}
        onChange={(e) => {
          setBody(e.target.value)
          autosave.schedule(e.target.value)
        }}
        onBlur={() => void autosave.flush()}
        spellCheck={false}
        style={sx(
          "width:100%;min-height:420px;border:none;background:transparent;outline:none;resize:vertical;font:400 15px/1.7 'IBM Plex Mono',monospace;color:var(--ink-soft);",
        )}
      />
      <div style={sx("margin-top:10px;font:400 11px 'IBM Plex Mono';color:var(--muted);")}>
        {autosave.status === 'saving'
          ? 'Saving…'
          : autosave.status === 'dirty'
            ? 'Unsaved'
            : 'Saved'}{' '}
        · updated {ctx.updatedAt.slice(0, 10)}
      </div>
    </div>
  )
}

function firstLine(body: string): string {
  const line = body.split('\n').find((l) => l.trim()) ?? ''
  const clean = line.replace(/[#>*`_]/g, '').trim()
  return clean.length > 80 ? `${clean.slice(0, 80)}…` : clean || 'Empty'
}
