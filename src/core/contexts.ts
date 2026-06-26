import { type Kysely, type Selectable, sql, type Updateable } from 'kysely'
import { ulid } from 'ulidx'
import { withWriteRetry } from './tx'
import type { ContextsTable, Database, Kind, Scope } from './types'

type ContextRow = Selectable<ContextsTable>

/** A context entry as returned to callers (metadata parsed, tags resolved). */
export interface Context {
  id: string
  namespace: string
  title: string | null
  body: string
  kind: Kind
  scope: Scope
  agentSource: string | null
  metadata: Record<string, unknown>
  /** Non-null = this is a wiki page of that type; null = normal context. */
  pageType: string | null
  /** Stable filename slug for wiki pages (null for normal contexts). */
  slug: string | null
  tags: string[]
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

export interface CreateInput {
  body: string
  title?: string | null
  kind?: Kind
  namespace?: string
  scope?: Scope
  agentSource?: string | null
  tags?: string[]
  metadata?: Record<string, unknown>
  pageType?: string | null
  slug?: string | null
  /** Honor a specific id (e.g. re-creating a row from an exported file). */
  id?: string
  /** Preserve provenance timestamps on re-create (default: now). */
  createdAt?: string
  updatedAt?: string
}

export interface ListFilters {
  namespace?: string
  kind?: Kind
  scope?: Scope
  agentSource?: string
  tag?: string
  limit?: number
  includeDeleted?: boolean
  /**
   * Which rows to include by page-ness. Default 'context' excludes wiki pages,
   * so legacy surfaces (list/search/export/MCP) never see them.
   */
  pageScope?: 'context' | 'wiki' | 'all'
}

export interface UpdateInput {
  title?: string | null
  body?: string
  addTags?: string[]
  removeTags?: string[]
  setMetadata?: Record<string, unknown>
  agentSource?: string | null
}

function nowIso(): string {
  return new Date().toISOString()
}

function parseMetadata(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw)
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function toContext(row: ContextRow, tags: string[]): Context {
  return {
    id: row.id,
    namespace: row.namespace,
    title: row.title,
    body: row.body,
    kind: row.kind,
    scope: row.scope,
    agentSource: row.agent_source,
    metadata: parseMetadata(row.metadata),
    pageType: row.page_type,
    slug: row.slug,
    tags,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  }
}

/** Fetch tag names for a set of context ids in one query. */
async function tagsByContext(db: Kysely<Database>, ids: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>()
  if (ids.length === 0) return map
  const rows = await db
    .selectFrom('context_tags as ct')
    .innerJoin('tags as t', 't.id', 'ct.tag_id')
    .select(['ct.context_id as contextId', 't.name as name'])
    .where('ct.context_id', 'in', ids)
    .orderBy('t.name')
    .execute()
  for (const r of rows) {
    const list = map.get(r.contextId) ?? []
    list.push(r.name)
    map.set(r.contextId, list)
  }
  return map
}

/** Insert-or-ignore tag names, returning their ids. */
async function ensureTags(db: Kysely<Database>, names: string[]): Promise<number[]> {
  const unique = [...new Set(names.map((n) => n.trim()).filter(Boolean))]
  if (unique.length === 0) return []
  await db
    .insertInto('tags')
    .values(unique.map((name) => ({ name })))
    .onConflict((oc) => oc.column('name').doNothing())
    .execute()
  const rows = await db.selectFrom('tags').select('id').where('name', 'in', unique).execute()
  return rows.map((r) => r.id)
}

export async function createContext(db: Kysely<Database>, input: CreateInput): Promise<Context> {
  const id = input.id ?? ulid()
  const ts = nowIso()
  const agentSource = input.agentSource ?? null
  const tags = [...new Set((input.tags ?? []).map((t) => t.trim()).filter(Boolean))]
  // Build the stored row once so we can also return it in-memory (no read-back —
  // a replica's local file may not have the just-written frames yet).
  const row: ContextRow = {
    id,
    namespace: input.namespace ?? 'global',
    title: input.title ?? null,
    body: input.body,
    kind: input.kind ?? 'note',
    scope: input.scope ?? 'project',
    agent_source: agentSource,
    metadata: JSON.stringify(input.metadata ?? {}),
    page_type: input.pageType ?? null,
    slug: input.slug ?? null,
    created_at: input.createdAt ?? ts,
    updated_at: input.updatedAt ?? ts,
    deleted_at: null,
  }

  await withWriteRetry(db, async (trx) => {
    await trx.insertInto('contexts').values(row).execute()

    const tagIds = await ensureTags(trx, tags)
    if (tagIds.length > 0) {
      await trx
        .insertInto('context_tags')
        .values(tagIds.map((tag_id) => ({ context_id: id, tag_id })))
        // re-create paths (import/dump) may replay the same pair concurrently
        .onConflict((oc) => oc.columns(['context_id', 'tag_id']).doNothing())
        .execute()
    }

    await trx
      .insertInto('context_history')
      .values({
        context_id: id,
        event: 'create',
        old_body: null,
        new_body: input.body,
        agent_source: agentSource,
        changed_at: ts,
      })
      .execute()
  })

  return toContext(row, [...tags].sort())
}

/** Fetch a single context by id. Returns soft-deleted rows too (caller decides). */
export async function getContext(db: Kysely<Database>, id: string): Promise<Context | null> {
  const row = await db.selectFrom('contexts').selectAll().where('id', '=', id).executeTakeFirst()
  if (!row) return null
  const tags = (await tagsByContext(db, [id])).get(id) ?? []
  return toContext(row, tags)
}

export async function listContexts(
  db: Kysely<Database>,
  filters: ListFilters = {},
): Promise<Context[]> {
  let q = db.selectFrom('contexts').selectAll()
  if (!filters.includeDeleted) q = q.where('deleted_at', 'is', null)
  const pageScope = filters.pageScope ?? 'context'
  if (pageScope === 'context') q = q.where('page_type', 'is', null)
  else if (pageScope === 'wiki') q = q.where('page_type', 'is not', null)
  if (filters.namespace) q = q.where('namespace', '=', filters.namespace)
  if (filters.kind) q = q.where('kind', '=', filters.kind)
  if (filters.scope) q = q.where('scope', '=', filters.scope)
  if (filters.agentSource) q = q.where('agent_source', '=', filters.agentSource)
  if (filters.tag) {
    q = q.where('id', 'in', (eb) =>
      eb
        .selectFrom('context_tags as ct')
        .innerJoin('tags as t', 't.id', 'ct.tag_id')
        .select('ct.context_id')
        .where('t.name', '=', filters.tag as string),
    )
  }
  q = q.orderBy('id', 'desc').limit(filters.limit ?? 50)

  const rows = await q.execute()
  const tagMap = await tagsByContext(
    db,
    rows.map((r) => r.id),
  )
  return rows.map((r) => toContext(r, tagMap.get(r.id) ?? []))
}

export async function updateContext(
  db: Kysely<Database>,
  id: string,
  patch: UpdateInput,
): Promise<Context | null> {
  const ts = nowIso()
  // The read-modify-write happens entirely inside the IMMEDIATE transaction, so a
  // concurrent writer can't slip between the read and the write (lost update) and
  // the audit `old_body` always records the true immediate predecessor.
  return withWriteRetry(db, async (trx) => {
    const existing = await trx
      .selectFrom('contexts')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()
    if (!existing) return null

    const update: Updateable<ContextsTable> = { updated_at: ts }
    if (patch.title !== undefined) update.title = patch.title
    if (patch.body !== undefined) update.body = patch.body
    if (patch.agentSource !== undefined) update.agent_source = patch.agentSource
    if (patch.setMetadata) {
      update.metadata = JSON.stringify({
        ...parseMetadata(existing.metadata),
        ...patch.setMetadata,
      })
    }
    await trx.updateTable('contexts').set(update).where('id', '=', id).execute()

    const addIds = await ensureTags(trx, patch.addTags ?? [])
    if (addIds.length > 0) {
      await trx
        .insertInto('context_tags')
        .values(addIds.map((tag_id) => ({ context_id: id, tag_id })))
        .onConflict((oc) => oc.columns(['context_id', 'tag_id']).doNothing())
        .execute()
    }

    if (patch.removeTags && patch.removeTags.length > 0) {
      const rmRows = await trx
        .selectFrom('tags')
        .select('id')
        .where('name', 'in', patch.removeTags)
        .execute()
      const rmIds = rmRows.map((r) => r.id)
      if (rmIds.length > 0) {
        await trx
          .deleteFrom('context_tags')
          .where('context_id', '=', id)
          .where('tag_id', 'in', rmIds)
          .execute()
      }
    }

    await trx
      .insertInto('context_history')
      .values({
        context_id: id,
        event: 'update',
        old_body: existing.body,
        new_body: patch.body ?? existing.body,
        agent_source: patch.agentSource ?? existing.agent_source,
        changed_at: ts,
      })
      .execute()

    // Build the result from the post-write state read inside the same transaction.
    const tags = (await tagsByContext(trx, [id])).get(id) ?? []
    const resultRow: ContextRow = {
      ...existing,
      updated_at: ts,
      title: patch.title !== undefined ? patch.title : existing.title,
      body: patch.body !== undefined ? patch.body : existing.body,
      agent_source: patch.agentSource !== undefined ? patch.agentSource : existing.agent_source,
      metadata: typeof update.metadata === 'string' ? update.metadata : existing.metadata,
    }
    return toContext(resultRow, tags)
  })
}

/**
 * Delete a context. Soft by default (sets deleted_at, keeps the row);
 * `hard` removes it entirely. Either way an audit row is written.
 */
export async function deleteContext(
  db: Kysely<Database>,
  id: string,
  opts: { hard?: boolean; agentSource?: string | null } = {},
): Promise<boolean> {
  const ts = nowIso()
  return withWriteRetry(db, async (trx) => {
    const existing = await trx
      .selectFrom('contexts')
      .select(['body', 'agent_source'])
      .where('id', '=', id)
      .executeTakeFirst()
    if (!existing) return false

    await trx
      .insertInto('context_history')
      .values({
        context_id: id,
        event: 'delete',
        old_body: existing.body,
        new_body: null,
        agent_source: opts.agentSource ?? existing.agent_source,
        changed_at: ts,
      })
      .execute()

    if (opts.hard) {
      await trx.deleteFrom('contexts').where('id', '=', id).execute()
    } else {
      await trx
        .updateTable('contexts')
        .set({ deleted_at: ts, updated_at: ts })
        .where('id', '=', id)
        .execute()
    }
    return true
  })
}

/** Quote each whitespace term so arbitrary input is a valid FTS5 MATCH expression. */
function sanitizeFtsQuery(query: string): string {
  const tokens = query.match(/\S+/g) ?? []
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' ')
}

export async function searchContexts(
  db: Kysely<Database>,
  query: string,
  filters: ListFilters = {},
): Promise<Context[]> {
  const limit = filters.limit ?? 50

  const run = async (matchExpr: string): Promise<ContextRow[]> => {
    const conditions = [sql`contexts_fts MATCH ${matchExpr}`]
    if (!filters.includeDeleted) conditions.push(sql`c.deleted_at IS NULL`)
    const pageScope = filters.pageScope ?? 'context'
    if (pageScope === 'context') conditions.push(sql`c.page_type IS NULL`)
    else if (pageScope === 'wiki') conditions.push(sql`c.page_type IS NOT NULL`)
    if (filters.namespace) conditions.push(sql`c.namespace = ${filters.namespace}`)
    if (filters.kind) conditions.push(sql`c.kind = ${filters.kind}`)
    if (filters.scope) conditions.push(sql`c.scope = ${filters.scope}`)
    if (filters.agentSource) conditions.push(sql`c.agent_source = ${filters.agentSource}`)
    if (filters.tag) {
      conditions.push(
        sql`c.id IN (
          SELECT ct.context_id FROM context_tags ct
          JOIN tags t ON t.id = ct.tag_id
          WHERE t.name = ${filters.tag}
        )`,
      )
    }
    const where = sql.join(conditions, sql` AND `)
    const result = await sql<ContextRow>`
      SELECT c.* FROM contexts c
      JOIN contexts_fts ON contexts_fts.rowid = c.rowid
      WHERE ${where}
      ORDER BY bm25(contexts_fts)
      LIMIT ${limit}
    `.execute(db)
    return result.rows
  }

  // Try the query as written (supports FTS5 operators); on a syntax error fall
  // back to a sanitized term-quoted query so ordinary input ("C++", "a:b") works.
  let rows: ContextRow[]
  try {
    rows = await run(query)
  } catch {
    try {
      rows = await run(sanitizeFtsQuery(query))
    } catch {
      return []
    }
  }

  const tagMap = await tagsByContext(
    db,
    rows.map((r) => r.id),
  )
  return rows.map((r) => toContext(r, tagMap.get(r.id) ?? []))
}
