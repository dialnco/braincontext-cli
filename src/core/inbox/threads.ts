import type { Client, InArgs, ResultSet } from '@libsql/client'
import { type Compilable, type Kysely, type Selectable, sql } from 'kysely'
import { ulid } from 'ulidx'
import { resolveAgent } from '../../lib/agent'
import { estimateTokens } from '../../lib/tokens'
import { AccessDeniedError } from '../access/errors'
import { toPrincipal } from '../access/principals'
import { type AccessSession, describeFailure, type SessionResult } from '../access/session'
import { setConfigValue } from '../storeConfig'
import { serializeWrite } from '../tx'
import {
  type Database,
  INBOX_KINDS,
  type InboxKind,
  type InboxStatus,
  type InboxThreadsTable,
  type Role,
} from '../types'
import { INBOX_SETUP_STEPS, InboxError } from './errors'

// ── Types ──────────────────────────────────────────────────────────────────────

type ThreadRow = Selectable<InboxThreadsTable>

/**
 * Where inbox operations run. `db` may carry the read-only plugin (a reader can
 * still write the inbox tables); `client` is the same connection, used to send a
 * write as ONE atomic batch — a single round trip to the primary instead of an
 * interactive transaction holding its write lock across several.
 */
export interface InboxStore {
  db: Kysely<Database>
  client: Client
}

export type InboxSurface = 'cli' | 'mcp' | 'studio'

/** Who is acting, resolved once per operation from the authenticated session. */
export interface InboxActor {
  principalId: string
  handle: string
  role: Role
  /** Per-session id (an agent session, an MCP process, a browser): claims + `wait`. */
  session: string | null
  agentSource: string | null
  surface: InboxSurface
  /** Self-reported; feeds the agent-to-agent loop guard only. */
  byAgent: boolean
}

export function actorFromSession(
  session: AccessSession,
  ctx: {
    surface: InboxSurface
    session?: string | null
    agentSource?: string | null
    byAgent: boolean
  },
): InboxActor {
  return {
    principalId: session.principal.id,
    handle: session.principal.handle,
    role: session.principal.role,
    session: ctx.session ?? null,
    agentSource: ctx.agentSource ?? (ctx.surface === 'studio' ? 'studio' : resolveAgent()),
    surface: ctx.surface,
    byAgent: ctx.byAgent,
  }
}

/**
 * The authenticated session an inbox operation runs as. The inbox addresses
 * members by identity, so a project without access control has no inbox at all.
 */
export function inboxSession(result: SessionResult): AccessSession {
  if (!result.enabled) {
    throw new InboxError(
      `The inbox needs access control: members are addressed by identity.\n${INBOX_SETUP_STEPS}`,
      'unavailable',
    )
  }
  if (!result.ok) {
    throw new AccessDeniedError(describeFailure(result.reason), { unauthenticated: true })
  }
  return result.session
}

export type InboxAction =
  | 'claim'
  | 'unclaim'
  | 'resolve'
  | 'decline'
  | 'reopen'
  | 'cancel'
  | 'reassign'

export const INBOX_ACTIONS: readonly InboxAction[] = [
  'claim',
  'unclaim',
  'resolve',
  'decline',
  'reopen',
  'cancel',
  'reassign',
]

export const OPEN_STATUSES: readonly InboxStatus[] = ['open', 'in_progress']
export const CLOSED_STATUSES: readonly InboxStatus[] = ['resolved', 'declined', 'cancelled']

export interface PersonRef {
  id: string
  handle: string
  /** The principal no longer exists (its handle may since belong to someone else). */
  removed: boolean
}

export interface InboxRef {
  type: 'page' | 'context' | 'file'
  id: string
}

export interface ThreadSummary {
  num: number
  id: string
  kind: InboxKind
  title: string
  status: InboxStatus
  urgent: boolean
  from: PersonRef
  /** Null = the team pool. */
  assignee: PersonRef | null
  claimed: { session: string | null; agent: string | null; at: string } | null
  resolution: string | null
  closedBy: string | null
  closedAt: string | null
  /** Who the thread is waiting on (null once closed). `team` for an unclaimed pool item. */
  awaiting: string | null
  unread: boolean
  lastSeq: number
  createdAt: string
  updatedAt: string
}

export interface InboxMessage {
  seq: number
  id: string
  author: PersonRef
  agentSource: string | null
  surface: InboxSurface
  byAgent: boolean
  type: 'message' | 'event'
  event: string | null
  body: string
  createdAt: string
}

export interface ThreadView extends ThreadSummary {
  refs: InboxRef[]
  messages: InboxMessage[]
  /** Older messages left out by `tail` (0 when everything in range was returned). */
  omitted: number
  /** ~Tokens of the returned bodies — what reading this view costs. */
  tokenEstimate: number
  /** ~Tokens of every body in range, including omitted ones — what the whole thread costs. */
  totalTokenEstimate: number
}

// ── Limits & settings ──────────────────────────────────────────────────────────

export const TITLE_MAX = 120
export const BODY_MAX_BYTES = 32_768
const MAX_REFS = 20
const RATE_WINDOW_MS = 10 * 60_000

export const INBOX_RATE_LIMIT_KEY = 'inbox.rateLimit'
export const INBOX_AGENT_TURNS_KEY = 'inbox.agentTurns'
export const DEFAULT_RATE_LIMIT = 30
export const DEFAULT_AGENT_TURNS = 6

export interface InboxSettings {
  /** Max inbox writes (messages + state changes) per member per 10 minutes. */
  rateLimit: number
  /** Max consecutive agent-authored messages in a thread before a human must step in. */
  agentTurns: number
}

function intSetting(raw: string | null, fallback: number): number {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : fallback
}

/** One query for both keys: on a remote primary every round trip is user-visible latency. */
export async function getInboxSettings(db: Kysely<Database>): Promise<InboxSettings> {
  const rows = await db
    .selectFrom('store_config')
    .select(['key', 'value'])
    .where('key', 'in', [INBOX_RATE_LIMIT_KEY, INBOX_AGENT_TURNS_KEY])
    .execute()
  const get = (k: string) => rows.find((r) => r.key === k)?.value ?? null
  return {
    rateLimit: intSetting(get(INBOX_RATE_LIMIT_KEY), DEFAULT_RATE_LIMIT),
    agentTurns: intSetting(get(INBOX_AGENT_TURNS_KEY), DEFAULT_AGENT_TURNS),
  }
}

/** Change the limits. The caller must already have checked `config.write`. */
export async function setInboxSettings(
  db: Kysely<Database>,
  patch: Partial<InboxSettings>,
): Promise<InboxSettings> {
  const clamp = (n: number, lo: number, hi: number, label: string) => {
    if (!Number.isInteger(n) || n < lo || n > hi) {
      throw new InboxError(`${label} must be an integer between ${lo} and ${hi}.`, 'invalid')
    }
    return String(n)
  }
  if (patch.rateLimit !== undefined) {
    await setConfigValue(db, INBOX_RATE_LIMIT_KEY, clamp(patch.rateLimit, 1, 1000, 'rate-limit'))
  }
  if (patch.agentTurns !== undefined) {
    await setConfigValue(db, INBOX_AGENT_TURNS_KEY, clamp(patch.agentTurns, 1, 100, 'agent-turns'))
  }
  return getInboxSettings(db)
}

// ── Small helpers ──────────────────────────────────────────────────────────────

const now = () => new Date().toISOString()

function isAdmin(actor: InboxActor): boolean {
  return actor.role === 'owner' || actor.role === 'admin'
}

/** A one-line title: whitespace collapsed, capped at TITLE_MAX. */
export function normalizeTitle(raw: string): string {
  const one = raw.replace(/\s+/g, ' ').trim()
  return one.length > TITLE_MAX ? `${one.slice(0, TITLE_MAX - 1).trimEnd()}…` : one
}

function firstLine(body: string): string {
  return body.split('\n').find((l) => l.trim()) ?? ''
}

function checkBody(body: string, label = 'Message'): string {
  if (Buffer.byteLength(body, 'utf8') > BODY_MAX_BYTES) {
    throw new InboxError(
      `${label} is larger than 32 KB. Put long content in a wiki page or file and pass it as a ref.`,
      'invalid',
    )
  }
  return body
}

/** Parse `42`, `#42`, or a thread ULID. */
export function parseThreadRef(ref: string): { num: number } | { id: string } {
  const r = ref.trim().replace(/^#/, '')
  if (/^\d+$/.test(r)) return { num: Number(r) }
  if (/^[0-9A-HJKMNP-TV-Z]{26}$/i.test(r)) return { id: r.toUpperCase() }
  throw new InboxError(
    `Not a thread reference: "${ref}" (expected 42, #42, or a thread id).`,
    'invalid',
  )
}

/** `@team` / `team` addresses the pool; anything else is a member handle. */
export function isTeamAddress(to: string): boolean {
  return /^@?team$/i.test(to.trim())
}

/**
 * Send several statements as ONE atomic batch, in this connection's write chain.
 * Statements are compiled through the handle — so the read-only plugin still
 * inspects every one of them — and then executed by the client.
 */
async function runBatch(store: InboxStore, queries: Compilable[]): Promise<ResultSet[]> {
  const stmts = queries.map((q) => {
    const c = q.compile()
    return { sql: c.sql, args: c.parameters as unknown as InArgs }
  })
  return serializeWrite(store.db, () => store.client.batch(stmts, 'write'))
}

async function loadThreadRow(db: Kysely<Database>, ref: string): Promise<ThreadRow> {
  const parsed = parseThreadRef(ref)
  let q = db.selectFrom('inbox_threads').selectAll()
  q = 'num' in parsed ? q.where('num', '=', parsed.num) : q.where('id', '=', parsed.id)
  const row = await q.executeTakeFirst()
  if (!row) throw new InboxError(`No inbox thread ${ref}.`, 'not_found')
  return row
}

async function principalIndex(db: Kysely<Database>): Promise<Map<string, string>> {
  const rows = await db.selectFrom('principals').select(['id', 'handle']).execute()
  return new Map(rows.map((r) => [r.id, r.handle]))
}

function person(id: string, handle: string, index: Map<string, string>): PersonRef {
  return { id, handle, removed: !index.has(id) }
}

function toSummary(row: ThreadRow, lastRead: number, index: Map<string, string>): ThreadSummary {
  const open = OPEN_STATUSES.includes(row.status)
  let awaiting: string | null = null
  if (open) {
    const senderSpokeLast = row.last_author_principal_id === row.from_principal_id
    awaiting = senderSpokeLast ? (row.assignee_handle ?? 'team') : row.from_handle
  }
  return {
    num: row.num,
    id: row.id,
    kind: row.kind,
    title: row.title,
    status: row.status,
    urgent: row.urgent === 1,
    from: person(row.from_principal_id, row.from_handle, index),
    assignee:
      row.assignee_principal_id && row.assignee_handle
        ? person(row.assignee_principal_id, row.assignee_handle, index)
        : null,
    claimed: row.claimed_at
      ? { session: row.claimed_session, agent: row.claimed_agent, at: row.claimed_at }
      : null,
    resolution: row.resolution,
    closedBy: row.closed_by_handle,
    closedAt: row.closed_at,
    awaiting,
    unread: row.last_seq > lastRead,
    lastSeq: row.last_seq,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function parseRefs(raw: string): InboxRef[] {
  try {
    const v: unknown = JSON.parse(raw)
    return Array.isArray(v)
      ? v.filter(
          (r): r is InboxRef =>
            !!r &&
            typeof r === 'object' &&
            ['page', 'context', 'file'].includes((r as InboxRef).type) &&
            typeof (r as InboxRef).id === 'string',
        )
      : []
  } catch {
    return []
  }
}

/** A recipient: an active member who can see the inbox. */
async function resolveMember(
  db: Kysely<Database>,
  to: string,
): Promise<{ id: string; handle: string }> {
  const want = to.trim().replace(/^@/, '').toLowerCase()
  const rows = await db.selectFrom('principals').selectAll().execute()
  const row = rows.find((r) => r.handle.toLowerCase() === want)
  if (!row) {
    throw new InboxError(
      `No member "@${want}" on this project. Run \`bctx inbox members\` to see who you can address.`,
      'no_such_member',
    )
  }
  const p = toPrincipal(row)
  if (p.status !== 'active') {
    throw new InboxError(`@${p.handle} is disabled on this project.`, 'no_such_member')
  }
  if (!p.capabilities.includes('inbox.read')) {
    throw new InboxError(`@${p.handle} cannot see the inbox (no inbox.read).`, 'no_such_member')
  }
  return { id: p.id, handle: p.handle }
}

/** Ids only; the reader resolves each through its own gated routes. */
async function resolveRefs(db: Kysely<Database>, ids: string[]): Promise<InboxRef[]> {
  const unique = [...new Set(ids.map((i) => i.trim()).filter(Boolean))]
  if (unique.length > MAX_REFS) throw new InboxError(`At most ${MAX_REFS} refs.`, 'invalid')
  const out: InboxRef[] = []
  for (const id of unique) {
    const ctx = await db
      .selectFrom('contexts')
      .select(['id', 'page_type'])
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst()
    if (ctx) {
      out.push({ type: ctx.page_type ? 'page' : 'context', id: ctx.id })
      continue
    }
    const file = await db
      .selectFrom('files')
      .select('id')
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst()
    if (file) {
      out.push({ type: 'file', id: file.id })
      continue
    }
    throw new InboxError(`Ref ${id} is not a page, context, or file in this project.`, 'invalid')
  }
  return out
}

/** Writes by this member inside the rate window (compared against the limit by the caller). */
async function recentWrites(store: InboxStore, actor: InboxActor): Promise<number> {
  const since = new Date(Date.now() - RATE_WINDOW_MS).toISOString()
  const row = await store.db
    .selectFrom('inbox_messages')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('author_principal_id', '=', actor.principalId)
    .where('created_at', '>', since)
    .executeTakeFirst()
  return Number(row?.n ?? 0)
}

interface Budget {
  settings: InboxSettings
  used: number
}

/**
 * Settings + this member's recent write count, fetched in parallel with whatever
 * else the caller needs (independent reads; on a remote primary each is a round trip).
 */
function writeBudget(store: InboxStore, actor: InboxActor): Promise<Budget> {
  return Promise.all([getInboxSettings(store.db), recentWrites(store, actor)]).then(
    ([settings, used]) => ({ settings, used }),
  )
}

function assertBudget(b: Budget): void {
  if (b.used >= b.settings.rateLimit) {
    throw new InboxError(
      `Inbox rate limit reached (${b.settings.rateLimit} writes per 10 minutes). Slow down — if two agents are answering each other in a loop, stop and check with your user.`,
      'rate_limited',
    )
  }
}

function messageValues(
  actor: InboxActor,
  threadId: string,
  body: string,
  type: 'message' | 'event',
  event: string | null,
) {
  return {
    id: ulid(),
    thread_id: threadId,
    author_principal_id: actor.principalId,
    author_handle: actor.handle,
    author_session: actor.session,
    agent_source: actor.agentSource,
    surface: actor.surface,
    by_agent: actor.byAgent ? 1 : 0,
    type,
    event,
    body,
    created_at: now(),
  }
}

/** Point the thread at its newest message (computed in-batch, never from insertId). */
function bumpLastSeq(db: Kysely<Database>, threadId: string) {
  return db
    .updateTable('inbox_threads')
    .set({
      last_seq: sql<number>`(SELECT max(seq) FROM inbox_messages WHERE thread_id = ${threadId})`,
    })
    .where('id', '=', threadId)
}

/** Mark everything up to the thread's current last_seq as read by `principalId`. */
function markReadQuery(db: Kysely<Database>, principalId: string, threadId: string) {
  const latest = sql<number>`(SELECT last_seq FROM inbox_threads WHERE id = ${threadId})`
  return db
    .insertInto('inbox_reads')
    .values({ principal_id: principalId, thread_id: threadId, last_read_seq: latest })
    .onConflict((oc) =>
      oc.columns(['principal_id', 'thread_id']).doUpdateSet({
        last_read_seq: sql<number>`max(inbox_reads.last_read_seq, excluded.last_read_seq)`,
      }),
    )
}

// ── Reads ──────────────────────────────────────────────────────────────────────

export type InboxBox = 'mine' | 'assigned' | 'sent' | 'team' | 'all'
export const INBOX_BOXES: readonly InboxBox[] = ['mine', 'assigned', 'sent', 'team', 'all']

export type StatusFilter = 'active' | 'closed' | 'any' | InboxStatus

export interface ListOptions {
  box?: InboxBox
  /** `active` (default) = open/in-progress PLUS anything with unread activity. */
  status?: StatusFilter
  kind?: InboxKind
  /** Only threads sent by this handle (resolved to a principal id, never matched by text). */
  from?: string
  limit?: number
}

export async function listThreads(
  store: InboxStore,
  actor: InboxActor,
  opts: ListOptions = {},
): Promise<ThreadSummary[]> {
  const me = actor.principalId
  const box = opts.box ?? 'mine'
  const status = opts.status ?? 'active'
  let q = store.db
    .selectFrom('inbox_threads as t')
    .leftJoin('inbox_reads as r', (j) =>
      j.onRef('r.thread_id', '=', 't.id').on('r.principal_id', '=', me),
    )
    .selectAll('t')
    .select(sql<number>`coalesce(r.last_read_seq, 0)`.as('last_read'))

  if (box === 'mine') {
    q = q.where((eb) =>
      eb.or([
        eb('t.assignee_principal_id', '=', me),
        eb('t.from_principal_id', '=', me),
        eb('t.assignee_principal_id', 'is', null),
      ]),
    )
  } else if (box === 'assigned') q = q.where('t.assignee_principal_id', '=', me)
  else if (box === 'sent') q = q.where('t.from_principal_id', '=', me)
  else if (box === 'team') q = q.where('t.assignee_principal_id', 'is', null)

  if (status === 'active') {
    q = q.where((eb) =>
      eb.or([
        eb('t.status', 'in', [...OPEN_STATUSES]),
        eb('t.last_seq', '>', sql<number>`coalesce(r.last_read_seq, 0)`),
      ]),
    )
  } else if (status === 'closed') q = q.where('t.status', 'in', [...CLOSED_STATUSES])
  else if (status !== 'any') q = q.where('t.status', '=', status)

  if (opts.kind) q = q.where('t.kind', '=', opts.kind)
  if (opts.from) {
    const sender = await resolveMemberLoose(store.db, opts.from)
    q = q.where('t.from_principal_id', '=', sender)
  }

  const rows = await q
    .orderBy('t.last_seq', 'desc')
    .orderBy('t.num', 'desc')
    .limit(Math.min(opts.limit ?? 50, 500))
    .execute()
  const index = await principalIndex(store.db)
  return rows.map((r) => toSummary(r, Number(r.last_read), index))
}

/** A handle → principal id, for filters (disabled members still match). */
async function resolveMemberLoose(db: Kysely<Database>, handle: string): Promise<string> {
  const want = handle.trim().replace(/^@/, '').toLowerCase()
  const rows = await db.selectFrom('principals').select(['id', 'handle']).execute()
  const row = rows.find((r) => r.handle.toLowerCase() === want)
  if (!row) throw new InboxError(`No member "@${want}" on this project.`, 'no_such_member')
  return row.id
}

export interface GetOptions {
  /** Only messages after this seq (incremental fetch). */
  since?: number
  /** Mark the thread read for the caller (default true; best effort). */
  markRead?: boolean
  /**
   * Only the newest N messages (with `omitted` saying how many older ones were left
   * out). The disclosure default for agents: a long thread costs its tail, not its
   * history. Omit (or 0) for everything.
   */
  tail?: number
}

/** Default `tail` for agent-facing reads (CLI `show`, MCP `inbox_get`). */
export const DEFAULT_TAIL = 20

export async function getThread(
  store: InboxStore,
  actor: InboxActor,
  ref: string,
  opts: GetOptions = {},
): Promise<ThreadView> {
  // Three independent reads in parallel: the thread (+ my read marker), its messages
  // (addressed through the same ref, so they need not wait for the thread), and the
  // principal index for "removed" flags.
  const parsed = parseThreadRef(ref)
  let threadQ = store.db
    .selectFrom('inbox_threads as t')
    .leftJoin('inbox_reads as r', (j) =>
      j.onRef('r.thread_id', '=', 't.id').on('r.principal_id', '=', actor.principalId),
    )
    .selectAll('t')
    .select(sql<number>`coalesce(r.last_read_seq, 0)`.as('last_read'))
  threadQ =
    'num' in parsed
      ? threadQ.where('t.num', '=', parsed.num)
      : threadQ.where('t.id', '=', parsed.id)
  let msgQ = store.db
    .selectFrom('inbox_messages as m')
    .innerJoin('inbox_threads as t', 't.id', 'm.thread_id')
    .selectAll('m')
    .where('m.seq', '>', opts.since ?? 0)
  msgQ = 'num' in parsed ? msgQ.where('t.num', '=', parsed.num) : msgQ.where('t.id', '=', parsed.id)
  const tail = opts.tail && opts.tail > 0 ? Math.min(opts.tail, 1000) : 0
  // With a tail: newest-first + limit, then flipped; plus the size of the whole range
  // (count and ~tokens, from body lengths) so the caller knows what it is not seeing.
  const [found, fetched, totals, index] = await Promise.all([
    threadQ.executeTakeFirst(),
    tail
      ? msgQ.orderBy('m.seq', 'desc').limit(tail).execute()
      : msgQ.orderBy('m.seq', 'asc').limit(1000).execute(),
    msgQ
      .clearSelect()
      .select([
        (eb) => eb.fn.countAll<number>().as('n'),
        sql<number>`coalesce(sum((length(m.body) + 3) / 4), 0)`.as('tokens'),
      ])
      .executeTakeFirst(),
    principalIndex(store.db),
  ])
  if (!found) throw new InboxError(`No inbox thread ${ref}.`, 'not_found')
  const messages = tail ? [...fetched].reverse() : fetched
  const { last_read, ...row } = found
  const read = { last_read_seq: Number(last_read) }
  const view: ThreadView = {
    ...toSummary(row, read.last_read_seq, index),
    refs: parseRefs(row.refs),
    messages: messages.map((m) => ({
      seq: m.seq as unknown as number,
      id: m.id,
      author: person(m.author_principal_id, m.author_handle, index),
      agentSource: m.agent_source,
      surface: m.surface,
      byAgent: m.by_agent === 1,
      type: m.type,
      event: m.event,
      body: m.body,
      createdAt: m.created_at,
    })),
    omitted: Math.max(0, Number(totals?.n ?? 0) - messages.length),
    tokenEstimate: messages.reduce((n, m) => n + estimateTokens(m.body), 0),
    totalTokenEstimate: Number(totals?.tokens ?? 0),
  }
  if (opts.markRead !== false && view.unread) {
    try {
      await runBatch(store, [markReadQuery(store.db, actor.principalId, row.id)])
    } catch {
      // Best effort: a member muted from inbox writes can still read.
    }
  }
  return view
}

export async function markRead(
  store: InboxStore,
  actor: InboxActor,
  ref: string | 'all',
): Promise<number> {
  const ids =
    ref === 'all'
      ? (await listThreads(store, actor, { box: 'all', status: 'any', limit: 500 }))
          .filter((t) => t.unread)
          .map((t) => t.id)
      : [(await loadThreadRow(store.db, ref)).id]
  if (!ids.length) return 0
  await runBatch(
    store,
    ids.map((id) => markReadQuery(store.db, actor.principalId, id)),
  )
  return ids.length
}

export interface InboxSummary {
  /** Threads in my box with activity I have not read. */
  unread: number
  /** Open/in-progress threads assigned to me. */
  assigned: number
  /** Unclaimed team-pool threads. */
  team: number
  /** My sent threads still open. */
  sent: number
  /** Highest message seq visible in my box (hook de-duplication). */
  maxSeq: number
  /** Unread threads, newest first (metadata only — no titles or bodies). */
  items: Array<{ num: number; kind: InboxKind; from: string; status: InboxStatus; urgent: boolean }>
}

export async function inboxSummary(store: InboxStore, actor: InboxActor): Promise<InboxSummary> {
  const mine = await listThreads(store, actor, { box: 'mine', status: 'active', limit: 500 })
  const me = actor.principalId
  const unread = mine.filter((t) => t.unread)
  return {
    unread: unread.length,
    assigned: mine.filter((t) => t.assignee?.id === me && OPEN_STATUSES.includes(t.status)).length,
    team: mine.filter((t) => !t.assignee && t.status === 'open').length,
    sent: mine.filter((t) => t.from.id === me && OPEN_STATUSES.includes(t.status)).length,
    maxSeq: mine.reduce((m, t) => Math.max(m, t.lastSeq), 0),
    items: unread.slice(0, 10).map((t) => ({
      num: t.num,
      kind: t.kind,
      from: t.from.handle,
      status: t.status,
      urgent: t.urgent,
    })),
  }
}

/** Addressable members: active, able to see the inbox. Handle + display name only. */
export async function listMembers(
  db: Kysely<Database>,
): Promise<Array<{ handle: string; displayName: string | null }>> {
  const rows = await db.selectFrom('principals').selectAll().orderBy('handle').execute()
  return rows
    .map(toPrincipal)
    .filter((p) => p.status === 'active' && p.capabilities.includes('inbox.read'))
    .map((p) => ({ handle: p.handle, displayName: p.displayName }))
}

// ── Writes ─────────────────────────────────────────────────────────────────────

export interface SendInput {
  /** A member handle (`@susana`) or `@team` for the pool. */
  to: string
  body: string
  title?: string
  kind?: InboxKind
  urgent?: boolean
  refs?: string[]
}

export async function sendThread(
  store: InboxStore,
  actor: InboxActor,
  input: SendInput,
): Promise<ThreadView> {
  const body = checkBody(input.body.trim())
  if (!body) throw new InboxError('A message body is required.', 'invalid')
  const title = normalizeTitle(input.title?.trim() ? input.title : firstLine(body))
  if (!title) throw new InboxError('A title is required.', 'invalid')
  const kind = input.kind ?? 'task'
  if (!INBOX_KINDS.includes(kind)) {
    throw new InboxError(`Unknown kind "${kind}" (expected ${INBOX_KINDS.join(', ')}).`, 'invalid')
  }
  const [assignee, refs, budget] = await Promise.all([
    isTeamAddress(input.to) ? null : resolveMember(store.db, input.to),
    resolveRefs(store.db, input.refs ?? []),
    writeBudget(store, actor),
  ])
  assertBudget(budget)

  const id = ulid()
  const at = now()
  await runBatch(store, [
    store.db.insertInto('inbox_threads').values({
      id,
      kind,
      title,
      status: 'open',
      urgent: input.urgent ? 1 : 0,
      from_principal_id: actor.principalId,
      from_handle: actor.handle,
      from_session: actor.session,
      assignee_principal_id: assignee?.id ?? null,
      assignee_handle: assignee?.handle ?? null,
      refs: JSON.stringify(refs),
      last_seq: 0,
      last_author_principal_id: actor.principalId,
      agent_turns: actor.byAgent ? 1 : 0,
      created_at: at,
      updated_at: at,
    }),
    store.db.insertInto('inbox_messages').values(messageValues(actor, id, body, 'message', null)),
    bumpLastSeq(store.db, id),
    markReadQuery(store.db, actor.principalId, id),
  ])
  return getThread(store, actor, id, { markRead: false })
}

/** May this actor post in / act on the thread at all? */
function isParty(actor: InboxActor, t: ThreadRow): boolean {
  return (
    t.from_principal_id === actor.principalId ||
    t.assignee_principal_id === actor.principalId ||
    t.assignee_principal_id === null ||
    isAdmin(actor)
  )
}

export interface ReplyOptions {
  /** Then claim or resolve the thread in the same call. */
  after?: 'claim' | 'resolve'
  /** Reset the agent-turn guard. Only after the user explicitly asked to continue. */
  continue?: boolean
}

export async function replyThread(
  store: InboxStore,
  actor: InboxActor,
  ref: string,
  rawBody: string,
  opts: ReplyOptions = {},
): Promise<ThreadView> {
  const body = checkBody(rawBody.trim())
  if (!body) throw new InboxError('A reply body is required.', 'invalid')
  const [t, budget] = await Promise.all([loadThreadRow(store.db, ref), writeBudget(store, actor)])
  if (!isParty(actor, t)) {
    throw new InboxError(
      `Only the sender, the assignee, or an owner/admin can reply to #${t.num}.`,
      'forbidden',
    )
  }
  if (actor.byAgent && !opts.continue && t.agent_turns >= budget.settings.agentTurns) {
    throw new InboxError(
      `#${t.num} has had ${t.agent_turns} agent messages in a row with no human reply. Stop and ask your user before continuing; if they say to go on, retry with --continue.`,
      'agent_turn_limit',
    )
  }
  assertBudget(budget)

  const turns = actor.byAgent
    ? opts.continue
      ? sql<number>`1`
      : sql<number>`agent_turns + 1`
    : sql<number>`0`
  await runBatch(store, [
    store.db.insertInto('inbox_messages').values(messageValues(actor, t.id, body, 'message', null)),
    store.db
      .updateTable('inbox_threads')
      .set({
        last_author_principal_id: actor.principalId,
        agent_turns: turns,
        updated_at: now(),
      })
      .where('id', '=', t.id),
    bumpLastSeq(store.db, t.id),
    markReadQuery(store.db, actor.principalId, t.id),
  ])
  if (opts.after) return transitionThread(store, actor, t.id, opts.after)
  return getThread(store, actor, t.id, { markRead: false })
}

export interface TransitionOptions {
  note?: string
  /** reassign: the new assignee (`@handle` or `@team`). */
  to?: string
  /** claim/unclaim: take over from another session of the same member. */
  force?: boolean
}

interface Plan {
  from: readonly InboxStatus[]
  set: Partial<Record<keyof InboxThreadsTable, unknown>>
  event: string
}

/**
 * Change a thread's state. The update is conditional on the state that was read
 * (status, assignee, claim) and is evaluated by the database that runs it — the
 * primary — so two sessions racing to claim cannot both win: the loser gets a
 * `conflict` naming the current state. The timeline event is inserted in the same
 * batch only if the update matched (`changes() = 1`).
 */
export async function transitionThread(
  store: InboxStore,
  actor: InboxActor,
  ref: string,
  action: InboxAction,
  opts: TransitionOptions = {},
): Promise<ThreadView> {
  const [t, budget] = await Promise.all([loadThreadRow(store.db, ref), writeBudget(store, actor)])
  const me = actor.principalId
  const sender = t.from_principal_id === me
  const assignee = t.assignee_principal_id === me
  const pool = t.assignee_principal_id === null
  const admin = isAdmin(actor)
  const note = opts.note?.trim() ? checkBody(opts.note.trim(), 'Note') : null
  const at = now()
  const deny = (who: string): never => {
    throw new InboxError(`Only ${who} can ${action} #${t.num}.`, 'forbidden')
  }
  const closing = (status: InboxStatus) => ({
    status,
    resolution: note,
    closed_by_principal_id: me,
    closed_by_handle: actor.handle,
    closed_at: at,
  })
  const clearClaim = { claimed_session: null, claimed_agent: null, claimed_at: null }

  let plan: Plan
  switch (action) {
    case 'claim': {
      if (!(assignee || pool)) deny('the assignee (or anyone, for a team item)')
      const takeover = opts.force && assignee
      plan = {
        from: takeover ? ['open', 'in_progress'] : ['open'],
        set: {
          status: 'in_progress',
          assignee_principal_id: me,
          assignee_handle: actor.handle,
          claimed_session: actor.session,
          claimed_agent: actor.agentSource,
          claimed_at: at,
        },
        event: 'claimed',
      }
      break
    }
    case 'unclaim': {
      if (!(assignee || admin)) deny('the assignee or an owner/admin')
      if (
        !admin &&
        !opts.force &&
        t.claimed_session &&
        actor.session &&
        t.claimed_session !== actor.session
      ) {
        throw new InboxError(
          `#${t.num} is being worked on by another of your sessions (${t.claimed_agent ?? 'unknown'}). Pass --force to take it back.`,
          'conflict',
        )
      }
      plan = { from: ['in_progress'], set: { status: 'open', ...clearClaim }, event: 'unclaimed' }
      break
    }
    case 'resolve': {
      if (!(assignee || sender || pool || admin))
        deny('the assignee, the sender, or an owner/admin')
      if (t.kind === 'ask' && !note) {
        const answered = await store.db
          .selectFrom('inbox_messages')
          .select('seq')
          .where('thread_id', '=', t.id)
          .where('type', '=', 'message')
          .where('author_principal_id', '!=', t.from_principal_id)
          .executeTakeFirst()
        if (!answered) {
          throw new InboxError(
            `#${t.num} is a question: resolve it with an answer (--note "…", or reply first).`,
            'answer_required',
          )
        }
      }
      plan = { from: OPEN_STATUSES, set: closing('resolved'), event: 'resolved' }
      break
    }
    case 'decline': {
      if (!assignee) deny('the assignee')
      if (!note) throw new InboxError('Say why you are declining (--note "…").', 'invalid')
      plan = { from: OPEN_STATUSES, set: closing('declined'), event: 'declined' }
      break
    }
    case 'cancel': {
      if (!(sender || admin)) deny('the sender or an owner/admin')
      plan = { from: OPEN_STATUSES, set: closing('cancelled'), event: 'cancelled' }
      break
    }
    case 'reopen': {
      if (t.status === 'cancelled' ? !(sender || admin) : !(sender || assignee || admin)) {
        deny(t.status === 'cancelled' ? 'the sender or an owner/admin' : 'a participant')
      }
      plan = {
        from: CLOSED_STATUSES,
        set: {
          status: 'open',
          resolution: null,
          closed_by_principal_id: null,
          closed_by_handle: null,
          closed_at: null,
          ...clearClaim,
        },
        event: 'reopened',
      }
      break
    }
    case 'reassign': {
      if (!(sender || assignee || admin)) deny('the sender, the assignee, or an owner/admin')
      if (!opts.to) throw new InboxError('Reassign to whom? Pass @handle or @team.', 'invalid')
      const next = isTeamAddress(opts.to) ? null : await resolveMember(store.db, opts.to)
      plan = {
        from: OPEN_STATUSES,
        set: {
          status: 'open',
          assignee_principal_id: next?.id ?? null,
          assignee_handle: next?.handle ?? null,
          ...clearClaim,
        },
        event: next ? `reassigned:@${next.handle}` : 'reassigned:@team',
      }
      break
    }
    default:
      throw new InboxError(`Unknown action "${action as string}".`, 'invalid')
  }

  if (!plan.from.includes(t.status)) {
    throw new InboxError(stateMessage(t, `cannot ${action}`), 'conflict')
  }
  assertBudget(budget)

  // Optimistic guard: the row must still be in the state the decision was based on.
  let update = store.db
    .updateTable('inbox_threads')
    .set({ ...(plan.set as object), updated_at: at })
    .where('id', '=', t.id)
    .where('status', '=', t.status)
  update = t.assignee_principal_id
    ? update.where('assignee_principal_id', '=', t.assignee_principal_id)
    : update.where('assignee_principal_id', 'is', null)
  update = t.claimed_session
    ? update.where('claimed_session', '=', t.claimed_session)
    : update.where('claimed_session', 'is', null)

  const msg = messageValues(actor, t.id, note ?? '', 'event', plan.event)
  const insertEvent = store.db
    .insertInto('inbox_messages')
    .columns(Object.keys(msg) as Array<keyof typeof msg>)
    .expression(
      store.db
        .selectNoFrom(
          (Object.entries(msg) as Array<[string, unknown]>).map(([k, v]) => sql.val(v).as(k)),
        )
        .where(sql<number>`changes()`, '=', 1),
    )

  const results = await runBatch(store, [
    update,
    insertEvent,
    bumpLastSeq(store.db, t.id),
    markReadQuery(store.db, me, t.id),
  ])
  if ((results[0]?.rowsAffected ?? 0) === 0) {
    const current = await loadThreadRow(store.db, t.id)
    throw new InboxError(stateMessage(current, `${action} lost a race`), 'conflict')
  }
  return getThread(store, actor, t.id, { markRead: false })
}

function stateMessage(t: ThreadRow, what: string): string {
  const who = t.closed_by_handle ? ` by @${t.closed_by_handle}` : ''
  const claim =
    t.status === 'in_progress' && t.claimed_agent
      ? ` (claimed by @${t.assignee_handle} via ${t.claimed_agent})`
      : ''
  return `#${t.num} ${what}: it is ${t.status.replace('_', ' ')}${who}${claim}.`
}
