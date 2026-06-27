import type React from 'react'
import { DARK, LIGHT } from './lib/theme'
import { useRoute } from './state/router'
import { StoreProvider, useApp } from './state/StoreContext'
import { ContextsView } from './views/ContextsView'
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
  const view = route.parts[0] === 'contexts' ? 'contexts' : 'wiki'
  const onNav = (v: 'wiki' | 'contexts') => route.navigate(v === 'contexts' ? '/contexts' : '/')

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

  return (
    <div style={{ position: 'fixed', inset: 0, overflow: 'hidden' }}>
      <div style={vars}>
        {view === 'contexts' ? <ContextsView onNav={onNav} /> : <WikiView onNav={onNav} />}
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
