import { Hono } from 'hono'
import { z } from 'zod'
import { deleteContext, listHistory, RevConflictError } from '../../core/contexts'
import { renderView } from '../../core/query'
import {
  TableError,
  tableAddColumn,
  tableAddRow,
  tableDeleteColumn,
  tableDeleteRowAt,
  tableRenameColumn,
  tableSetCell,
  tableSetCellAt,
  tableSetColumnAlign,
} from '../../core/tables'
import { AUTHORED_PAGE_TYPES, LINK_TYPES, PAGE_TYPES } from '../../core/types'
import {
  addLink,
  backlinks,
  createPage,
  getPage,
  getPageByTitle,
  lint,
  listLog,
  listPages,
  outboundLinks,
  removeLink,
  searchPages,
  updatePage,
  verifyPage,
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
  ifRev: z.string().optional(),
  agentSource: z.string().optional(),
})

const tableCellBody = z.object({
  tableIndex: z.number().int().nonnegative().optional(),
  caption: z.string().optional(),
  row: z.string(),
  column: z.string(),
  value: z.string(),
  ifRev: z.string().optional(),
})

// Structural table ops for the datatable grid — index-addressed, one splice per op. The
// locator (tableIndex/caption) + ifRev are shared; `op` discriminates the mutation.
const alignSchema = z.enum(['left', 'right', 'center']).nullable()
const tableOpLocator = {
  tableIndex: z.number().int().nonnegative().optional(),
  caption: z.string().optional(),
  ifRev: z.string().optional(),
}
const tableOpBody = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('setCell'),
    row: z.number().int().nonnegative(),
    col: z.number().int().nonnegative(),
    value: z.string(),
    ...tableOpLocator,
  }),
  z.object({ op: z.literal('addRow'), cells: z.array(z.string()).optional(), ...tableOpLocator }),
  z.object({ op: z.literal('deleteRow'), row: z.number().int().nonnegative(), ...tableOpLocator }),
  z.object({
    op: z.literal('addColumn'),
    name: z.string(),
    at: z.number().int().nonnegative().optional(),
    align: alignSchema.optional(),
    ...tableOpLocator,
  }),
  z.object({
    op: z.literal('deleteColumn'),
    col: z.number().int().nonnegative(),
    ...tableOpLocator,
  }),
  z.object({
    op: z.literal('renameColumn'),
    col: z.number().int().nonnegative(),
    name: z.string(),
    ...tableOpLocator,
  }),
  z.object({
    op: z.literal('setAlign'),
    col: z.number().int().nonnegative(),
    align: alignSchema,
    ...tableOpLocator,
  }),
])

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
    if (!page) return c.json({ error: 'not found' }, 404)
    // A `view` page's body is generated: render it live from its saved query so the Studio
    // always shows current data (the editor treats views as read-only, so the rendered body
    // is never PATCHed back). Other page types return their stored body verbatim.
    if (page.pageType === 'view') {
      const body = await renderView(provider.db(), page.metadata)
      return c.json({ ...page, body })
    }
    return c.json(page)
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
      // 409 for the expected conflicts (immutable source; stale-rev compare-and-swap);
      // anything else is a real 500 (don't leak internals or mislabel every failure).
      if (e instanceof RevConflictError) {
        return c.json({ error: 'rev conflict', currentRev: e.currentRev }, 409)
      }
      const msg = (e as Error).message
      if (/immutable/i.test(msg)) return c.json({ error: msg }, 409)
      return c.json({ error: 'update failed' }, 500)
    }
  })

  // Edit ONE table cell (splice via core/tables — lossless + alignment-preserving) instead
  // of serializing the whole contenteditable through the lossy html→markdown path.
  app.post('/pages/:id/table', async (c) => {
    const parsed = await readJson(c, tableCellBody)
    if (!parsed.ok) return parsed.res
    const { tableIndex, caption, row, column, value, ifRev } = parsed.data
    try {
      const updated = await tableSetCell(
        provider.db(),
        c.req.param('id'),
        { tableIndex, caption },
        row,
        column,
        value,
        { ifRev },
      )
      return c.json(updated)
    } catch (e) {
      if (e instanceof RevConflictError) {
        return c.json({ error: 'rev conflict', currentRev: e.currentRev }, 409)
      }
      if (e instanceof TableError) return c.json({ error: e.message }, 400)
      return c.json({ error: 'table edit failed' }, 500)
    }
  })

  // Structural table ops (the datatable grid): index-addressed cell/row/column mutations, one
  // splice per op through core/tables → updatePage. Returns the updated page (carrying a fresh
  // rev the client threads back as ifRev). Default locator = the page's sole table.
  app.post('/pages/:id/table/op', async (c) => {
    const parsed = await readJson(c, tableOpBody)
    if (!parsed.ok) return parsed.res
    const d = parsed.data
    const id = c.req.param('id')
    const loc = { tableIndex: d.tableIndex, caption: d.caption }
    const opts = { ifRev: d.ifRev, agentSource: 'studio' }
    try {
      let updated: Awaited<ReturnType<typeof tableSetCellAt>>
      switch (d.op) {
        case 'setCell':
          updated = await tableSetCellAt(provider.db(), id, loc, d.row, d.col, d.value, opts)
          break
        case 'addRow':
          updated = await tableAddRow(provider.db(), id, loc, d.cells ?? [], opts)
          break
        case 'deleteRow':
          updated = await tableDeleteRowAt(provider.db(), id, loc, d.row, opts)
          break
        case 'addColumn':
          updated = await tableAddColumn(
            provider.db(),
            id,
            loc,
            { name: d.name, at: d.at, align: d.align ?? null },
            opts,
          )
          break
        case 'deleteColumn':
          updated = await tableDeleteColumn(provider.db(), id, loc, d.col, opts)
          break
        case 'renameColumn':
          updated = await tableRenameColumn(provider.db(), id, loc, d.col, d.name, opts)
          break
        case 'setAlign':
          updated = await tableSetColumnAlign(provider.db(), id, loc, d.col, d.align, opts)
          break
      }
      return c.json(updated)
    } catch (e) {
      if (e instanceof RevConflictError) {
        return c.json({ error: 'rev conflict', currentRev: e.currentRev }, 409)
      }
      if (e instanceof TableError) return c.json({ error: e.message }, 400)
      return c.json({ error: 'table op failed' }, 500)
    }
  })

  // Goes through core verifyPage (not a bare metadata PATCH) so the op log records it.
  app.post('/pages/:id/verify', async (c) => {
    try {
      const updated = await verifyPage(provider.db(), c.req.param('id'), { agent: 'studio' })
      return updated ? c.json(updated) : c.json({ error: 'not found' }, 404)
    } catch (e) {
      const msg = (e as Error).message
      if (/immutable/i.test(msg)) return c.json({ error: msg }, 409)
      return c.json({ error: 'verify failed' }, 500)
    }
  })

  app.delete('/pages/:id', async (c) => {
    const page = await getPage(provider.db(), c.req.param('id'))
    if (!page) return c.json({ error: 'not found' }, 404)
    const hard = c.req.query('hard') === '1' || c.req.query('hard') === 'true'
    const ok = await deleteContext(provider.db(), page.id, { hard })
    return c.json({ deleted: ok })
  })

  // Audit trail for a wiki page. Wiki pages are firewalled out of the by-id
  // /api/contexts surfaces, so history needs its own wiki-scoped route.
  app.get('/pages/:id/history', async (c) => {
    const page = await getPage(provider.db(), c.req.param('id'))
    if (!page) return c.json({ error: 'not found' }, 404)
    return c.json(await listHistory(provider.db(), page.id, intQuery(c, 'limit') ?? 50))
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
    c.json(
      await wikiGraph(provider.db(), {
        namespace: strQuery(c, 'namespace'),
        minDegree: intQuery(c, 'minDegree'),
        limit: intQuery(c, 'limit'),
      }),
    ),
  )

  // --- resolution + log ---
  app.get('/resolve', async (c) => {
    const title = strQuery(c, 'title')
    if (!title) return c.json({ error: 'title query required' }, 400)
    const page = await getPageByTitle(provider.db(), title)
    return page ? c.json(page) : c.json(null)
  })

  app.get('/log', async (c) => c.json(await listLog(provider.db(), { limit: intQuery(c, 'tail') })))

  // --- health ---
  app.get('/lint', async (c) =>
    c.json(await lint(provider.db(), { staleDays: intQuery(c, 'staleDays') })),
  )

  return app
}

function enumOrUndef<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
): T | undefined {
  return raw !== undefined && (allowed as readonly string[]).includes(raw) ? (raw as T) : undefined
}
