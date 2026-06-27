import { createRoot } from 'react-dom/client'
import { App } from './App'

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('missing #root element')

// No StrictMode: the wiki editor is an imperative contentEditable surface, and
// StrictMode's intentional double mount/unmount fights its manual DOM management.
createRoot(rootEl).render(<App />)
