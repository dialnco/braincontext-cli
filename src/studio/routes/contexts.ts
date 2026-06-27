import { Hono } from 'hono'
import { z } from 'zod'
import {
  createContext,
  deleteContext,
  getContext,
  listContexts,
  listHistory,
  searchContexts,
  updateContext,
} from '../../core/contexts'
import { KINDS, SCOPES } from '../../core/types'
import { intQuery, readJson, strQuery } from '../http'
import type { StoreProvider } from '../stores'

const createBody = z.object({
  body: z.string().min(1),
  title: z.string().nullable().optional(),
  kind: z.enum(KINDS).optional(),
  scope: z.enum(SCOPES).optional(),
  namespace: z.string().optional(),
  agentSource: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

const updateBody = z.object({
  title: z.string().nullable().optional(),
  body: z.string().optional(),
  addTags: z.array(z.string()).optional(),
  removeTags: z.array(z.string()).optional(),
  setMetadata: z.record(z.string(), z.unknown()).optional(),
  agentSource: z.string().nullable().optional(),
})

/**
 * Plain-context CRUD + search + history. Wiki pages (page_type set) are firewalled
 * out of every by-id surface here — they belong to /api/wiki — mirroring the CLI's
 * `requireContext` guard. Mounted at /api/contexts.
 */
export function contextsRoutes(provider: StoreProvider): Hono {
  const app = new Hono()

  // List or search (q triggers FTS). Default pageScope 'context' excludes wiki pages.
  app.get('/', async (c) => {
    const filters = {
      kind: enumOrUndef(c.req.query('kind'), KINDS),
      scope: enumOrUndef(c.req.query('scope'), SCOPES),
      tag: strQuery(c, 'tag'),
      namespace: strQuery(c, 'namespace'),
      limit: intQuery(c, 'limit'),
    }
    const q = strQuery(c, 'q')
    const rows = q
      ? await searchContexts(provider.db(), q, filters)
      : await listContexts(provider.db(), filters)
    return c.json(rows)
  })

  app.get('/:id', async (c) => {
    const ctx = await getContext(provider.db(), c.req.param('id'))
    if (!ctx || ctx.pageType !== null) return c.json({ error: 'not found' }, 404)
    return c.json(ctx)
  })

  app.get('/:id/history', async (c) => {
    const ctx = await getContext(provider.db(), c.req.param('id'))
    if (!ctx || ctx.pageType !== null) return c.json({ error: 'not found' }, 404)
    return c.json(await listHistory(provider.db(), ctx.id, intQuery(c, 'limit') ?? 50))
  })

  app.post('/', async (c) => {
    const parsed = await readJson(c, createBody)
    if (!parsed.ok) return parsed.res
    const created = await createContext(provider.db(), parsed.data)
    return c.json(created, 201)
  })

  app.patch('/:id', async (c) => {
    const id = c.req.param('id')
    const existing = await getContext(provider.db(), id)
    if (!existing || existing.pageType !== null) return c.json({ error: 'not found' }, 404)
    const parsed = await readJson(c, updateBody)
    if (!parsed.ok) return parsed.res
    const updated = await updateContext(provider.db(), id, parsed.data)
    return updated ? c.json(updated) : c.json({ error: 'not found' }, 404)
  })

  app.delete('/:id', async (c) => {
    const id = c.req.param('id')
    const existing = await getContext(provider.db(), id)
    if (!existing || existing.pageType !== null) return c.json({ error: 'not found' }, 404)
    const hard = c.req.query('hard') === '1' || c.req.query('hard') === 'true'
    const ok = await deleteContext(provider.db(), id, { hard })
    return c.json({ deleted: ok })
  })

  return app
}

function enumOrUndef<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
): T | undefined {
  return raw !== undefined && (allowed as readonly string[]).includes(raw) ? (raw as T) : undefined
}
