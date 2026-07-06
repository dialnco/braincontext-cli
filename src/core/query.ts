import { type Kysely, type Selectable, sql } from 'kysely'
import { serializeTable } from '../lib/mdtable'
import { type Context, tagsByContext, toContext } from './contexts'
import { type PropValue, readProps } from './properties'
import type { ContextsTable, Database } from './types'

type ContextRow = Selectable<ContextsTable>

/**
 * A per-key comparison. A bare scalar in a WhereClause is shorthand for `{ eq: scalar }`.
 * `lt/gt/lte/gte` compare numerically (CAST value AS REAL); `contains` is a substring match;
 * `in` matches any of the listed values; `exists` tests only for the key's presence.
 * `ne` and `exists:false` are the two "absent counts as a match" operators (NOT EXISTS).
 */
export interface Comparison {
  eq?: PropValue
  ne?: PropValue
  lt?: number
  gt?: number
  lte?: number
  gte?: number
  contains?: string
  in?: PropValue[]
  exists?: boolean
}

/** Each key is ANDed. Value is a scalar (implicit eq) or a {@link Comparison}. */
export type WhereClause = Record<string, PropValue | Comparison>

export interface WikiQuery {
  where?: WhereClause
  sort?: { key: string; dir?: 'asc' | 'desc'; numeric?: boolean }
  limit?: number
}

class QueryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QueryError'
  }
}

function isComparison(v: PropValue | Comparison): v is Comparison {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** SQL fragment matching a page_properties row whose value equals the given scalar. */
function eqValueSql(v: PropValue) {
  if (typeof v === 'number') return sql`CAST(pp.value AS REAL) = ${v}`
  if (typeof v === 'boolean') return sql`pp.value = ${v ? 'true' : 'false'}`
  return sql`pp.value = ${v}`
}

/** Escape LIKE wildcards so `contains` treats %/_ literally. */
function likeContains(s: string): string {
  return `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}

/** An EXISTS/NOT-EXISTS predicate over page_properties for one (key, condition). */
function keyPredicate(key: string, cond: PropValue | Comparison) {
  const c: Comparison = isComparison(cond) ? cond : { eq: cond }
  const exists = (inner: ReturnType<typeof sql>) =>
    sql`EXISTS (SELECT 1 FROM page_properties pp WHERE pp.context_id = c.id AND pp.key = ${key} AND ${inner})`
  const notExists = (inner: ReturnType<typeof sql>) =>
    sql`NOT EXISTS (SELECT 1 FROM page_properties pp WHERE pp.context_id = c.id AND pp.key = ${key} AND ${inner})`

  const clauses: ReturnType<typeof sql>[] = []
  if (c.eq !== undefined) clauses.push(exists(eqValueSql(c.eq)))
  // ne / exists:false match pages that LACK a row with that value (absent counts as a match).
  if (c.ne !== undefined) clauses.push(notExists(eqValueSql(c.ne)))
  if (c.lt !== undefined) clauses.push(exists(sql`CAST(pp.value AS REAL) < ${c.lt}`))
  if (c.gt !== undefined) clauses.push(exists(sql`CAST(pp.value AS REAL) > ${c.gt}`))
  if (c.lte !== undefined) clauses.push(exists(sql`CAST(pp.value AS REAL) <= ${c.lte}`))
  if (c.gte !== undefined) clauses.push(exists(sql`CAST(pp.value AS REAL) >= ${c.gte}`))
  if (c.contains !== undefined)
    clauses.push(exists(sql`pp.value LIKE ${likeContains(c.contains)} ESCAPE '\\'`))
  if (c.in !== undefined) {
    if (c.in.length === 0)
      clauses.push(sql`0`) // IN () matches nothing
    else clauses.push(exists(sql`pp.value IN (${sql.join(c.in.map((v) => sql`${String(v)}`))})`))
  }
  if (c.exists !== undefined)
    clauses.push(
      c.exists
        ? sql`EXISTS (SELECT 1 FROM page_properties pp WHERE pp.context_id = c.id AND pp.key = ${key})`
        : sql`NOT EXISTS (SELECT 1 FROM page_properties pp WHERE pp.context_id = c.id AND pp.key = ${key})`,
    )

  if (clauses.length === 0) throw new QueryError(`empty condition for property "${key}"`)
  return sql`(${sql.join(clauses, sql` AND `)})`
}

/**
 * Query wiki pages by their derived properties. Every `where` key is ANDed; results are live
 * (non-deleted) wiki pages, deterministically ordered (by `sort` when given, else newest id).
 */
export async function queryPages(db: Kysely<Database>, q: WikiQuery): Promise<Context[]> {
  const conditions = [sql`c.deleted_at IS NULL`, sql`c.page_type IS NOT NULL`]
  for (const [key, cond] of Object.entries(q.where ?? {})) conditions.push(keyPredicate(key, cond))
  const where = sql.join(conditions, sql` AND `)

  // Sort via a correlated lookup so pages missing the key still appear (NULL sorts last here).
  let orderBy = sql`c.id DESC`
  if (q.sort) {
    const dir = q.sort.dir === 'asc' ? sql`ASC` : sql`DESC`
    const lookup = sql`(SELECT value FROM page_properties WHERE context_id = c.id AND key = ${q.sort.key})`
    const keyExpr = q.sort.numeric ? sql`CAST(${lookup} AS REAL)` : lookup
    orderBy = sql`${keyExpr} IS NULL, ${keyExpr} ${dir}, c.id DESC`
  }
  const limit = q.limit ?? 100

  const result = await sql<ContextRow>`
    SELECT c.* FROM contexts c
    WHERE ${where}
    ORDER BY ${orderBy}
    LIMIT ${limit}
  `.execute(db)

  const rows = result.rows
  const tagMap = await tagsByContext(
    db,
    rows.map((r) => r.id),
  )
  return rows.map((r) => toContext(r, tagMap.get(r.id) ?? []))
}

/** A distinct property key across the wiki, with how many live pages carry it. */
export interface PropertyKeyInfo {
  key: string
  count: number
  types: string[]
}

/** Discover the queryable property keys (for `wiki list-properties` / query building). */
export async function listProperties(db: Kysely<Database>): Promise<PropertyKeyInfo[]> {
  const rows = await db
    .selectFrom('page_properties as pp')
    .innerJoin('contexts as c', 'c.id', 'pp.context_id')
    .where('c.deleted_at', 'is', null)
    .select('pp.key as key')
    .select('pp.type as type')
    .select((eb) => eb.fn.count<number>('pp.context_id').as('count'))
    .groupBy(['pp.key', 'pp.type'])
    .orderBy('pp.key')
    .execute()
  const byKey = new Map<string, PropertyKeyInfo>()
  for (const r of rows) {
    const info = byKey.get(r.key) ?? { key: r.key, count: 0, types: [] }
    info.count += Number(r.count)
    if (!info.types.includes(r.type)) info.types.push(r.type)
    byKey.set(r.key, info)
  }
  return [...byKey.values()]
}

/** A saved view's stored definition (lives in a `view` page's metadata). */
export interface ViewDef {
  query: WikiQuery
  columns: string[]
}

/** Read a view page's metadata into a {@link ViewDef} (defaults tolerate hand-edits). */
export function parseViewDef(metadata: Record<string, unknown>): ViewDef {
  const query = (metadata.query ?? {}) as WikiQuery
  const columns = Array.isArray(metadata.columns)
    ? (metadata.columns as unknown[]).filter((x): x is string => typeof x === 'string')
    : []
  return { query, columns }
}

/**
 * Render a saved view to a GFM table: run its query and project `[[Title]]` + each column
 * from the matching pages' properties. Generated on read/export (like the index), so it
 * always reflects the current graph — the stored body is only a cached snapshot.
 */
export async function renderView(
  db: Kysely<Database>,
  metadata: Record<string, unknown>,
): Promise<string> {
  const { query, columns } = parseViewDef(metadata)
  const pages = await queryPages(db, query)
  const header = ['Page', ...columns]
  const rows = pages.map((p) => {
    const props = readProps(p.metadata)
    const cells = columns.map((col) => {
      const v = props[col]
      return v === undefined ? '' : String(v)
    })
    return [`[[${p.title ?? p.slug ?? p.id}]]`, ...cells]
  })
  const table = serializeTable({ header, alignments: header.map(() => null), rows })
  return `${table}\n\n_${pages.length} page(s) · generated view_`
}
