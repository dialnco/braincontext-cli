import { Hono } from 'hono'
import { listTags } from '../../core/contexts'
import type { StoreProvider } from '../stores'

/** All tags with live-context usage counts. Mounted at /api/tags. */
export function tagsRoutes(provider: StoreProvider): Hono {
  const app = new Hono()
  app.get('/', async (c) => c.json(await listTags(provider.db())))
  return app
}
