import type { Kysely } from 'kysely'
import { serializeTable } from '../lib/mdtable'
import { parseTransclusions } from '../lib/wikilinks'
import type { Context } from './contexts'
import type { Database } from './types'
import { createPage, resolvePageRef } from './wiki'

/**
 * A datatable is a wiki page (page_type='datatable') whose BODY is a single canonical GFM
 * table — so it reuses FTS, peek, history, export, and the wiki_table_* cell/row ops for
 * free. Other pages embed it with `![[Title]]` (a reserved `embeds` link), so one table
 * backs N pages: edit it once and every consumer reflects it. See src/core/tables.ts.
 */

export interface CreateDatatableInput {
  title: string
  columns: string[]
  rows?: string[][]
  namespace?: string
  tags?: string[]
  agentSource?: string | null
}

export async function createDatatable(
  db: Kysely<Database>,
  input: CreateDatatableInput,
): Promise<Context> {
  const body = serializeTable({
    header: input.columns,
    alignments: input.columns.map(() => null),
    rows: input.rows ?? [],
  })
  return createPage(db, {
    title: input.title,
    pageType: 'datatable',
    body,
    namespace: input.namespace,
    tags: input.tags,
    agentSource: input.agentSource,
  })
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Expand `![[Title]]` transclusions in a body to the embedded page's body (one level — an
 * embed inside embedded content is left as-is, so a cycle can't loop). Unresolved embeds
 * are left verbatim (a "wanted" embed). Read-only: never mutates the stored body.
 */
export async function expandTransclusions(db: Kysely<Database>, body: string): Promise<string> {
  let out = body
  for (const title of parseTransclusions(body)) {
    const target = await resolvePageRef(db, title)
    if (!target) continue
    const re = new RegExp(`!\\[\\[\\s*${escapeRegExp(title)}\\s*(\\|[^\\]]*)?\\]\\]`, 'g')
    out = out.replace(re, () => target.body)
  }
  return out
}
