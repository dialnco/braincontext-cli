/**
 * Pure GFM-table parse / serialize / splice — no deps, no `node:`, no DOM, so the ONE
 * source is shared by the Node CLI/MCP/Studio-backend AND the browser SPA (Phase 2 unifies
 * the previously-duplicated, alignment-lossy browser parser in studio/src/lib/markdown.ts).
 *
 * Fence-aware by construction: ```/~~~ code blocks are consumed BEFORE table detection, so a
 * markdown table shown inside a code fence is never parsed or mutated. Round-trips alignment
 * (:--, :-:, --:) and escaped pipes (\|), which the old browser parser discarded.
 */

export type Align = 'left' | 'right' | 'center'

/** A table's data (what a mutation edits), independent of where it sits in a body. */
export interface TableData {
  header: string[]
  alignments: Array<Align | null>
  rows: string[][]
}

/** A parsed table located within a body (line indices into `body.split('\n')`, inclusive). */
export interface Table extends TableData {
  /** Nearest preceding ATX heading text (## / ###), used as a human-friendly caption. */
  headingAbove: string | null
  startLine: number
  endLine: number
}

/** True if `s` is a GFM delimiter row (e.g. `|---|:--:|`), not a `---` thematic break. */
export function isTableDelim(s: string): boolean {
  const t = (s ?? '').trim()
  if (!t.includes('|') || !t.includes('-')) return false
  const cells = splitRow(t)
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c))
}

/** Split a table row into trimmed cells: drop optional outer pipes, honor escaped `\|`. */
export function splitRow(s: string): string[] {
  return s
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|'))
}

/** The fence char a line opens/closes a code block with (``` or ~~~), else null. */
function fenceChar(line: string): '`' | '~' | null {
  const t = line.trimStart()
  if (t.startsWith('```')) return '`'
  if (t.startsWith('~~~')) return '~'
  return null
}

function parseAlignments(delimLine: string): Array<Align | null> {
  return splitRow(delimLine).map((c) => {
    const left = c.startsWith(':')
    const right = c.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    if (left) return 'left'
    return null
  })
}

/** Every GFM table in `body`, in document order. Tables inside code fences are skipped. */
export function parseTables(body: string): Table[] {
  const lines = body.split('\n')
  const tables: Table[] = []
  let fence: '`' | '~' | null = null
  let headingAbove: string | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const fc = fenceChar(line)
    if (fence) {
      if (fc === fence) fence = null // closing fence
      continue
    }
    if (fc) {
      fence = fc
      continue
    }
    const h = /^#{1,6}\s+(.+?)\s*$/.exec(line)
    if (h?.[1]) {
      headingAbove = h[1].trim()
      continue
    }
    // A header row is a pipe line immediately followed by a delimiter row.
    const next = lines[i + 1] ?? ''
    if (line.includes('|') && isTableDelim(next)) {
      const header = splitRow(line)
      const alignments = parseAlignments(next)
      const startLine = i
      let j = i + 2
      const rows: string[][] = []
      while (j < lines.length) {
        const rl = lines[j] ?? ''
        if (rl.trim() === '' || !rl.includes('|')) break
        rows.push(splitRow(rl))
        j++
      }
      tables.push({ headingAbove, header, alignments, rows, startLine, endLine: j - 1 })
      i = j - 1
    }
  }
  return tables
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

function delimFor(a: Align | null): string {
  switch (a) {
    case 'left':
      return ':---'
    case 'right':
      return '---:'
    case 'center':
      return ':--:'
    default:
      return '---'
  }
}

const rowLine = (cells: string[], width: number): string =>
  `| ${Array.from({ length: width }, (_, i) => escapeCell(cells[i] ?? '')).join(' | ')} |`

/** Serialize table data to GFM, preserving alignment and re-escaping pipes. */
export function serializeTable(t: TableData): string {
  const width = t.header.length
  const aligns = t.alignments.length === width ? t.alignments : new Array(width).fill(null)
  return [
    rowLine(t.header, width),
    `| ${Array.from({ length: width }, (_, i) => delimFor(aligns[i])).join(' | ')} |`,
    ...t.rows.map((r) => rowLine(r, width)),
  ].join('\n')
}

/** Replace a located table's lines with a freshly-serialized version; returns the new body. */
export function replaceTableInBody(body: string, table: Table, next: TableData): string {
  const lines = body.split('\n')
  lines.splice(
    table.startLine,
    table.endLine - table.startLine + 1,
    ...serializeTable(next).split('\n'),
  )
  return lines.join('\n')
}

// --- pure locator/resolver helpers (locator policy lives in core/tables.ts) --------------

/** Column index by header name (case-insensitive) or a numeric ordinal string; -1 if none. */
export function columnIndex(t: Pick<TableData, 'header'>, col: string): number {
  if (/^\d+$/.test(col)) {
    const n = Number(col)
    return n >= 0 && n < t.header.length ? n : -1
  }
  const norm = col.trim().toLowerCase()
  return t.header.findIndex((h) => h.trim().toLowerCase() === norm)
}

/** Row index by first-column key value (case-insensitive); falls back to a numeric ordinal. */
export function rowIndexByKey(t: Pick<TableData, 'rows'>, rowKey: string, keyCol = 0): number {
  const norm = rowKey.trim().toLowerCase()
  const byValue = t.rows.findIndex((r) => (r[keyCol] ?? '').trim().toLowerCase() === norm)
  if (byValue !== -1) return byValue
  if (/^\d+$/.test(rowKey)) {
    const n = Number(rowKey)
    if (n >= 0 && n < t.rows.length) return n
  }
  return -1
}

// --- pure data mutators (return new TableData; callers splice via replaceTableInBody) -----

export function setCellData(
  t: TableData,
  rowIndex: number,
  colIndex: number,
  value: string,
): TableData {
  const rows = t.rows.map((r, i) => {
    if (i !== rowIndex) return r
    const nr = [...r]
    while (nr.length <= colIndex) nr.push('')
    nr[colIndex] = value
    return nr
  })
  return { ...t, rows }
}

export function addRowData(t: TableData, cells: string[]): TableData {
  return { ...t, rows: [...t.rows, t.header.map((_, i) => cells[i] ?? '')] }
}

export function deleteRowData(t: TableData, rowIndex: number): TableData {
  return { ...t, rows: t.rows.filter((_, i) => i !== rowIndex) }
}

/** Normalize `alignments` to exactly `header.length` (parse/serialize may leave it short). */
function normAligns(t: TableData): Array<Align | null> {
  return t.header.map((_, i) => t.alignments[i] ?? null)
}

/**
 * Insert a column at `at` (0-based; append when `at` is undefined, clamped to `[0, width]`).
 * Touches `header` + `alignments` + EVERY row together so the table stays rectangular —
 * `serializeTable` derives width from `header.length`, so a header-only change would silently
 * shift every row's cells.
 */
export function addColumnData(
  t: TableData,
  at: number | undefined,
  name = '',
  align: Align | null = null,
): TableData {
  const width = t.header.length
  const idx = at === undefined ? width : Math.max(0, Math.min(at, width))
  const aligns = normAligns(t)
  return {
    header: [...t.header.slice(0, idx), name, ...t.header.slice(idx)],
    alignments: [...aligns.slice(0, idx), align, ...aligns.slice(idx)],
    rows: t.rows.map((r) => [...r.slice(0, idx), '', ...r.slice(idx)]),
  }
}

/** Drop the column at `colIndex` from `header` + `alignments` + every row. */
export function deleteColumnData(t: TableData, colIndex: number): TableData {
  const aligns = normAligns(t)
  return {
    header: t.header.filter((_, i) => i !== colIndex),
    alignments: aligns.filter((_, i) => i !== colIndex),
    rows: t.rows.map((r) => r.filter((_, i) => i !== colIndex)),
  }
}

/** Rename one column header (cells and alignment untouched). */
export function renameColumnData(t: TableData, colIndex: number, name: string): TableData {
  return { ...t, header: t.header.map((h, i) => (i === colIndex ? name : h)) }
}

/** Set one column's alignment (normalizing `alignments` to header width first). */
export function setColumnAlignData(t: TableData, colIndex: number, align: Align | null): TableData {
  return { ...t, alignments: normAligns(t).map((a, i) => (i === colIndex ? align : a)) }
}
