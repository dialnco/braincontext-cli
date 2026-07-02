import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  Context,
  HistoryEntry,
  LinkView,
  LintReport,
  WikiGraph,
  WikiLogRow,
} from '../api/types'
import { wikiApi } from '../api/wiki'
import { ConfirmDeleteDialog } from '../components/common/ConfirmDeleteDialog'
import { GraphOverlay } from '../components/graph/GraphOverlay'
import { CommandPalette, type PaletteCommand } from '../components/layout/CommandPalette'
import { ProjectSwitcher } from '../components/layout/ProjectSwitcher'
import { Sidebar } from '../components/layout/Sidebar'
import { TopBar } from '../components/layout/TopBar'
import { HealthPanel } from '../components/wiki/HealthPanel'
import { RightPanel } from '../components/wiki/RightPanel'
import { WikiEditor, type WikiEditorHandle } from '../editor/WikiEditor'
import { Hov, sx } from '../lib/dc'
import { freshnessColor, pageFreshness } from '../lib/freshness'
import { pageHref, useRoute } from '../state/router'
import { useApp } from '../state/StoreContext'
import { useAsync } from '../state/useAsync'

type Layout = 'three' | 'focus' | 'dual'

interface Detail {
  page: Context | null
  links: LinkView[]
  backlinks: LinkView[]
  history: HistoryEntry[]
}

export function WikiView({ onNav }: { onNav: (v: 'wiki' | 'contexts') => void }) {
  const app = useApp()
  const route = useRoute()
  const editorRef = useRef<WikiEditorHandle | null>(null)

  const [layout, setLayout] = useState<Layout>('three')
  const [graphOpen, setGraphOpen] = useState(false)
  const [healthOpen, setHealthOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [projectsOpen, setProjectsOpen] = useState(false)
  const [localRev, setLocalRev] = useState(0)
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<Context | null>(null)

  const projectKey = app.project?.project ?? ''
  const pagesState = useAsync(() => wikiApi.list({ limit: 1000 }), [app.rev, projectKey])
  const pages = pagesState.data ?? []

  // The sidebar list (only) is narrowed to the active tag; the full set still feeds
  // link resolution in the editor, right panel, and palette.
  const visiblePages = useMemo(
    () => (tagFilter ? pages.filter((p) => p.tags.includes(tagFilter)) : pages),
    [pages, tagFilter],
  )

  const onContextsRoute = route.parts[0] === 'contexts'
  const routeId = route.parts[0] === 'page' ? route.parts[1] : undefined
  const activeId = routeId ?? pages[0]?.id ?? null

  // Default to the first page when at the wiki root, OR when the routed id is gone (e.g.
  // after a project switch the hash still points at the old project's page → blank pane).
  // Guard against the `/contexts` route so switching tabs doesn't bounce back here.
  useEffect(() => {
    const first = pages[0]
    if (onContextsRoute || !first) return
    if (!routeId || !pages.some((p) => p.id === routeId)) route.navigate(pageHref(first.id))
  }, [onContextsRoute, routeId, pages, route])

  const detail = useAsync<Detail>(async () => {
    if (!activeId) return { page: null, links: [], backlinks: [], history: [] }
    const [page, links, backlinks, history] = await Promise.all([
      wikiApi.get(activeId).catch(() => null),
      wikiApi.links(activeId).catch(() => [] as LinkView[]),
      wikiApi.backlinks(activeId).catch(() => [] as LinkView[]),
      wikiApi.history(activeId, 30).catch(() => [] as HistoryEntry[]),
    ])
    return { page, links, backlinks, history }
  }, [activeId, app.rev, localRev])

  const graphState = useAsync<WikiGraph>(
    () => (graphOpen ? wikiApi.graph() : Promise.resolve({ nodes: [], edges: [] })),
    [graphOpen, app.rev, localRev],
  )

  const lintState = useAsync<LintReport>(() => wikiApi.lint(), [app.rev, localRev, projectKey])
  const logState = useAsync<WikiLogRow[]>(
    () => (healthOpen ? wikiApi.log(100) : Promise.resolve([])),
    [healthOpen, app.rev, localRev, projectKey],
  )
  const findingsByPage = useMemo(() => {
    const map = new Map<string, number>()
    for (const f of lintState.data?.findings ?? []) {
      if (f.pageId) map.set(f.pageId, (map.get(f.pageId) ?? 0) + 1)
    }
    return map
  }, [lintState.data])

  const flushThenNavigate = useCallback(
    async (id: string) => {
      await editorRef.current?.flush()
      setGraphOpen(false)
      setHealthOpen(false)
      route.navigate(pageHref(id))
    },
    [route],
  )

  // A project switch swaps the live store under every handler and remounts the editor;
  // register this editor's flush so switchProject persists pending edits first, no matter
  // where the switch is triggered from (this view's switcher, the palette, etc.).
  useEffect(() => {
    app.registerFlush(() => editorRef.current?.flush() ?? Promise.resolve())
    app.registerDirty(() => editorRef.current?.isDirty() ?? false)
    return () => {
      app.registerFlush(null)
      app.registerDirty(null)
    }
  }, [app.registerFlush, app.registerDirty])

  const createPage = useCallback(
    async (title: string): Promise<Context | null> => {
      try {
        const created = await wikiApi.create({ title, pageType: 'concept' })
        pagesState.reload()
        return created
      } catch (e) {
        app.toast(e instanceof Error ? e.message : 'Create failed')
        return null
      }
    },
    [pagesState, app],
  )

  const onNew = useCallback(async () => {
    let n = 1
    while (pages.find((p) => p.title === `Untitled ${n}`)) n++
    const created = await createPage(`Untitled ${n}`)
    if (created) await flushThenNavigate(created.id)
  }, [pages, createPage, flushThenNavigate])

  const onSave = useCallback(
    async (md: string) => {
      if (!activeId) return
      await wikiApi.update(activeId, { body: md })
      setLocalRev((r) => r + 1)
    },
    [activeId],
  )

  const onDeletePage = useCallback(
    async (id: string, hard: boolean) => {
      try {
        await editorRef.current?.flush() // avoid an in-flight autosave racing the delete
        await wikiApi.remove(id, hard)
        const next = pages.find((p) => p.id !== id)
        pagesState.reload()
        if (id === activeId) route.navigate(next ? pageHref(next.id) : '/')
        setLocalRev((r) => r + 1)
        app.toast('Deleted')
      } catch (e) {
        app.toast(e instanceof Error ? e.message : 'Delete failed')
      }
    },
    [pages, activeId, pagesState, route, app],
  )

  const onVerify = useCallback(async () => {
    if (!activeId) return
    try {
      await wikiApi.verify(activeId)
      setLocalRev((r) => r + 1)
      app.toast('Verified')
    } catch (e) {
      app.toast(e instanceof Error ? e.message : 'Verify failed')
    }
  }, [activeId, app])

  const onLinkMention = useCallback(
    async (mentionId: string) => {
      if (!activeId) return
      try {
        await wikiApi.addLink({ fromId: mentionId, toId: activeId, type: 'relates' })
        setLocalRev((r) => r + 1)
        app.toast('Linked')
      } catch (e) {
        app.toast(e instanceof Error ? e.message : 'Link failed')
      }
    },
    [activeId, app],
  )

  const onAddTag = useCallback(
    async (tag: string) => {
      if (!activeId) return
      try {
        await wikiApi.update(activeId, { addTags: [tag] })
        setLocalRev((r) => r + 1) // reload the detail → RightPanel shows the new tag
        pagesState.reload() // reload the list → sidebar tag counts/filter stay correct
      } catch (e) {
        app.toast(e instanceof Error ? e.message : 'Add tag failed')
      }
    },
    [activeId, pagesState, app],
  )

  const onRemoveTag = useCallback(
    async (tag: string) => {
      if (!activeId) return
      try {
        await wikiApi.update(activeId, { removeTags: [tag] })
        if (tagFilter === tag) setTagFilter(null) // don't leave a filter on a now-absent tag
        setLocalRev((r) => r + 1)
        pagesState.reload()
      } catch (e) {
        app.toast(e instanceof Error ? e.message : 'Remove tag failed')
      }
    },
    [activeId, tagFilter, pagesState, app],
  )

  // Global ⌘K.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        setPaletteOpen((o) => !o)
      } else if (e.key === 'Escape') {
        setProjectsOpen(false)
        setPaletteOpen(false)
        setGraphOpen(false)
        setHealthOpen(false)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const page = detail.data?.page ?? null
  const readOnly = page?.pageType === 'source'
  const commands: PaletteCommand[] = [
    {
      label: 'Toggle theme',
      hint: 'appearance',
      run: () => {
        setPaletteOpen(false)
        app.toggleTheme()
      },
    },
    {
      label: 'Open graph view',
      hint: 'view',
      run: () => {
        setPaletteOpen(false)
        setHealthOpen(false)
        setGraphOpen(true)
      },
    },
    {
      label: 'Open health report',
      hint: 'view',
      run: () => {
        setPaletteOpen(false)
        setGraphOpen(false)
        setHealthOpen(true)
      },
    },
    {
      label: 'New page',
      hint: 'create',
      run: () => {
        setPaletteOpen(false)
        void onNew()
      },
    },
  ]

  return (
    <>
      <TopBar
        project={app.project}
        onOpenProjects={() => setProjectsOpen((o) => !o)}
        onSync={app.syncProject}
        view="wiki"
        onNav={onNav}
        onOpenPalette={() => setPaletteOpen(true)}
        layout={layout}
        setLayout={setLayout}
        graphOpen={graphOpen}
        onEditor={() => {
          setGraphOpen(false)
          setHealthOpen(false)
        }}
        onGraph={() => {
          setHealthOpen(false)
          setGraphOpen(true)
        }}
        healthOpen={healthOpen}
        healthCount={lintState.data?.findings.length ?? null}
        onHealth={() => {
          setGraphOpen(false)
          setHealthOpen(true)
        }}
        theme={app.theme}
        onToggleTheme={app.toggleTheme}
      />

      <div style={sx('flex:1;min-height:0;display:flex;position:relative;')}>
        {layout !== 'focus' && (
          <Sidebar
            pages={visiblePages}
            activeId={activeId}
            edgeCount={countLinks(detail.data)}
            onOpen={flushThenNavigate}
            onNew={onNew}
            tagFilter={tagFilter}
            onClearTag={() => setTagFilter(null)}
            findings={findingsByPage}
          />
        )}

        <div
          style={sx(
            'flex:1;min-width:0;background:var(--surface);display:flex;flex-direction:column;position:relative;',
          )}
        >
          {page ? (
            <div style={sx('flex:1;min-height:0;display:flex;flex-direction:column;')}>
              <div
                style={sx(
                  `max-width:720px;${layout === 'dual' ? '' : 'margin:0 auto;'}width:100%;padding:30px 56px 0;`,
                )}
              >
                <div
                  style={sx(
                    'display:flex;align-items:center;gap:10px;margin-bottom:14px;min-height:24px;',
                  )}
                >
                  <span style={sx("font:400 12px 'IBM Plex Mono';color:var(--muted);")}>
                    {page.pageType} {readOnly ? '· read-only source' : ''}
                  </span>
                  {page.pageType !== 'source' && page.pageType !== 'index' && (
                    <FreshnessBadge page={page} />
                  )}
                  <span style={sx('flex:1;')} />
                  {page.pageType !== 'source' && page.pageType !== 'index' && (
                    <Hov
                      as="button"
                      base={sx(
                        "font:500 11px 'IBM Plex Mono';color:var(--accent-ink);background:transparent;border:1px solid var(--border);border-radius:7px;padding:4px 11px;cursor:pointer;",
                      )}
                      hover={sx('border-color:var(--accent);')}
                      onClick={() => void onVerify()}
                      title="Mark this page's content as just checked against reality"
                    >
                      Verify
                    </Hov>
                  )}
                  <Hov
                    as="button"
                    base={sx(
                      "font:500 11px 'IBM Plex Mono';color:#b4533f;background:transparent;border:1px solid var(--border);border-radius:7px;padding:4px 11px;cursor:pointer;",
                    )}
                    hover={sx('border-color:#b4533f;')}
                    onClick={() => setPendingDelete(page)}
                    title="Delete this page"
                  >
                    Delete
                  </Hov>
                </div>
                <div
                  style={sx(
                    "font:600 33px/1.18 'Spectral',serif;letter-spacing:-.014em;color:var(--ink);",
                  )}
                >
                  {page.title || 'Untitled'}
                </div>
                <div style={sx('height:1px;background:var(--border);margin:18px 0 4px;')} />
              </div>
              <WikiEditor
                key={page.id}
                page={page}
                pages={pages}
                dual={layout === 'dual'}
                readOnly={readOnly}
                onSave={onSave}
                onOpenPage={flushThenNavigate}
                onCreatePage={createPage}
                handleRef={editorRef}
              />
            </div>
          ) : pagesState.error || detail.error ? (
            <div
              style={sx(
                'flex:1;display:flex;flex-direction:column;gap:12px;align-items:center;justify-content:center;',
              )}
            >
              <div
                style={sx(
                  "font:400 15px 'Spectral',serif;font-style:italic;color:#b4533f;max-width:420px;text-align:center;",
                )}
              >
                {pagesState.error ?? detail.error}
              </div>
              <Hov
                as="button"
                base={sx(
                  "font:500 12px 'IBM Plex Mono';color:var(--ink);background:transparent;border:1px solid var(--border);border-radius:7px;padding:5px 13px;cursor:pointer;",
                )}
                hover={sx('border-color:var(--accent-ink);')}
                onClick={() => {
                  pagesState.reload()
                  detail.reload()
                }}
              >
                Retry
              </Hov>
            </div>
          ) : (
            <div
              style={sx(
                "flex:1;display:flex;align-items:center;justify-content:center;font:400 16px 'Spectral',serif;font-style:italic;color:var(--muted);",
              )}
            >
              {pagesState.loading
                ? 'Loading…'
                : 'No page selected. Create one with the + in the sidebar.'}
            </div>
          )}
        </div>

        {layout === 'three' && page && (
          <RightPanel
            page={page}
            pages={pages}
            links={detail.data?.links ?? []}
            backlinks={detail.data?.backlinks ?? []}
            history={detail.data?.history ?? []}
            onOpen={flushThenNavigate}
            onExpandGraph={() => setGraphOpen(true)}
            onLinkMention={onLinkMention}
            tagFilter={tagFilter}
            onTagClick={(t) => setTagFilter((prev) => (prev === t ? null : t))}
            onAddTag={onAddTag}
            onRemoveTag={onRemoveTag}
          />
        )}

        {graphOpen && (
          <GraphOverlay
            graph={graphState.data ?? { nodes: [], edges: [] }}
            activeId={activeId}
            onOpen={flushThenNavigate}
            onClose={() => setGraphOpen(false)}
          />
        )}

        {healthOpen && (
          <HealthPanel
            report={lintState.data ?? null}
            loading={lintState.loading}
            log={logState.data ?? []}
            onOpen={flushThenNavigate}
            onClose={() => setHealthOpen(false)}
          />
        )}
      </div>

      {projectsOpen && (
        <ProjectSwitcher
          projects={app.projects}
          onSwitch={app.switchProject}
          onClose={() => setProjectsOpen(false)}
        />
      )}
      {paletteOpen && (
        <CommandPalette
          pages={pages}
          commands={commands}
          onClose={() => setPaletteOpen(false)}
          onOpen={flushThenNavigate}
          onCreate={(t) => void createPage(t).then((p) => p && flushThenNavigate(p.id))}
        />
      )}
      {pendingDelete && (
        <ConfirmDeleteDialog
          heading="Delete page"
          name={pendingDelete.title || 'Untitled'}
          onConfirm={async (hard) => {
            await onDeletePage(pendingDelete.id, hard)
            setPendingDelete(null)
          }}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </>
  )
}

function countLinks(d: Detail | undefined): number {
  if (!d) return 0
  return d.links.filter((l) => !l.wanted).length
}

function FreshnessBadge({ page }: { page: Context }) {
  const f = pageFreshness(page)
  const label = f.state === 'unverified' ? 'unverified' : `${f.state} · ${f.ageDays}d`
  const title =
    f.state === 'verified'
      ? `Verified ${f.ageDays}d ago${f.verifiedBy ? ` by ${f.verifiedBy}` : ''}`
      : f.state === 'stale'
        ? `Not ${f.verifiedAt ? 're-verified' : 'verified or updated'} in ${f.ageDays} days`
        : 'Never verified'
  return (
    <span
      title={title}
      style={sx(
        `display:inline-flex;align-items:center;gap:5px;font:500 11px 'IBM Plex Mono';color:${freshnessColor(f.state)};`,
      )}
    >
      <span
        style={sx(`width:6px;height:6px;border-radius:50%;background:${freshnessColor(f.state)};`)}
      />
      {label}
    </span>
  )
}
