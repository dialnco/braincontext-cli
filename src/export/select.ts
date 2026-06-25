import type { Kysely } from 'kysely'
import { type Context, type ListFilters, listContexts } from '../core/contexts'
import type { Database } from '../core/types'

/** Gather the contexts to export (non-deleted), honoring the same filters as `list`. */
export async function selectContexts(
  db: Kysely<Database>,
  filters: ListFilters,
): Promise<Context[]> {
  return listContexts(db, { ...filters, includeDeleted: false, limit: filters.limit ?? 1000 })
}
