import { sql } from 'kysely'
import type { InboxKind, InboxStatus } from '../types'
import { InboxError } from './errors'
import { CLOSED_STATUSES, type InboxActor, type InboxStore, parseThreadRef } from './threads'

/** One new message, as metadata only — bodies are fetched explicitly with `show`. */
export interface WaitHit {
  seq: number
  num: number
  threadId: string
  kind: InboxKind
  status: InboxStatus
  author: string
  agentSource: string | null
  type: 'message' | 'event'
  event: string | null
}

export interface WaitResult {
  /** `messages` → exit 0, `timeout` → exit 2, `closed` → exit 3. */
  outcome: 'messages' | 'timeout' | 'closed'
  hits: WaitHit[]
  /** Pass back as `--since` to resume without a gap. */
  nextSince: number
  /** The waited-on thread, when `thread` was given. */
  thread: { num: number; status: InboxStatus } | null
}

export interface WaitOptions {
  /** Only this thread (a conversation). */
  thread?: string
  /** Resume after this seq. Default: "now" — the newest seq at the moment of the call. */
  since?: number
  timeoutMs?: number
  /** Poll interval while active; backs off to `idlePollMs` after `backoffAfterMs`. */
  pollMs?: number
  idlePollMs?: number
  backoffAfterMs?: number
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export const WAIT_EXIT = { messages: 0, timeout: 2, closed: 3 } as const

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * Block until a message I should see arrives, then return its metadata.
 *
 * Polls the primary by `seq` — the cursor is explicit, never the per-member read
 * marker, so another of my sessions reading a thread cannot "steal" a wake-up.
 * What counts as mine: threads I sent, threads assigned to me, and team-pool
 * threads. My own session's messages never wake me; messages from my OTHER
 * sessions do (a todo I sent myself from another session must arrive). With no
 * session id, anything I authored without one is treated as my own.
 */
export async function waitForMessages(
  store: InboxStore,
  actor: InboxActor,
  opts: WaitOptions = {},
): Promise<WaitResult> {
  const sleep = opts.sleep ?? realSleep
  const clock = opts.now ?? Date.now
  const timeoutMs = opts.timeoutMs ?? 300_000
  const pollMs = opts.pollMs ?? 3000
  const idlePollMs = opts.idlePollMs ?? 10_000
  const backoffAfterMs = opts.backoffAfterMs ?? 60_000
  const me = actor.principalId

  let threadId: string | null = null
  let threadNum: number | null = null
  if (opts.thread) {
    const ref = parseThreadRef(opts.thread)
    let q = store.db.selectFrom('inbox_threads').select(['id', 'num'])
    q = 'num' in ref ? q.where('num', '=', ref.num) : q.where('id', '=', ref.id)
    const row = await q.executeTakeFirst()
    if (!row) throw new InboxError(`No inbox thread ${opts.thread}.`, 'not_found')
    threadId = row.id
    threadNum = row.num as unknown as number
  }

  let cursor = opts.since
  if (cursor === undefined) {
    const row = await store.db
      .selectFrom('inbox_messages')
      .select(sql<number>`coalesce(max(seq), 0)`.as('m'))
      .executeTakeFirst()
    cursor = Number(row?.m ?? 0)
  }

  const threadStatus = async (): Promise<InboxStatus | null> => {
    if (!threadId) return null
    const row = await store.db
      .selectFrom('inbox_threads')
      .select('status')
      .where('id', '=', threadId)
      .executeTakeFirst()
    return row?.status ?? null
  }

  const started = clock()
  for (;;) {
    let q = store.db
      .selectFrom('inbox_messages as m')
      .innerJoin('inbox_threads as t', 't.id', 'm.thread_id')
      .select([
        'm.seq',
        't.num',
        'm.thread_id',
        't.kind',
        't.status',
        'm.author_handle',
        'm.agent_source',
        'm.type',
        'm.event',
      ])
      .where('m.seq', '>', cursor)
      .where((eb) =>
        eb.or([
          eb('t.from_principal_id', '=', me),
          eb('t.assignee_principal_id', '=', me),
          eb('t.assignee_principal_id', 'is', null),
        ]),
      )
    q = actor.session
      ? q.where((eb) =>
          eb.or([eb('m.author_session', 'is', null), eb('m.author_session', '!=', actor.session)]),
        )
      : q.where((eb) =>
          eb.or([eb('m.author_principal_id', '!=', me), eb('m.author_session', 'is not', null)]),
        )
    if (threadId) q = q.where('m.thread_id', '=', threadId)
    const rows = await q.orderBy('m.seq', 'asc').limit(100).execute()

    const status = await threadStatus()
    const thread = threadNum !== null && status ? { num: threadNum, status } : null
    const closed = !!status && CLOSED_STATUSES.includes(status)

    if (rows.length) {
      const hits: WaitHit[] = rows.map((r) => ({
        seq: Number(r.seq),
        num: Number(r.num),
        threadId: r.thread_id,
        kind: r.kind,
        status: r.status,
        author: r.author_handle,
        agentSource: r.agent_source,
        type: r.type,
        event: r.event,
      }))
      return {
        outcome: closed ? 'closed' : 'messages',
        hits,
        nextSince: hits[hits.length - 1]?.seq ?? cursor,
        thread,
      }
    }
    if (closed) return { outcome: 'closed', hits: [], nextSince: cursor, thread }

    const elapsed = clock() - started
    if (elapsed >= timeoutMs) return { outcome: 'timeout', hits: [], nextSince: cursor, thread }
    const interval = elapsed >= backoffAfterMs ? idlePollMs : pollMs
    await sleep(Math.min(interval, Math.max(0, timeoutMs - elapsed)))
  }
}
