import type { Kysely } from 'kysely'
import {
  type Align,
  addColumnData,
  addRowData,
  columnIndex,
  deleteColumnData,
  deleteRowData,
  parseTables,
  renameColumnData,
  replaceTableInBody,
  rowIndexByKey,
  setCellData,
  setColumnAlignData,
  type Table,
} from '../lib/mdtable'
import type { Context } from './contexts'
import type { Database } from './types'
import { createPage, getPageByTitle, resolvePageRef, updatePage } from './wiki'

/**
 * Cell/row-granular edits to a GFM table living inside a wiki page body. Every mutation
 * funnels through `updatePage` so history, the FTS mirror, and `[[link]]` re-sync all fire
 * (anti-drift held) — an agent changes ONE cell instead of re-emitting the whole body.
 *
 * A datatable page (page_type='datatable', Phase 3) is body-canonical — its body IS one GFM
 * table — so these same ops (with the sole-table locator) drive it and any inline page table.
 */

/** Loud, catchable failure for an unresolvable/ambiguous locator (never a silent wrong edit). */
export class TableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TableError'
  }
}

/** Pick a table on a page by caption (its heading) or 0-based index. */
export interface TableLocator {
  caption?: string
  tableIndex?: number
}

export interface TableView {
  pageId: string
  slug: string | null
  /** Revision to pass back as `ifRev` on a follow-up edit (optimistic concurrency). */
  rev: string
  tableIndex: number
  headingAbove: string | null
  header: string[]
  alignments: Array<Align | null>
  rows: string[][]
}

export interface TableWriteOpts {
  ifRev?: string
  agentSource?: string | null
}

function locate(tables: Table[], loc: TableLocator): { table: Table; index: number } {
  if (tables.length === 0) throw new TableError('this page has no tables')
  if (loc.tableIndex !== undefined) {
    const table = tables[loc.tableIndex]
    if (!table) {
      throw new TableError(
        `table index ${loc.tableIndex} is out of range (page has ${tables.length} table(s))`,
      )
    }
    return { table, index: loc.tableIndex }
  }
  if (loc.caption !== undefined) {
    const norm = loc.caption.trim().toLowerCase()
    const hits = tables
      .map((table, index) => ({ table, index }))
      .filter((h) => (h.table.headingAbove ?? '').trim().toLowerCase() === norm)
    const first = hits[0]
    if (!first) throw new TableError(`no table found under caption "${loc.caption}"`)
    if (hits.length > 1) {
      throw new TableError(
        `caption "${loc.caption}" matches ${hits.length} tables — pass tableIndex to disambiguate`,
      )
    }
    return { table: first.table, index: first.index }
  }
  if (tables.length > 1) {
    throw new TableError(
      `page has ${tables.length} tables — pass a caption or tableIndex to pick one`,
    )
  }
  // exactly one table
  const only = tables[0]
  if (!only) throw new TableError('this page has no tables')
  return { table: only, index: 0 }
}

async function loadTable(
  db: Kysely<Database>,
  ref: string,
  loc: TableLocator,
): Promise<{ page: Context; table: Table; index: number }> {
  const page = await resolvePageRef(db, ref)
  if (!page) throw new TableError(`no wiki page matching "${ref}"`)
  const { table, index } = locate(parseTables(page.body), loc)
  return { page, table, index }
}

function resolveColumn(table: Table, column: string): number {
  const c = columnIndex(table, column)
  if (c < 0) {
    throw new TableError(`no column "${column}" (headers: ${table.header.join(', ') || '<none>'})`)
  }
  return c
}

function resolveRow(table: Table, rowKey: string): number {
  const r = rowIndexByKey(table, rowKey)
  if (r < 0) throw new TableError(`no row matching "${rowKey}" in the table`)
  return r
}

/** Read a table as structured data (no page body) — the cheap peek before an edit. */
export async function tableGet(
  db: Kysely<Database>,
  ref: string,
  loc: TableLocator = {},
): Promise<TableView> {
  const { page, table, index } = await loadTable(db, ref, loc)
  return {
    pageId: page.id,
    slug: page.slug,
    rev: page.rev,
    tableIndex: index,
    headingAbove: table.headingAbove,
    header: table.header,
    alignments: table.alignments,
    rows: table.rows,
  }
}

async function writeTable(
  db: Kysely<Database>,
  page: Context,
  table: Table,
  next: Parameters<typeof replaceTableInBody>[2],
  opts: TableWriteOpts,
): Promise<Context> {
  // A source page's body is an immutable ingest artifact — refuse loudly here (reads via
  // `tableGet` still work) rather than let `updatePage` throw a less specific error.
  if (page.pageType === 'source') {
    throw new TableError('source pages are immutable — cannot edit their tables')
  }
  const body = replaceTableInBody(page.body, table, next)
  const updated = await updatePage(db, page.id, {
    body,
    ifRev: opts.ifRev,
    agentSource: opts.agentSource ?? undefined,
  })
  if (!updated) throw new TableError(`no wiki page matching id "${page.id}"`)
  return updated
}

/** Set one cell (addressed by row-key + column-name), leaving every other cell byte-identical. */
export async function tableSetCell(
  db: Kysely<Database>,
  ref: string,
  loc: TableLocator,
  rowKey: string,
  column: string,
  value: string,
  opts: TableWriteOpts = {},
): Promise<Context> {
  const { page, table } = await loadTable(db, ref, loc)
  const next = setCellData(table, resolveRow(table, rowKey), resolveColumn(table, column), value)
  return writeTable(db, page, table, next, opts)
}

/** Append a row; `cells` are aligned to the header order (missing trailing cells → empty). */
export async function tableAddRow(
  db: Kysely<Database>,
  ref: string,
  loc: TableLocator,
  cells: string[],
  opts: TableWriteOpts = {},
): Promise<Context> {
  const { page, table } = await loadTable(db, ref, loc)
  return writeTable(db, page, table, addRowData(table, cells), opts)
}

/** Delete the row matching `rowKey` (first-column value, else ordinal). */
export async function tableDeleteRow(
  db: Kysely<Database>,
  ref: string,
  loc: TableLocator,
  rowKey: string,
  opts: TableWriteOpts = {},
): Promise<Context> {
  const { page, table } = await loadTable(db, ref, loc)
  return writeTable(db, page, table, deleteRowData(table, resolveRow(table, rowKey)), opts)
}

// --- index-addressed ops (unambiguous for a grid: no row-key/ordinal resolution) ----------

function checkRow(table: Table, rowIndex: number): void {
  if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= table.rows.length) {
    throw new TableError(
      `row index ${rowIndex} is out of range (table has ${table.rows.length} row(s))`,
    )
  }
}

function checkCol(table: Table, colIndex: number): void {
  if (!Number.isInteger(colIndex) || colIndex < 0 || colIndex >= table.header.length) {
    throw new TableError(
      `column index ${colIndex} is out of range (table has ${table.header.length} column(s))`,
    )
  }
}

/** Set one cell by numeric row+column index (the grid's unambiguous addressing). */
export async function tableSetCellAt(
  db: Kysely<Database>,
  ref: string,
  loc: TableLocator,
  rowIndex: number,
  colIndex: number,
  value: string,
  opts: TableWriteOpts = {},
): Promise<Context> {
  const { page, table } = await loadTable(db, ref, loc)
  checkRow(table, rowIndex)
  checkCol(table, colIndex)
  return writeTable(db, page, table, setCellData(table, rowIndex, colIndex, value), opts)
}

/** Delete the row at a numeric index. */
export async function tableDeleteRowAt(
  db: Kysely<Database>,
  ref: string,
  loc: TableLocator,
  rowIndex: number,
  opts: TableWriteOpts = {},
): Promise<Context> {
  const { page, table } = await loadTable(db, ref, loc)
  checkRow(table, rowIndex)
  return writeTable(db, page, table, deleteRowData(table, rowIndex), opts)
}

export interface AddColumnInput {
  name: string
  /** 0-based insert position; appends when omitted. */
  at?: number
  align?: Align | null
}

/** Insert a column (appends when `at` is omitted), padding every row with an empty cell. */
export async function tableAddColumn(
  db: Kysely<Database>,
  ref: string,
  loc: TableLocator,
  input: AddColumnInput,
  opts: TableWriteOpts = {},
): Promise<Context> {
  const { page, table } = await loadTable(db, ref, loc)
  if (
    input.at !== undefined &&
    (!Number.isInteger(input.at) || input.at < 0 || input.at > table.header.length)
  ) {
    throw new TableError(`column position ${input.at} is out of range (0..${table.header.length})`)
  }
  const next = addColumnData(table, input.at, input.name ?? '', input.align ?? null)
  return writeTable(db, page, table, next, opts)
}

/** Delete the column at a numeric index (refuses removing the last column). */
export async function tableDeleteColumn(
  db: Kysely<Database>,
  ref: string,
  loc: TableLocator,
  colIndex: number,
  opts: TableWriteOpts = {},
): Promise<Context> {
  const { page, table } = await loadTable(db, ref, loc)
  checkCol(table, colIndex)
  if (table.header.length <= 1) throw new TableError('cannot delete the last column of a table')
  return writeTable(db, page, table, deleteColumnData(table, colIndex), opts)
}

/** Rename one column header (cells + alignment untouched). */
export async function tableRenameColumn(
  db: Kysely<Database>,
  ref: string,
  loc: TableLocator,
  colIndex: number,
  name: string,
  opts: TableWriteOpts = {},
): Promise<Context> {
  const { page, table } = await loadTable(db, ref, loc)
  checkCol(table, colIndex)
  return writeTable(db, page, table, renameColumnData(table, colIndex, name), opts)
}

/** Set one column's alignment (left/right/center or null for default). */
export async function tableSetColumnAlign(
  db: Kysely<Database>,
  ref: string,
  loc: TableLocator,
  colIndex: number,
  align: Align | null,
  opts: TableWriteOpts = {},
): Promise<Context> {
  const { page, table } = await loadTable(db, ref, loc)
  checkCol(table, colIndex)
  return writeTable(db, page, table, setColumnAlignData(table, colIndex, align), opts)
}

export interface ExtractResult {
  /** The new datatable page holding the extracted table. */
  datatable: Context
  /** The source page, now with a `![[Title]]` embed where the table was. */
  page: Context
}

/**
 * Extract a table out of a page into its own `datatable` page, leaving a `![[Title]]`
 * transclusion where the table was — so the page reads identically (the embed re-renders the
 * table on read) but the data is now centralized, queryable, and reusable across pages.
 *
 * The table body is copied VERBATIM (alignment, escaped pipes, and any `[[wikilinks]]` in
 * cells preserved); any heading above the table stays on the source page, above the embed.
 * Goes through createPage + updatePage so history / link re-sync / rev all fire. Refuses on an
 * immutable source page or a title collision. Creates the datatable FIRST, so if the source
 * update fails the table is never lost (at worst an orphan datatable, never a hole in the page).
 */
export async function extractTableToDatatable(
  db: Kysely<Database>,
  ref: string,
  loc: TableLocator,
  input: { title: string; namespace?: string; agentSource?: string | null; ifRev?: string },
): Promise<ExtractResult> {
  const { page, table } = await loadTable(db, ref, loc)
  if (page.pageType === 'source') {
    throw new TableError('source pages are immutable — cannot extract their tables')
  }
  const title = input.title.trim()
  if (!title) throw new TableError('a datatable title is required')
  if (await getPageByTitle(db, title)) {
    throw new TableError(`a page titled "${title}" already exists — choose another title`)
  }

  const lines = page.body.split('\n')
  const tableText = lines.slice(table.startLine, table.endLine + 1).join('\n')

  // Datatable first: the table is safe in a new page even if the source update later fails.
  const datatable = await createPage(db, {
    title,
    pageType: 'datatable',
    body: tableText,
    namespace: input.namespace ?? page.namespace,
    agentSource: input.agentSource,
  })

  const newBody = [
    ...lines.slice(0, table.startLine),
    `![[${title}]]`,
    ...lines.slice(table.endLine + 1),
  ].join('\n')
  const updated = await updatePage(db, page.id, {
    body: newBody,
    ifRev: input.ifRev,
    agentSource: input.agentSource ?? undefined,
  })
  if (!updated) throw new TableError(`no wiki page matching "${ref}"`)
  return { datatable, page: updated }
}
