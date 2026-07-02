import type { Kysely } from 'kysely'
import { extractExcerpt, extractOutline } from '../lib/outline'
import { estimateTokens } from '../lib/tokens'
import { normalizeTitle, parseWikiLinks, slugify } from '../lib/wikilinks'
import {
  type Context,
  createContext,
  getContext,
  listContexts,
  parseMetadata,
  searchContexts,
  type UpdateInput,
  updateContext,
} from './contexts'
import { withWriteRetry } from './tx'
import { type Database, type PageType, REFERENCES_LINK, type VerificationState } from './types'

function nowIso(): string {
  return new Date().toISOString()
}

/** A concurrent same-title create lost the slug race; the caller recomputes + retries. */
function isSlugConflict(e: unknown): boolean {
  return /UNIQUE constraint failed: contexts\.slug|idx_contexts_slug/i.test(
    String((e as Error)?.message ?? e),
  )
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
  /** Preferred slug (always normalized via slugify); otherwise derived from the title. */
  slug?: string
  createdAt?: string
  updatedAt?: string
  metadata?: Record<string, unknown>
}

/**
 * Point any pre-existing "wanted" links ([[Title]] with no target yet) at a newly
 * created page whose title matches (case/space-insensitive). Without this, linking
 * to a page before it exists leaves it permanently orphaned.
 */
async function resolveWantedLinks(
  db: Kysely<Database>,
  pageId: string,
  title: string,
): Promise<void> {
  const norm = normalizeTitle(title)
  // One transaction so the dup-check + resolve is atomic (no concurrent writer can
  // insert a colliding resolved edge between the check and the update).
  await withWriteRetry(db, async (trx) => {
    const wanted = await trx
      .selectFrom('links')
      .select(['id', 'from_id', 'to_title', 'type'])
      .where('to_id', 'is', null)
      .where('to_title', 'is not', null)
      .execute()
    for (const w of wanted) {
      if (!w.to_title || normalizeTitle(w.to_title) !== norm) continue
      if (w.from_id === pageId) {
        await trx.deleteFrom('links').where('id', '=', w.id).execute() // would be a self-link
        continue
      }
      const dup = await trx
        .selectFrom('links')
        .select('id')
        .where('from_id', '=', w.from_id)
        .where('to_id', '=', pageId)
        .where('type', '=', w.type)
        .executeTakeFirst()
      if (dup) await trx.deleteFrom('links').where('id', '=', w.id).execute()
      else
        await trx
          .updateTable('links')
          .set({ to_id: pageId, to_title: null })
          .where('id', '=', w.id)
          .execute()
    }
  })
}

/** Reserved: the wiki export writes these as the generated catalog/log, so no page may own them. */
const RESERVED_SLUGS = new Set(['index', 'log'])

/** A unique-among-pages slug derived from `base`. */
async function uniqueSlug(db: Kysely<Database>, base: string): Promise<string> {
  const rows = await db
    .selectFrom('contexts')
    .select('slug')
    .where('slug', 'like', `${base}%`)
    .where('slug', 'is not', null)
    .execute()
  const taken = new Set<string | null>(rows.map((r) => r.slug))
  for (const r of RESERVED_SLUGS) taken.add(r)
  if (!taken.has(base)) return base
  let i = 2
  while (taken.has(`${base}-${i}`)) i++
  return `${base}-${i}`
}

export async function createPage(db: Kysely<Database>, input: CreatePageInput): Promise<Context> {
  // Always run the candidate through slugify so an imported/crafted slug can't
  // contain path separators (export writes <slug>.md). A concurrent same-title
  // create can lose the slug race; recompute and retry on that specific conflict.
  for (let attempt = 1; ; attempt++) {
    const slug = await uniqueSlug(db, slugify(input.slug ?? input.title))
    let page: Context
    try {
      page = await createContext(db, {
        title: input.title,
        body: input.body ?? '',
        kind: 'note',
        namespace: input.namespace ?? 'wiki',
        scope: 'project',
        agentSource: input.agentSource ?? null,
        tags: input.tags,
        pageType: input.pageType,
        slug,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
        metadata: input.metadata,
      })
    } catch (e) {
      if (attempt < 6 && isSlugConflict(e)) continue
      throw e
    }
    await syncBodyLinks(db, page.id, page.body)
    await resolveWantedLinks(db, page.id, input.title)
    return page
  }
}

export async function recordSource(
  db: Kysely<Database>,
  input: {
    title: string
    body: string
    uri?: string
    agentSource?: string | null
    createdAt?: string
    updatedAt?: string
  },
): Promise<Context> {
  for (let attempt = 1; ; attempt++) {
    const slug = await uniqueSlug(db, slugify(input.title))
    let page: Context
    try {
      page = await createContext(db, {
        title: input.title,
        body: input.body,
        kind: 'note',
        namespace: 'wiki',
        scope: 'project',
        agentSource: input.agentSource ?? null,
        pageType: 'source',
        slug,
        metadata: input.uri ? { uri: input.uri } : {},
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
      })
    } catch (e) {
      if (attempt < 6 && isSlugConflict(e)) continue
      throw e
    }
    await resolveWantedLinks(db, page.id, input.title)
    return page
  }
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

/**
 * Resolve an `<id|slug|title>` reference to a wiki page. Exact indexed keys (id,
 * slug) are tried before the fuzzy normalized-title match, so a title collision
 * can't mask an exact slug hit.
 */
export async function resolvePageRef(db: Kysely<Database>, ref: string): Promise<Context | null> {
  return (
    (await getPage(db, ref)) ?? (await getPageBySlug(db, ref)) ?? (await getPageByTitle(db, ref))
  )
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
  // pageType is pushed into the SQL WHERE so LIMIT applies to already-filtered rows
  // (a JS post-filter would silently truncate type-filtered results to < limit).
  return listContexts(db, {
    pageScope: 'wiki',
    pageType: opts.pageType,
    namespace: opts.namespace,
    limit: opts.limit ?? 500,
  })
}

export async function searchPages(
  db: Kysely<Database>,
  query: string,
  opts: { namespace?: string; limit?: number; pageType?: string } = {},
): Promise<Context[]> {
  return searchContexts(db, query, {
    pageScope: 'wiki',
    pageType: opts.pageType,
    namespace: opts.namespace,
    limit: opts.limit,
  })
}

// ---------------------------------------------------------------------------
// Freshness / verification (the gist's confidence states)
// ---------------------------------------------------------------------------

/** Pages not verified or updated within this many days count as stale. */
export const DEFAULT_STALE_DAYS = 45

export interface PageFreshness {
  state: VerificationState
  /** Days since last verification (or last update when never verified). */
  ageDays: number
  verifiedAt: string | null
  verifiedBy: string | null
}

/**
 * Derive a page's freshness from `metadata.verifiedAt`/`verifiedBy` + `updatedAt`.
 * The state is always computed, never stored, so it can't outlive its inputs.
 * Age counts from the most recent of (verifiedAt, updatedAt), so a fresh edit is
 * never "stale"; a verification only counts while no later edit invalidated it
 * (small tolerance — verifyPage stamps both within the same write).
 */
export function pageFreshness(
  page: Pick<Context, 'metadata' | 'updatedAt'>,
  opts: { staleDays?: number; now?: Date } = {},
): PageFreshness {
  const staleDays = opts.staleDays ?? DEFAULT_STALE_DAYS
  const verifiedAt = typeof page.metadata.verifiedAt === 'string' ? page.metadata.verifiedAt : null
  const verifiedBy = typeof page.metadata.verifiedBy === 'string' ? page.metadata.verifiedBy : null
  const verifiedMs = verifiedAt ? new Date(verifiedAt).getTime() : Number.NEGATIVE_INFINITY
  const updatedMs = new Date(page.updatedAt).getTime()
  const now = opts.now ?? new Date()
  const ageDays = Math.max(
    0,
    Math.floor((now.getTime() - Math.max(verifiedMs, updatedMs)) / 86_400_000),
  )
  const verifiedCurrent = verifiedAt !== null && verifiedMs >= updatedMs - 5000
  const state: VerificationState =
    ageDays > staleDays ? 'stale' : verifiedCurrent ? 'verified' : 'unverified'
  return { state, ageDays, verifiedAt, verifiedBy }
}

/** Mark a page as verified now. Throws on `source` pages (immutable, never stale). */
export async function verifyPage(
  db: Kysely<Database>,
  id: string,
  opts: { agent?: string | null } = {},
): Promise<Context | null> {
  const page = await getPage(db, id)
  if (!page) return null
  const updated = await updatePage(db, id, {
    setMetadata: { verifiedAt: nowIso(), verifiedBy: opts.agent ?? null },
    agentSource: opts.agent ?? undefined,
  })
  if (updated) {
    await appendLog(db, {
      op: 'verify',
      refId: id,
      title: page.title,
      agentSource: opts.agent ?? null,
    })
  }
  return updated
}

// ---------------------------------------------------------------------------
// Peek (the middle rung of the disclosure ladder: index line -> peek -> full)
// ---------------------------------------------------------------------------

export interface PagePeek {
  id: string
  slug: string | null
  title: string | null
  pageType: string | null
  namespace: string
  tags: string[]
  /** What fetching the full body would cost (~chars/4). */
  tokenEstimate: number
  /** Section headings (## / ###) in document order. */
  outline: string[]
  /** Leading ~400 chars of the body, [[wikilinks]] intact. */
  excerpt: string
  /** Source-code files this page documents (metadata.sources) — "the relevant files". */
  sources: string[]
  links: Array<{ type: string; title: string | null; wanted: boolean }>
  backlinks: Array<{ type: string; title: string | null }>
  createdAt: string
  updatedAt: string
  freshness: PageFreshness
}

/** A budget-friendly summary of a page: enough to decide whether to fetch the body. */
export async function pagePeek(
  db: Kysely<Database>,
  id: string,
  opts: { staleDays?: number } = {},
): Promise<PagePeek | null> {
  const page = await getPage(db, id)
  if (!page || page.deletedAt) return null
  const [outbound, back] = await Promise.all([outboundLinks(db, page.id), backlinks(db, page.id)])
  return {
    id: page.id,
    slug: page.slug,
    title: page.title,
    pageType: page.pageType,
    namespace: page.namespace,
    tags: page.tags,
    tokenEstimate: estimateTokens(page.body),
    outline: extractOutline(page.body),
    excerpt: extractExcerpt(page.body),
    sources: Array.isArray(page.metadata.sources)
      ? page.metadata.sources.filter((s): s is string => typeof s === 'string')
      : [],
    links: outbound.map((l) => ({ type: l.type, title: l.title, wanted: l.wanted })),
    backlinks: back.map((l) => ({ type: l.type, title: l.title })),
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
    freshness: pageFreshness(page, opts),
  }
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
  if (!toId && !toTitle) return // nothing to link to

  if (!toId && toTitle) {
    const matches = await pageMatchesByTitle(db, toTitle)
    if (matches[0]) {
      toId = matches[0].id
      toTitle = null
    }
  }
  if (toId && toId === fromId) return // no self-links

  // Dedup. Wanted links compare on the normalized title (resolution is case-insensitive).
  if (toId) {
    const dup = await db
      .selectFrom('links')
      .select('id')
      .where('from_id', '=', fromId)
      .where('type', '=', input.type)
      .where('to_id', '=', toId)
      .executeTakeFirst()
    if (dup) return
  } else {
    const norm = normalizeTitle(toTitle ?? '')
    const existing = await db
      .selectFrom('links')
      .select('to_title')
      .where('from_id', '=', fromId)
      .where('type', '=', input.type)
      .where('to_id', 'is', null)
      .execute()
    if (existing.some((w) => w.to_title && normalizeTitle(w.to_title) === norm)) return
  }

  await db
    .insertInto('links')
    .values({
      from_id: fromId,
      to_id: toId,
      to_title: toTitle,
      type: input.type,
      created_at: nowIso(),
    })
    // The unique indexes (resolved + wanted) backstop the app-level dedup above so a
    // concurrent insert that slipped past the check is a no-op, not a constraint error.
    .onConflict((oc) => oc.doNothing())
    .execute()
}

/** Remove matching link(s); returns how many edges were deleted (0 = nothing matched). */
export async function removeLink(
  db: Kysely<Database>,
  fromId: string,
  input: { toId?: string; toTitle?: string; type?: string },
): Promise<number> {
  let q = db.deleteFrom('links').where('from_id', '=', fromId)
  if (input.type) q = q.where('type', '=', input.type)
  if (input.toId) {
    q = q.where('to_id', '=', input.toId)
  } else if (input.toTitle) {
    const matches = await pageMatchesByTitle(db, input.toTitle)
    q = matches[0] ? q.where('to_id', '=', matches[0].id) : q.where('to_title', '=', input.toTitle)
  }
  const res = await q.executeTakeFirst()
  return Number(res?.numDeletedRows ?? 0n)
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
  // One transaction so a concurrent reader never sees the transient zero-links state
  // between the delete and the re-add (and two concurrent syncs can't interleave).
  await withWriteRetry(db, async (trx) => {
    await trx
      .deleteFrom('links')
      .where('from_id', '=', id)
      .where('type', '=', REFERENCES_LINK)
      .execute()
    for (const title of parseWikiLinks(body)) {
      await addLink(trx, id, { toTitle: title, type: REFERENCES_LINK })
    }
  })
}

// ---------------------------------------------------------------------------
// Graph (nodes = pages, edges = resolved typed links between them)
// ---------------------------------------------------------------------------

export interface GraphNode {
  id: string
  title: string | null
  pageType: string | null
  /** Undirected degree (inbound + outbound resolved edges within the graph). */
  degree: number
}

export interface GraphEdge {
  from: string
  to: string
  type: string
}

export interface WikiGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

/**
 * The wiki knowledge graph: every live page is a node; every resolved link whose
 * BOTH endpoints are live pages is an edge. Wanted (`to_id NULL`) links are omitted
 * — they have no node to point at. Degree counts edges incident to each node.
 *
 * `minDegree` drops sparsely-connected nodes; `limit` keeps only the N best-connected
 * — both prune edges to surviving endpoints, so a large wiki returns a digestible core
 * instead of thousands of nodes.
 */
export async function wikiGraph(
  db: Kysely<Database>,
  opts: { namespace?: string; minDegree?: number; limit?: number } = {},
): Promise<WikiGraph> {
  const pages = await listPages(db, { namespace: opts.namespace, limit: 5000 })
  const ids = new Set(pages.map((p) => p.id))

  const rows = await db
    .selectFrom('links')
    .select(['from_id as from', 'to_id as to', 'type'])
    .where('to_id', 'is not', null)
    .execute()

  const allEdges: GraphEdge[] = []
  const degree = new Map<string, number>()
  for (const r of rows) {
    if (!r.to || !ids.has(r.from) || !ids.has(r.to)) continue
    allEdges.push({ from: r.from, to: r.to, type: r.type })
    degree.set(r.from, (degree.get(r.from) ?? 0) + 1)
    degree.set(r.to, (degree.get(r.to) ?? 0) + 1)
  }

  let nodes: GraphNode[] = pages.map((p) => ({
    id: p.id,
    title: p.title,
    pageType: p.pageType,
    degree: degree.get(p.id) ?? 0,
  }))
  if (opts.minDegree !== undefined) {
    const min = opts.minDegree
    nodes = nodes.filter((n) => n.degree >= min)
  }
  if (opts.limit !== undefined && nodes.length > opts.limit) {
    nodes = [...nodes].sort((a, b) => b.degree - a.degree).slice(0, opts.limit)
  }
  const kept = new Set(nodes.map((n) => n.id))
  const edges =
    kept.size === ids.size ? allEdges : allEdges.filter((e) => kept.has(e.from) && kept.has(e.to))
  return { nodes, edges }
}

// ---------------------------------------------------------------------------
// Ingest status (resumable synthesis: derive checklist completion from the graph)
// ---------------------------------------------------------------------------

export interface IngestStep {
  step: 'summary' | 'pages-updated' | 'index-refreshed' | 'verified'
  done: boolean
  detail: string
}

export interface IngestStatus {
  sourceId: string
  title: string | null
  ingestedAt: string
  steps: IngestStep[]
  /** True when every derivable step is done — the synthesis cascade completed. */
  complete: boolean
}

/**
 * Derive how far the post-ingest synthesis got for a source, purely from the
 * graph — no workflow state is stored, so the checklist is resumable across
 * sessions and can never lie about what actually happened.
 */
export async function ingestStatus(
  db: Kysely<Database>,
  sourceId: string,
): Promise<IngestStatus | null> {
  const source = await getPage(db, sourceId)
  if (!source || source.pageType !== 'source' || source.deletedAt) return null
  const ingestedAt = source.createdAt
  const steps: IngestStep[] = []

  // 1. A live authored page links -[source]-> this source (the summary).
  const inbound = await backlinks(db, source.id)
  const derivedIds = inbound.filter((l) => l.type === 'source' && l.pageId).map((l) => l.pageId!)
  const derived: Context[] = []
  for (const id of derivedIds) {
    const p = await getPage(db, id)
    if (p && !p.deletedAt && p.pageType !== 'source' && p.pageType !== 'index') derived.push(p)
  }
  const summary = derived.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0]
  steps.push(
    summary
      ? {
          step: 'summary',
          done: true,
          detail: `"${summary.title}" links this source (type "source")`,
        }
      : {
          step: 'summary',
          done: false,
          detail:
            'no page derives from this source — write one and wiki_link it with type "source"',
        },
  )

  // 2. Related pages woven in: authored pages (beyond the summary itself) updated
  //    after the ingest timestamp. A count, not proof of relatedness — stated as such.
  const derivedSet = new Set(derived.map((p) => p.id))
  const updatedRows = await db
    .selectFrom('contexts')
    .select(['id'])
    .where('page_type', 'is not', null)
    .where('page_type', 'not in', ['source', 'index'])
    .where('deleted_at', 'is', null)
    .where('updated_at', '>', ingestedAt)
    .execute()
  const updatedCount = updatedRows.filter((r) => !derivedSet.has(r.id)).length
  steps.push({
    step: 'pages-updated',
    done: updatedCount > 0,
    detail: `${updatedCount} other page(s) updated after ingest (aim for ~5–15 related ones)`,
  })

  // 3. Index refreshed — only derivable when an index PAGE exists in the store
  //    (a regenerated index.md file leaves no trace here).
  const indexPages = await listPages(db, { pageType: 'index', limit: 10 })
  const liveIndex = indexPages[0]
  if (liveIndex) {
    const indexDone =
      liveIndex.updatedAt > ingestedAt ||
      (summary !== undefined &&
        (await outboundLinks(db, liveIndex.id)).some((l) => l.pageId === summary.id))
    steps.push({
      step: 'index-refreshed',
      done: indexDone,
      detail: indexDone
        ? 'index page reflects this ingest'
        : 'index page predates this ingest and does not link the summary',
    })
  }

  // 4. The summary was verified after ingest (freshness honest).
  if (summary) {
    const f = pageFreshness(summary)
    const verifiedAfter = f.verifiedAt !== null && f.verifiedAt > ingestedAt
    steps.push({
      step: 'verified',
      done: verifiedAfter,
      detail: verifiedAfter
        ? `summary verified at ${f.verifiedAt}`
        : 'summary not verified yet — wiki_verify it once checked',
    })
  }

  return {
    sourceId: source.id,
    title: source.title,
    ingestedAt,
    steps,
    complete: steps.every((s) => s.done),
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
  | 'stale'
  | 'never-verified'
  /** Produced by src/wiki/drift.ts (fs-based), merged into lint reports by callers. */
  | 'drift'

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

export async function lint(
  db: Kysely<Database>,
  opts: { staleDays?: number } = {},
): Promise<LintReport> {
  const findings: LintFinding[] = []
  const staleDays = opts.staleDays ?? DEFAULT_STALE_DAYS

  const pages = await db
    .selectFrom('contexts')
    .select(['id', 'title', 'page_type', 'metadata', 'updated_at'])
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

  // dangling: resolved link (from a live page) to a missing or soft-deleted page
  const danglingRows = await db
    .selectFrom('links as l')
    .innerJoin('contexts as f', 'f.id', 'l.from_id')
    .leftJoin('contexts as c', 'c.id', 'l.to_id')
    .select(['l.from_id as fromId', 'l.to_id as toId', 'c.id as cid', 'c.deleted_at as cdel'])
    .where('l.to_id', 'is not', null)
    .where('f.deleted_at', 'is', null)
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

  // wanted: unresolved [[Title]] from a live page
  const wantedRows = await db
    .selectFrom('links as l')
    .innerJoin('contexts as f', 'f.id', 'l.from_id')
    .select(['l.from_id as from_id', 'l.to_title as to_title'])
    .where('l.to_id', 'is', null)
    .where('l.to_title', 'is not', null)
    .where('f.deleted_at', 'is', null)
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

  // freshness: authored pages last verified/updated more than staleDays ago.
  // Sources are immutable and the index is generated, so age means nothing there.
  for (const p of pages) {
    if (p.page_type === 'index' || p.page_type === 'source') continue
    const f = pageFreshness(
      { metadata: parseMetadata(p.metadata), updatedAt: p.updated_at },
      { staleDays },
    )
    if (f.state !== 'stale') continue
    findings.push(
      f.verifiedAt
        ? {
            kind: 'stale',
            pageId: p.id,
            title: p.title ?? '',
            detail: `last verified ${f.ageDays}d ago (> ${staleDays}d) — re-verify or update`,
          }
        : {
            kind: 'never-verified',
            pageId: p.id,
            title: p.title ?? '',
            detail: `never verified; last updated ${f.ageDays}d ago (> ${staleDays}d)`,
          },
    )
  }

  const counts: Record<string, number> = {}
  for (const f of findings) counts[f.kind] = (counts[f.kind] ?? 0) + 1
  return { findings, counts }
}
