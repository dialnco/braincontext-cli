import { Hono } from 'hono'
import { z } from 'zod'
import { readJson } from '../http'
import type { StoreProvider } from '../stores'

const switchBody = z.object({ name: z.string().min(1) })

/**
 * Project registry surface for the in-UI switcher. `switch` reopens the store via
 * the {@link StoreProvider} (serialized, single-owner-safe); `sync` forces a replica
 * pull. Mounted at /api → /api/projects, /api/project, /api/project/switch, /sync.
 */
export function projectsRoutes(provider: StoreProvider): Hono {
  const app = new Hono()

  app.get('/projects', (c) => c.json(provider.projects()))
  app.get('/project', (c) => c.json(provider.status()))

  app.post('/project/switch', async (c) => {
    const parsed = await readJson(c, switchBody)
    if (!parsed.ok) return parsed.res
    try {
      return c.json(await provider.switch(parsed.data.name))
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  })

  app.post('/project/sync', async (c) => {
    await provider.sync()
    return c.json(provider.status())
  })

  return app
}
