import type React from 'react'
import { DARK, LIGHT } from './lib/theme'
import { useRoute } from './state/router'
import { StoreProvider, useApp } from './state/StoreContext'
import { ContextsView } from './views/ContextsView'
import { LoginView } from './views/LoginView'
import { SettingsView } from './views/SettingsView'
import { WikiView } from './views/WikiView'
import './styles/studio.css'

/**
 * Studio root. A theme-variable hero shell that routes (hash) between the wiki
 * workspace and the contexts tab; all data comes from the same-origin /api over
 * the live braincontext store.
 */
function Shell() {
  const app = useApp()
  const route = useRoute()
  const view =
    route.parts[0] === 'contexts' ? 'contexts' : route.parts[0] === 'settings' ? 'settings' : 'wiki'
  const onNav = (v: 'wiki' | 'contexts' | 'settings') =>
    route.navigate(v === 'contexts' ? '/contexts' : v === 'settings' ? '/settings' : '/')

  const vars = {
    ...(app.theme === 'dark' ? DARK : LIGHT),
    width: '100%',
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    position: 'relative',
    background: 'var(--bg)',
    color: 'var(--ink)',
    fontFamily: "'IBM Plex Sans',sans-serif",
  } as React.CSSProperties

  // Access control is on and this browser has no identity: every /api call would
  // 401, so show the one screen that can fix that instead of an empty workspace.
  // `auth === null` is "not asked yet" — render nothing rather than flash a login.
  // `promptLogin` is the deliberate "sign in as someone else" path.
  const locked = (app.auth?.enabled === true && !app.auth.authenticated) || app.promptLogin

  return (
    <div style={{ position: 'fixed', inset: 0, overflow: 'hidden' }}>
      <div style={vars}>
        {locked ? (
          <LoginView message={app.auth?.message} />
        ) : view === 'contexts' ? (
          <ContextsView onNav={onNav} />
        ) : view === 'settings' ? (
          <SettingsView onNav={onNav} />
        ) : (
          <WikiView onNav={onNav} />
        )}
      </div>
    </div>
  )
}

export function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  )
}
