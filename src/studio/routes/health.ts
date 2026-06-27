import { Hono } from 'hono'

/** Liveness probe. Mounted at /api → GET /api/health. */
export function healthRoutes(): Hono {
  const app = new Hono()
  app.get('/health', (c) =>
    c.json({ status: 'ok', service: 'bctx-studio', time: new Date().toISOString() }),
  )
  return app
}
