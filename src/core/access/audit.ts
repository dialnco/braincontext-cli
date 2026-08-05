import type { Kysely } from 'kysely'
import { withWriteRetry } from '../tx'
import type { AccessLogTable, Database } from '../types'

export type Surface = 'cli' | 'studio' | 'mcp'

export interface AccessLogEntry {
  principalId?: string | null
  handle?: string | null
  agentSource?: string | null
  surface: Surface
  /** The command path or route that was attempted, e.g. `wiki new`. */
  action: string
  targetType?: string | null
  targetId?: string | null
  decision: 'allow' | 'deny'
  /** Serialized to JSON. Keep it small — this row travels to the remote primary. */
  detail?: unknown
}

export interface AccessLogRow {
  id: number
  at: string
  principalId: string | null
  handle: string | null
  agentSource: string | null
  surface: string
  action: string
  targetType: string | null
  targetId: string | null
  decision: 'allow' | 'deny'
  detail: string | null
}

/**
 * Append an access decision.
 *
 * Best effort by design: a store that can't take the log row (a read-only
 * connection, a full disk, a racing writer) must not turn a permitted operation
 * into a failed one. A missing audit row is a smaller problem than a CLI that
 * refuses to work.
 */
export async function logAccess(db: Kysely<Database>, entry: AccessLogEntry): Promise<void> {
  try {
    await withWriteRetry(db, async (trx) => {
      await trx
        .insertInto('access_log')
        .values({
          at: new Date().toISOString(),
          principal_id: entry.principalId ?? null,
          handle: entry.handle ?? null,
          agent_source: entry.agentSource ?? null,
          surface: entry.surface,
          action: entry.action,
          target_type: entry.targetType ?? null,
          target_id: entry.targetId ?? null,
          decision: entry.decision,
          detail: entry.detail === undefined ? null : JSON.stringify(entry.detail),
        })
        .execute()
    })
  } catch {
    // See the doc comment: never let audit bookkeeping fail the operation.
  }
}

export interface AccessLogFilter {
  limit?: number
  /** Case-insensitive handle match. */
  handle?: string
  denyOnly?: boolean
  /** ISO instant; only entries at or after it. */
  since?: string
}

function toRow(r: AccessLogTable & { id: number }): AccessLogRow {
  return {
    id: r.id,
    at: r.at,
    principalId: r.principal_id,
    handle: r.handle,
    agentSource: r.agent_source,
    surface: r.surface,
    action: r.action,
    targetType: r.target_type,
    targetId: r.target_id,
    decision: r.decision,
    detail: r.detail,
  }
}

export async function listAccessLog(
  db: Kysely<Database>,
  filter: AccessLogFilter = {},
): Promise<AccessLogRow[]> {
  let q = db.selectFrom('access_log').selectAll()
  if (filter.denyOnly) q = q.where('decision', '=', 'deny')
  if (filter.since) q = q.where('at', '>=', filter.since)
  if (filter.handle) {
    const want = filter.handle.toLowerCase()
    q = q.where((eb) => eb(eb.fn('lower', ['handle']), '=', want))
  }
  const rows = await q
    .orderBy('id', 'desc')
    .limit(filter.limit ?? 50)
    .execute()
  return rows.map((r) => toRow(r as AccessLogTable & { id: number }))
}
