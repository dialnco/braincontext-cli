import type { Kysely } from 'kysely'
import { normalizeTitle, parseWikiLinks, slugify } from '../lib/wikilinks'
import {
  type Context,
  createContext,
  getContext,
  listContexts,
  searchContexts,
  type UpdateInput,
  updateContext,
} from './contexts'
import type { Database, PageType } from './types'

function nowIso(): string {
  return new Date().toISOString()
}

// ---------------------------------------------------------------------------
// Pages (wiki pages are contexts with a non-null page_type)
// ---------------------------------------------------------------------------

export interface CreatePageInput {
  title: string
  pageType: PageType
  body?: string
  namespace?: string
  tags?: string[]
  agentSource?: string | null
  /** Preferred slug (used if free); otherwise derived from the title. */
  slug?: string
}

/** A unique-among-pages slug derived from `base`. */
async function uniqueSlug(db: Kysely<Database>, base: string): Promise<string> {
  const rows = await db
    .selectFrom('contexts')
    .select('slug')
    .where('slug', 'like', `${base}%`)
    .where('slug', 'is not', null)
    .execute()
  const taken = new Set(rows.map((r) => r.slug))
  if (!taken.has(base)) return base
  let i = 2
  while (taken.has(`${base}-${i}`)) i++
  return `${base}-${i}`
}

export async function createPage(db: Kysely<Database>, input: CreatePageInput): Promise<Context> {
  const slug = await uniqueSlug(db, input.slug ?? slugify(input.title))
  const page = await createContext(db, {
    title: input.title,
    body: input.body ?? '',
    kind: 'note',
    namespace: input.namespace ?? 'wiki',
    scope: 'project',
    agentSource: input.agentSource ?? null,
    tags: input.tags,
    pageType: input.pageType,
    slug,
  })
  await syncBodyLinks(db, page.id, page.body)
  return (await getPage(db, page.id)) ?? page
}

export async function recordSource(
  db: Kysely<Database>,
  input: { title: string; body: string; uri?: string; agentSource?: string | null },
): Promise<Context> {
  const slug = await uniqueSlug(db, slugify(input.title))
  return createContext(db, {
    title: input.title,
    body: input.body,
    kind: 'note',
    namespace: 'wiki',
    scope: 'project',
    agentSource: input.agentSource ?? null,
    pageType: 'source',
    slug,
    metadata: input.uri ? { uri: input.uri } : {},
  })
}

export async function getPage(db: Kysely<Database>, id: string): Promise<Context | null> {
  const ctx = await getContext(db, id)
  return ctx && ctx.pageType !== null ? ctx : null
}

export async function getPageBySlug(db: Kysely<Database>, slug: string): Promise<Context | null> {
  const row = await db
    .selectFrom('contexts')
    .select('id')
    .where('slug', '=', slug)
    .where('page_type', 'is not', null)
    .where('deleted_at', 'is', null)
    .executeTakeFirst()
  return row ? getContext(db, row.id) : null
}

/** Non-deleted wiki pages whose normalized title matches, newest first. */
async function pageMatchesByTitle(
  db: Kysely<Database>,
  title: string,
): Promise<Array<{ id: string; updatedAt: string }>> {
  const norm = normalizeTitle(title)
  const rows = await db
    .selectFrom('contexts')
    .select(['id', 'title', 'updated_at'])
    .where('page_type', 'is not', null)
    .where('deleted_at', 'is', null)
    .execute()
  return rows
    .filter((r) => r.title && normalizeTitle(r.title) === norm)
    .map((r) => ({ id: r.id, updatedAt: r.updated_at }))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
}

export async function getPageByTitle(db: Kysely<Database>, title: string): Promise<Context | null> {
  const matches = await pageMatchesByTitle(db, title)
  return matches[0] ? getContext(db, matches[0].id) : null
}

export async function updatePage(
  db: Kysely<Database>,
  id: string,
  patch: UpdateInput,
): Promise<Context | null> {
  const page = await getPage(db, id)
  if (!page) return null
  if (page.pageType === 'source') {
    throw new Error('source pages are immutable')
  }
  const updated = await updateContext(db, id, patch)
  if (updated && patch.body !== undefined) await syncBodyLinks(db, id, patch.body)
  return updated
}

export async function listPages(
  db: Kysely<Database>,
  opts: { pageType?: string; namespace?: string; limit?: number } = {},
): Promise<Context[]> {
  const pages = await listContexts(db, {
    pageScope: 'wiki',
    namespace: opts.namespace,
    limit: opts.limit ?? 500,
  })
  return opts.pageType ? pages.filter((p) => p.pageType === opts.pageType) : pages
}

export async function searchPages(
  db: Kysely<Database>,
  query: string,
  opts: { namespace?: string; limit?: number; pageType?: string } = {},
): Promise<Context[]> {
  const hits = await searchContexts(db, query, {
    pageScope: 'wiki',
    namespace: opts.namespace,
    limit: opts.limit,
  })
  return opts.pageType ? hits.filter((h) => h.pageType === opts.pageType) : hits
}

// ---------------------------------------------------------------------------
// Links (the typed graph)
// ---------------------------------------------------------------------------

export interface LinkView {
  id: number
  type: string
  /** The other endpoint's page id (target for outbound, source for backlinks). */
  pageId: string | null
  title: string | null
  wanted: boolean
}

export interface AddLinkInput {
  toId?: string
  toTitle?: string
  type: string
}

/** Add a typed edge. Resolves toTitle->id (non-deleted wiki pages); unresolved => wanted link. */
export async function addLink(
  db: Kysely<Database>,
  fromId: string,
  input: AddLinkInput,
): Promise<void> {
  let toId = input.toId ?? null
  let toTitle = input.toTitle ?? null

  if (!toId && toTitle) {
    const matches = await pageMatchesByTitle(db, toTitle)
    if (matches[0]) {
      toId = matches[0].id
      toTitle = null
    }
  }
  if (toId && toId === fromId) return // no self-links

  const dup = await db
    .selectFrom('links')
    .select('id')
    .where('from_id', '=', fromId)
    .where('type', '=', input.type)
    .where(toId ? 'to_id' : 'to_title', '=', toId ?? toTitle)
    .executeTakeFirst()
  if (dup) return

  await db
    .insertInto('links')
    .values({
      from_id: fromId,
      to_id: toId,
      to_title: toTitle,
      type: input.type,
      created_at: nowIso(),
    })
    .execute()
}

export async function removeLink(
  db: Kysely<Database>,
  fromId: string,
  input: { toId?: string; toTitle?: string; type?: string },
): Promise<void> {
  let q = db.deleteFrom('links').where('from_id', '=', fromId)
  if (input.type) q = q.where('type', '=', input.type)
  if (input.toId) {
    q = q.where('to_id', '=', input.toId)
  } else if (input.toTitle) {
    const matches = await pageMatchesByTitle(db, input.toTitle)
    q = matches[0] ? q.where('to_id', '=', matches[0].id) : q.where('to_title', '=', input.toTitle)
  }
  await q.execute()
}

export async function outboundLinks(db: Kysely<Database>, id: string): Promise<LinkView[]> {
  const rows = await db
    .selectFrom('links as l')
    .leftJoin('contexts as c', 'c.id', 'l.to_id')
    .select([
      'l.id as id',
      'l.type as type',
      'l.to_id as toId',
      'l.to_title as toTitle',
      'c.title as ctitle',
    ])
    .where('l.from_id', '=', id)
    .orderBy('l.type')
    .execute()
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    pageId: r.toId,
    title: r.ctitle ?? r.toTitle,
    wanted: r.toId === null,
  }))
}

export async function backlinks(db: Kysely<Database>, id: string): Promise<LinkView[]> {
  const rows = await db
    .selectFrom('links as l')
    .innerJoin('contexts as f', 'f.id', 'l.from_id')
    .select(['l.id as id', 'l.type as type', 'l.from_id as fromId', 'f.title as ftitle'])
    .where('l.to_id', '=', id)
    .where('f.deleted_at', 'is', null)
    .orderBy('l.type')
    .execute()
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    pageId: r.fromId,
    title: r.ftitle,
    wanted: false,
  }))
}

/** Re-derive the reserved `references` channel from [[..]] in a body, leaving explicit edges intact. */
export async function syncBodyLinks(db: Kysely<Database>, id: string, body: string): Promise<void> {
  await db.deleteFrom('links').where('from_id', '=', id).where('type', '=', 'references').execute()
  for (const title of parseWikiLinks(body)) {
    await addLink(db, id, { toTitle: title, type: 'references' })
  }
}

// ---------------------------------------------------------------------------
// Operation log
// ---------------------------------------------------------------------------

export interface WikiLogEntry {
  op: string
  refId?: string | null
  title?: string | null
  detail?: string | null
  agentSource?: string | null
}

export async function appendLog(db: Kysely<Database>, entry: WikiLogEntry): Promise<void> {
  await db
    .insertInto('wiki_log')
    .values({
      op: entry.op,
      ref_id: entry.refId ?? null,
      title: entry.title ?? null,
      detail: entry.detail ?? null,
      agent_source: entry.agentSource ?? null,
      created_at: nowIso(),
    })
    .execute()
}

export interface WikiLogRow {
  op: string
  refId: string | null
  title: string | null
  detail: string | null
  agentSource: string | null
  createdAt: string
}

export async function listLog(
  db: Kysely<Database>,
  opts: { limit?: number } = {},
): Promise<WikiLogRow[]> {
  const rows = await db
    .selectFrom('wiki_log')
    .selectAll()
    .orderBy('id', 'desc')
    .limit(opts.limit ?? 50)
    .execute()
  return rows.map((r) => ({
    op: r.op,
    refId: r.ref_id,
    title: r.title,
    detail: r.detail,
    agentSource: r.agent_source,
    createdAt: r.created_at,
  }))
}

// ---------------------------------------------------------------------------
// Lint
// ---------------------------------------------------------------------------

export type LintKind =
  | 'orphan'
  | 'dangling'
  | 'wanted'
  | 'ambiguous-wikilink'
  | 'source-without-page'
  | 'missing-from-index'

export interface LintFinding {
  kind: LintKind
  pageId?: string
  title?: string
  detail: string
}

export interface LintReport {
  findings: LintFinding[]
  counts: Record<string, number>
}

export async function lint(db: Kysely<Database>): Promise<LintReport> {
  const findings: LintFinding[] = []

  const pages = await db
    .selectFrom('contexts')
    .select(['id', 'title', 'page_type'])
    .where('page_type', 'is not', null)
    .where('deleted_at', 'is', null)
    .execute()

  // Inbound counts, excluding edges originating from index pages (so the index
  // catalog never masks orphans) and from soft-deleted sources.
  const inboundRows = await db
    .selectFrom('links as l')
    .innerJoin('contexts as f', 'f.id', 'l.from_id')
    .select(['l.to_id as toId', 'f.page_type as fromType'])
    .where('l.to_id', 'is not', null)
    .where('f.deleted_at', 'is', null)
    .execute()
  const inboundCount = new Map<string, number>()
  for (const r of inboundRows) {
    if (!r.toId || r.fromType === 'index') continue
    inboundCount.set(r.toId, (inboundCount.get(r.toId) ?? 0) + 1)
  }

  for (const p of pages) {
    if (p.page_type === 'index' || p.page_type === 'source') continue
    if (!inboundCount.get(p.id)) {
      findings.push({
        kind: 'orphan',
        pageId: p.id,
        title: p.title ?? '',
        detail: 'no inbound links',
      })
    }
  }

  // dangling: resolved link to a missing or soft-deleted page
  const danglingRows = await db
    .selectFrom('links as l')
    .leftJoin('contexts as c', 'c.id', 'l.to_id')
    .select(['l.from_id as fromId', 'l.to_id as toId', 'c.id as cid', 'c.deleted_at as cdel'])
    .where('l.to_id', 'is not', null)
    .execute()
  for (const r of danglingRows) {
    if (!r.cid || r.cdel) {
      findings.push({
        kind: 'dangling',
        pageId: r.fromId,
        detail: `link to missing/deleted page ${r.toId}`,
      })
    }
  }

  // wanted: unresolved [[Title]]
  const wantedRows = await db
    .selectFrom('links')
    .select(['from_id', 'to_title'])
    .where('to_id', 'is', null)
    .where('to_title', 'is not', null)
    .execute()
  for (const r of wantedRows) {
    findings.push({
      kind: 'wanted',
      pageId: r.from_id,
      title: r.to_title ?? '',
      detail: `wanted page [[${r.to_title}]]`,
    })
  }

  // ambiguous: >1 page sharing a normalized title
  const byNorm = new Map<string, number>()
  for (const p of pages) {
    if (!p.title) continue
    const n = normalizeTitle(p.title)
    byNorm.set(n, (byNorm.get(n) ?? 0) + 1)
  }
  for (const [n, count] of byNorm) {
    if (count > 1) {
      findings.push({
        kind: 'ambiguous-wikilink',
        title: n,
        detail: `${count} pages share this title`,
      })
    }
  }

  // source-without-page: a source with no inbound type='source' edge
  const sourceTargets = new Set(
    (
      await db
        .selectFrom('links')
        .select('to_id')
        .where('type', '=', 'source')
        .where('to_id', 'is not', null)
        .execute()
    ).map((r) => r.to_id),
  )
  for (const p of pages) {
    if (p.page_type === 'source' && !sourceTargets.has(p.id)) {
      findings.push({
        kind: 'source-without-page',
        pageId: p.id,
        title: p.title ?? '',
        detail: 'no page derives from this source',
      })
    }
  }

  // missing-from-index: only when an index page exists
  const indexIds = pages.filter((p) => p.page_type === 'index').map((p) => p.id)
  if (indexIds.length > 0) {
    const indexed = new Set(
      (
        await db
          .selectFrom('links')
          .select('to_id')
          .where('from_id', 'in', indexIds)
          .where('to_id', 'is not', null)
          .execute()
      ).map((r) => r.to_id),
    )
    for (const p of pages) {
      if (p.page_type === 'index' || p.page_type === 'source') continue
      if (!indexed.has(p.id)) {
        findings.push({
          kind: 'missing-from-index',
          pageId: p.id,
          title: p.title ?? '',
          detail: 'not linked from index',
        })
      }
    }
  }

  const counts: Record<string, number> = {}
  for (const f of findings) counts[f.kind] = (counts[f.kind] ?? 0) + 1
  return { findings, counts }
}
