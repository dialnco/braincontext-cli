import { Hono } from 'hono'
import { previewExport } from '../../export/preview'
import { selectContexts } from '../../export/select'
import { ALL_TARGET_NAMES, ALL_TARGETS, type Target } from '../../export/write'
import { strQuery } from '../http'
import type { StoreProvider } from '../stores'

/**
 * Read-only preview of what `bctx export` would write — AGENTS.md / CLAUDE.md /
 * .cursor/rules/*.mdc — rendered with the canonical managed block and no file I/O.
 * `store` (the round-trippable per-context dir) is intentionally excluded; it isn't
 * an agent file. Mounted at /api/export.
 */
export function exportRoutes(provider: StoreProvider): Hono {
  const app = new Hono()

  app.get('/preview', async (c) => {
    const targets = parseTargets(c.req.query('targets'))
    const items = await selectContexts(provider.db(), { namespace: strQuery(c, 'namespace') })
    return c.json(previewExport(items, targets))
  })

  return app
}

/** Parse `?targets=agents,claude,cursor`; ignore unknown/`store`; default to all agent files. */
function parseTargets(raw: string | undefined): Target[] {
  if (!raw) return ALL_TARGETS
  const got = raw
    .split(',')
    .map((s) => s.trim())
    .filter((t): t is Target => (ALL_TARGET_NAMES as string[]).includes(t) && t !== 'store')
  return got.length ? got : ALL_TARGETS
}
