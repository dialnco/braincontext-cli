import { type Kysely, sql } from 'kysely'
import type { Database } from './types'

/**
 * Tables copied during an online seed, in FK-dependency (insert) order.
 *
 * `contexts_fts` and its FTS5 shadow tables are intentionally excluded: the INSERT
 * trigger on `contexts` rebuilds the full-text index on the destination as rows
 * land, so copying them would be redundant (and corrupt the shadow layout).
 */
const SEED_TABLES = [
  'contexts',
  'tags',
  'context_tags',
  'context_history',
  'skill_files',
  'links',
  'wiki_log',
] as const

function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

/** libSQL returns BLOBs as ArrayBuffer; coerce to Buffer so they re-bind as BLOBs. */
function normalize(v: unknown): unknown {
  if (v instanceof ArrayBuffer) return Buffer.from(v)
  if (ArrayBuffer.isView(v) && !Buffer.isBuffer(v)) {
    return Buffer.from(v.buffer, v.byteOffset, v.byteLength)
  }
  return v
}

export type SeedCounts = Record<string, number>

/** Count non-deleted-aware total rows in `contexts` (used to guard a non-empty target). */
export async function contextRowCount(db: Kysely<Database>): Promise<number> {
  const r = await sql<{ n: number }>`SELECT count(*) AS n FROM contexts`.execute(db)
  return Number(r.rows[0]?.n ?? 0)
}

/**
 * Copy every row from `src` into `dest` (already migrated, expected empty),
 * preserving ids and autoincrement values so the copy is byte-faithful. Runs in
 * one transaction on `dest`; inserting `contexts` re-derives the FTS index there.
 */
export async function seedDatabase(
  src: Kysely<Database>,
  dest: Kysely<Database>,
): Promise<SeedCounts> {
  const counts: SeedCounts = {}
  await dest.transaction().execute(async (trx) => {
    for (const table of SEED_TABLES) {
      const read = await sql<Record<string, unknown>>`SELECT * FROM ${sql.raw(
        ident(table),
      )}`.execute(src)
      counts[table] = read.rows.length
      for (const row of read.rows) {
        const cols = Object.keys(row)
        if (cols.length === 0) continue
        const colList = sql.join(cols.map((c) => sql.raw(ident(c))))
        const valList = sql.join(cols.map((c) => sql`${normalize(row[c])}`))
        await sql`INSERT INTO ${sql.raw(ident(table))} (${colList}) VALUES (${valList})`.execute(
          trx,
        )
      }
    }
  })
  return counts
}
