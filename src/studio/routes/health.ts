import { Hono } from 'hono'
import { dataVersion } from '../../core/db'
import type { StoreProvider } from '../stores'

/** Liveness probe + store version. Mounted at /api → GET /api/health, /api/version. */
export function healthRoutes(provider: StoreProvider): Hono {
  const app = new Hono()
  app.get('/health', (c) =>
    c.json({ status: 'ok', service: 'bctx-studio', time: new Date().toISOString() }),
  )
  // The SPA polls this to notice writes from other connections (agents / the CLI).
  app.get('/version', async (c) => c.json({ dataVersion: await dataVersion(provider.db()) }))
  return app
}
