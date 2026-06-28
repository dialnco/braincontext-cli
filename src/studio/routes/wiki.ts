import { Hono } from 'hono'
import { z } from 'zod'
import { deleteContext } from '../../core/contexts'
import { AUTHORED_PAGE_TYPES, LINK_TYPES, PAGE_TYPES } from '../../core/types'
import {
  addLink,
  backlinks,
  createPage,
  getPage,
  getPageByTitle,
  listLog,
  listPages,
  outboundLinks,
  removeLink,
  searchPages,
  updatePage,
  wikiGraph,
} from '../../core/wiki'
import { intQuery, readJson, strQuery } from '../http'
import type { StoreProvider } from '../stores'

const createPageBody = z.object({
  title: z.string().min(1),
  pageType: z.enum(AUTHORED_PAGE_TYPES),
  body: z.string().optional(),
  namespace: z.string().optional(),
  tags: z.array(z.string()).optional(),
})

const updatePageBody = z.object({
  title: z.string().nullable().optional(),
  body: z.string().optional(),
  addTags: z.array(z.string()).optional(),
  removeTags: z.array(z.string()).optional(),
  setMetadata: z.record(z.string(), z.unknown()).optional(),
})

const linkBody = z.object({
  fromId: z.string().min(1),
  toId: z.string().optional(),
  toTitle: z.string().optional(),
  type: z.enum(LINK_TYPES),
})

const unlinkBody = z.object({
  fromId: z.string().min(1),
  toId: z.string().optional(),
  toTitle: z.string().optional(),
  type: z.enum(LINK_TYPES).optional(),
})

/**
 * The wiki surface: pages (CRUD), the typed-link graph, backlinks, FTS search,
 * title resolution (for [[..]]), and the op log. `updatePage` re-syncs `references`
 * links from the body and rejects edits to immutable `source` pages. Mounted at /api/wiki.
 */
export function wikiRoutes(provider: StoreProvider): Hono {
  const app = new Hono()

  // --- pages ---
  app.get('/pages', async (c) => {
    const opts = {
      pageType: enumOrUndef(c.req.query('type'), PAGE_TYPES),
      namespace: strQuery(c, 'namespace'),
      limit: intQuery(c, 'limit'),
    }
    const q = strQuery(c, 'q')
    const rows = q
      ? await searchPages(provider.db(), q, opts)
      : await listPages(provider.db(), opts)
    return c.json(rows)
  })

  app.get('/pages/:id', async (c) => {
    const page = await getPage(provider.db(), c.req.param('id'))
    return page ? c.json(page) : c.json({ error: 'not found' }, 404)
  })

  app.post('/pages', async (c) => {
    const parsed = await readJson(c, createPageBody)
    if (!parsed.ok) return parsed.res
    const created = await createPage(provider.db(), parsed.data)
    return c.json(created, 201)
  })

  app.patch('/pages/:id', async (c) => {
    const parsed = await readJson(c, updatePageBody)
    if (!parsed.ok) return parsed.res
    try {
      const updated = await updatePage(provider.db(), c.req.param('id'), parsed.data)
      return updated ? c.json(updated) : c.json({ error: 'not found' }, 404)
    } catch (e) {
      const msg = (e as Error).message
      // 409 only for the expected immutable-source conflict; anything else is a real 500
      // (don't leak raw internals or mislabel every failure as a conflict).
      if (/immutable/i.test(msg)) return c.json({ error: msg }, 409)
      return c.json({ error: 'update failed' }, 500)
    }
  })

  app.delete('/pages/:id', async (c) => {
    const page = await getPage(provider.db(), c.req.param('id'))
    if (!page) return c.json({ error: 'not found' }, 404)
    const hard = c.req.query('hard') === '1' || c.req.query('hard') === 'true'
    const ok = await deleteContext(provider.db(), page.id, { hard })
    return c.json({ deleted: ok })
  })

  // --- links / backlinks / graph ---
  app.get('/pages/:id/links', async (c) =>
    c.json(await outboundLinks(provider.db(), c.req.param('id'))),
  )
  app.get('/pages/:id/backlinks', async (c) =>
    c.json(await backlinks(provider.db(), c.req.param('id'))),
  )

  app.post('/links', async (c) => {
    const parsed = await readJson(c, linkBody)
    if (!parsed.ok) return parsed.res
    const { fromId, ...input } = parsed.data
    await addLink(provider.db(), fromId, input)
    return c.json({ ok: true }, 201)
  })

  app.delete('/links', async (c) => {
    const parsed = await readJson(c, unlinkBody)
    if (!parsed.ok) return parsed.res
    const { fromId, ...input } = parsed.data
    await removeLink(provider.db(), fromId, input)
    return c.json({ ok: true })
  })

  app.get('/graph', async (c) =>
    c.json(await wikiGraph(provider.db(), { namespace: strQuery(c, 'namespace') })),
  )

  // --- resolution + log ---
  app.get('/resolve', async (c) => {
    const title = strQuery(c, 'title')
    if (!title) return c.json({ error: 'title query required' }, 400)
    const page = await getPageByTitle(provider.db(), title)
    return page ? c.json(page) : c.json(null)
  })

  app.get('/log', async (c) => c.json(await listLog(provider.db(), { limit: intQuery(c, 'tail') })))

  return app
}

function enumOrUndef<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
): T | undefined {
  return raw !== undefined && (allowed as readonly string[]).includes(raw) ? (raw as T) : undefined
}
