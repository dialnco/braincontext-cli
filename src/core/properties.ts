import type { Kysely } from 'kysely'
import type { Database } from './types'

/** Local metadata parse (kept here to avoid a contexts.ts <-> properties.ts import cycle). */
function parseMetadata(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/**
 * Typed page properties ("frontmatter" fields you can query over) live under this single
 * metadata key, kept apart from internal bookkeeping (sources/sourceHashes/verifiedAt/uri).
 * A page's props are `metadata.props: Record<string, string|number|boolean>`.
 */
export const PROPS_KEY = 'props'

export type PropValue = string | number | boolean
export type PropType = 'string' | 'number' | 'boolean'

interface StoredProp {
  value: string
  type: PropType
}

/** Canonicalize a prop value to its stored string form + type tag. Non-scalars are dropped. */
function toStored(value: unknown): StoredProp | null {
  if (typeof value === 'number' && Number.isFinite(value))
    return { value: String(value), type: 'number' }
  if (typeof value === 'boolean') return { value: value ? 'true' : 'false', type: 'boolean' }
  if (typeof value === 'string') return { value, type: 'string' }
  return null // arrays/objects/null aren't queryable scalars
}

/** Read a page's `metadata.props` as a clean scalar record (drops non-scalar values). */
export function readProps(metadata: Record<string, unknown>): Record<string, PropValue> {
  const raw = metadata[PROPS_KEY]
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, PropValue> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string' || typeof v === 'boolean') out[k] = v
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
  }
  return out
}

/** True for the one benign error: a store whose 0002 migration hasn't created the table yet. */
function isMissingPropsTable(e: unknown): boolean {
  return /no such table:?\s*(main\.)?page_properties/i.test(String((e as Error)?.message ?? e))
}

/**
 * Rebuild the derived `page_properties` rows for one context from its metadata JSON, inside
 * the caller's write transaction. Delete-then-reinsert (fully derived, unconditional), so it
 * mirrors `syncBodyLinks`: whatever is in `metadata.props` right now IS the property set.
 *
 * This runs on the UNIVERSAL context write path. The `0002_page_properties` migration creates
 * the table on next open of any existing store, but as defense-in-depth (e.g. a remote/replica
 * where migration races a write, or a hand-restored file) a missing table must not blow up
 * every write. The mirror is non-authoritative, so it degrades gracefully: writes still
 * succeed and `wiki query` simply returns nothing until the migration lands.
 */
export async function rebuildPageProperties(
  trx: Kysely<Database>,
  id: string,
  metadataJson: string,
): Promise<void> {
  try {
    await trx.deleteFrom('page_properties').where('context_id', '=', id).execute()
    const props = readProps(parseMetadata(metadataJson))
    const rows: Database['page_properties'][] = []
    for (const [key, raw] of Object.entries(props)) {
      const stored = toStored(raw)
      if (!stored) continue
      rows.push({ context_id: id, key, value: stored.value, type: stored.type })
    }
    if (rows.length > 0) await trx.insertInto('page_properties').values(rows).execute()
  } catch (e) {
    if (!isMissingPropsTable(e)) throw e // a real fault still propagates + rolls back
  }
}
