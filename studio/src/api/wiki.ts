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
}

export interface LinkInput {
  fromId: string
  toId?: string
  toTitle?: string
  type: LinkType
}

/** Wiki API surface. Bodies PATCH'd here re-sync `[[..]]` links server-side. */
export const wikiApi = {
  list: (p: ListPagesParams = {}) =>
    api.get<Context[]>(
      `/wiki/pages${qs({ type: p.type, namespace: p.namespace, q: p.q, limit: p.limit })}`,
    ),
  get: (id: string) => api.get<Context>(`/wiki/pages/${id}`),
  create: (input: CreatePageInput) => api.post<Context>('/wiki/pages', input),
  update: (id: string, patch: UpdatePageInput) => api.patch<Context>(`/wiki/pages/${id}`, patch),
  verify: (id: string) => api.post<Context>(`/wiki/pages/${id}/verify`, {}),
  remove: (id: string, hard = false) =>
    api.del<{ deleted: boolean }>(`/wiki/pages/${id}${hard ? '?hard=1' : ''}`),
  links: (id: string) => api.get<LinkView[]>(`/wiki/pages/${id}/links`),
  backlinks: (id: string) => api.get<LinkView[]>(`/wiki/pages/${id}/backlinks`),
  addLink: (input: LinkInput) => api.post<{ ok: true }>('/wiki/links', input),
  removeLink: (input: { fromId: string; toId?: string; toTitle?: string; type?: LinkType }) =>
    api.del<{ ok: true }>('/wiki/links', input),
  graph: (namespace?: string) => api.get<WikiGraph>(`/wiki/graph${qs({ namespace })}`),
  resolve: (title: string) => api.get<Context | null>(`/wiki/resolve${qs({ title })}`),
  log: (tail?: number) => api.get<WikiLogRow[]>(`/wiki/log${qs({ tail })}`),
  lint: (staleDays?: number) => api.get<LintReport>(`/wiki/lint${qs({ staleDays })}`),
  history: (id: string, limit?: number) =>
    api.get<HistoryEntry[]>(`/wiki/pages/${id}/history${qs({ limit })}`),
}
