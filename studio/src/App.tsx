import MarkdownWiki from './wiki/MarkdownWiki'

/**
 * Studio root. Currently renders the Markdown Wiki design 1:1 with in-app mock
 * data (no DB/API). The server's /api endpoints stay available for the next,
 * integration phase, where this UI gets wired to the real store.
 */
export function App() {
  return <MarkdownWiki />
}
