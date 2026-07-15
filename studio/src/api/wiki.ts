import { api, qs } from './client'
import type {
  AuthoredPageType,
  Context,
  HistoryEntry,
  LinkType,
  LinkView,
  LintReport,
  WikiGraph,
  WikiLogRow,
} from './types'

export interface ListPagesParams {
  type?: string
  namespace?: string
  q?: string
  limit?: number
}

export interface CreatePageInput {
  title: string
  pageType: AuthoredPageType
  body?: string
  namespace?: string
  tags?: string[]
}

export interface UpdatePageInput {
  title?: string | null
  body?: string
  addTags?: string[]
  removeTags?: string[]
  setMetadata?: Record<string, unknown>
  /** Optimistic-concurrency guard — reject if the page rev no longer matches. */
  ifRev?: string
  /** Labels the write in history (e.g. 'undo' / 'redo' / 'restore'). */
  agentSource?: string
}

export interface LinkInput {
  fromId: string
  toId?: string
  toTitle?: string
  type: LinkType
}

/** Edit one table cell in place (lossless splice server-side, no whole-body PATCH). */
export interface TableCellEdit {
  tableIndex?: number
  caption?: string
  row: string
  column: string
  value: string
  ifRev?: string
}

export type ColumnAlign = 'left' | 'right' | 'center'

/** Shared locator + CAS handle on every structural table op (default locator = sole table). */
export interface TableOpLocator {
  tableIndex?: number
  caption?: string
  ifRev?: string
}

/** An index-addressed structural table op for the datatable grid (→ POST /pages/:id/table/op). */
export type TableOp =
  | (TableOpLocator & { op: 'setCell'; row: number; col: number; value: string })
  | (TableOpLocator & { op: 'addRow'; cells?: string[] })
  | (TableOpLocator & { op: 'deleteRow'; row: number })
  | (TableOpLocator & { op: 'addColumn'; name: string; at?: number; align?: ColumnAlign | null })
  | (TableOpLocator & { op: 'deleteColumn'; col: number })
  | (TableOpLocator & { op: 'renameColumn'; col: number; name: string })
  | (TableOpLocator & { op: 'setAlign'; col: number; align: ColumnAlign | null })

/** Wiki API surface. Bodies PATCH'd here re-sync `[[..]]` links server-side. */
export const wikiApi = {
  list: (p: ListPagesParams = {}) =>
    api.get<Context[]>(
      `/wiki/pages${qs({ type: p.type, namespace: p.namespace, q: p.q, limit: p.limit })}`,
    ),
  get: (id: string) => api.get<Context>(`/wiki/pages/${id}`),
  create: (input: CreatePageInput) => api.post<Context>('/wiki/pages', input),
  update: (id: string, patch: UpdatePageInput) => api.patch<Context>(`/wiki/pages/${id}`, patch),
  editCell: (id: string, edit: TableCellEdit) => api.post<Context>(`/wiki/pages/${id}/table`, edit),
  tableOp: (id: string, op: TableOp) => api.post<Context>(`/wiki/pages/${id}/table/op`, op),
  verify: (id: string) => api.post<Context>(`/wiki/pages/${id}/verify`, {}),
  remove: (id: string, hard = false) =>
    api.del<{ deleted: boolean }>(`/wiki/pages/${id}${hard ? '?hard=1' : ''}`),
  links: (id: string) => api.get<LinkView[]>(`/wiki/pages/${id}/links`),
  backlinks: (id: string) => api.get<LinkView[]>(`/wiki/pages/${id}/backlinks`),
  addLink: (input: LinkInput) => api.post<{ ok: true }>('/wiki/links', input),
  removeLink: (input: { fromId: string; toId?: string; toTitle?: string; type?: LinkType }) =>
    api.del<{ ok: true }>('/wiki/links', input),
  graph: (p: { namespace?: string; minDegree?: number; limit?: number } = {}) =>
    api.get<WikiGraph>(
      `/wiki/graph${qs({ namespace: p.namespace, minDegree: p.minDegree, limit: p.limit })}`,
    ),
  resolve: (title: string) => api.get<Context | null>(`/wiki/resolve${qs({ title })}`),
  log: (tail?: number) => api.get<WikiLogRow[]>(`/wiki/log${qs({ tail })}`),
  lint: (staleDays?: number) => api.get<LintReport>(`/wiki/lint${qs({ staleDays })}`),
  history: (id: string, limit?: number) =>
    api.get<HistoryEntry[]>(`/wiki/pages/${id}/history${qs({ limit })}`),
}
