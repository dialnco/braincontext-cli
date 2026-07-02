import type React from 'react'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError, api } from '../api/client'
import { projectsApi } from '../api/projects'
import type { ProjectInfo, ProjectStatus } from '../api/types'
import type { ThemeName } from '../lib/theme'

interface AppState {
  theme: ThemeName
  toggleTheme: () => void
  project: ProjectStatus | null
  projects: ProjectInfo[]
  refreshProjects: () => Promise<void>
  switchProject: (name: string) => Promise<void>
  syncProject: () => Promise<void>
  /**
   * Register the active editor's autosave flush so {@link switchProject} can persist
   * pending edits before the store swaps under it. Pass null on unmount.
   */
  registerFlush: (fn: (() => Promise<void>) | null) => void
  /**
   * Register the active editor's dirty probe so the live-refresh poller pauses while
   * an edit is pending (a refetch mid-edit could clobber typing). Pass null on unmount.
   */
  registerDirty: (fn: (() => boolean) | null) => void
  /** Global revision counter; components key data fetches on it to refetch after writes. */
  rev: number
  bump: () => void
  toast: (message: string) => void
}

const Ctx = createContext<AppState | null>(null)

const THEME_KEY = 'bctx-studio-theme'

function initialTheme(): ThemeName {
  const saved = localStorage.getItem(THEME_KEY)
  return saved === 'dark' ? 'dark' : 'light'
}

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<ThemeName>(initialTheme)
  const [project, setProject] = useState<ProjectStatus | null>(null)
  const [projects, setProjects] = useState<ProjectInfo[]>([])
  const [rev, setRev] = useState(0)
  const [toastMsg, setToastMsg] = useState<string | null>(null)

  const toggleTheme = useCallback(() => {
    setTheme((t) => {
      const next = t === 'light' ? 'dark' : 'light'
      localStorage.setItem(THEME_KEY, next)
      return next
    })
  }, [])

  const flushRef = useRef<(() => Promise<void>) | null>(null)
  const registerFlush = useCallback((fn: (() => Promise<void>) | null) => {
    flushRef.current = fn
  }, [])

  const dirtyRef = useRef<(() => boolean) | null>(null)
  const registerDirty = useCallback((fn: (() => boolean) | null) => {
    dirtyRef.current = fn
  }, [])

  const bump = useCallback(() => setRev((r) => r + 1), [])
  const toast = useCallback((message: string) => {
    setToastMsg(message)
    window.setTimeout(() => setToastMsg((m) => (m === message ? null : m)), 3200)
  }, [])

  const refreshProjects = useCallback(async () => {
    try {
      const [status, list] = await Promise.all([projectsApi.status(), projectsApi.list()])
      setProject(status)
      setProjects(list)
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Failed to load projects')
    }
  }, [toast])

  const switchProject = useCallback(
    async (name: string) => {
      // Persist any pending editor edits before the live store swaps under every handler;
      // never block the switch on a failed flush.
      try {
        await flushRef.current?.()
      } catch {
        /* flush failed — proceed with the switch anyway */
      }
      try {
        const status = await projectsApi.switch(name)
        setProject(status)
        setProjects((ps) => ps.map((p) => ({ ...p, current: p.name === name })))
        bump()
        toast(`Switched to ${name}`)
      } catch (e) {
        toast(e instanceof ApiError ? e.message : 'Switch failed')
      }
    },
    [bump, toast],
  )

  const syncProject = useCallback(async () => {
    try {
      const status = await projectsApi.sync()
      setProject(status)
      bump()
      toast('Synced')
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Sync failed')
    }
  }, [bump, toast])

  useEffect(() => {
    refreshProjects()
  }, [refreshProjects])

  // Live refresh: poll the store's data_version so writes from OTHER connections
  // (agents via MCP, the CLI) show up without a manual reload. Any change means
  // "maybe modified" (the counter is per-connection; magnitude is meaningless).
  // Paused while the tab is hidden and while the editor holds unsaved edits —
  // a refetch mid-edit could clobber typing; the next tick catches up.
  useEffect(() => {
    let last: number | null = null
    let inFlight = false
    const id = window.setInterval(async () => {
      if (document.hidden || inFlight) return
      if (dirtyRef.current?.()) return
      inFlight = true
      try {
        const { dataVersion } = await api.get<{ dataVersion: number }>('/version')
        if (last !== null && dataVersion !== last) bump()
        last = dataVersion
      } catch {
        last = null // server briefly unavailable (e.g. project switch) — rebaseline
      } finally {
        inFlight = false
      }
    }, 2500)
    return () => window.clearInterval(id)
  }, [bump])

  const value = useMemo<AppState>(
    () => ({
      theme,
      toggleTheme,
      project,
      projects,
      refreshProjects,
      switchProject,
      syncProject,
      registerFlush,
      registerDirty,
      rev,
      bump,
      toast,
    }),
    [
      theme,
      toggleTheme,
      project,
      projects,
      refreshProjects,
      switchProject,
      syncProject,
      registerFlush,
      registerDirty,
      rev,
      bump,
      toast,
    ],
  )

  return (
    <Ctx.Provider value={value}>
      {children}
      {toastMsg && <Toast message={toastMsg} />}
    </Ctx.Provider>
  )
}

function Toast({ message }: { message: string }) {
  return (
    <div
      style={{
        position: 'fixed',
        bottom: 20,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 200,
        background: '#211d18',
        color: '#f4efe6',
        font: "500 13px 'IBM Plex Sans',sans-serif",
        padding: '9px 16px',
        borderRadius: 9,
        boxShadow: '0 12px 28px -12px rgba(20,15,5,.7)',
      }}
    >
      {message}
    </div>
  )
}

export function useApp(): AppState {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useApp must be used within StoreProvider')
  return ctx
}
