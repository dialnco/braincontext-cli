import { api, qs } from './client'
import type { Context, HistoryEntry, Kind, Scope, TagCount } from './types'

export interface ListContextsParams {
  kind?: Kind
  scope?: Scope
  tag?: string
  namespace?: string
  q?: string
  limit?: number
}

export interface CreateContextInput {
  body: string
  title?: string | null
  kind?: Kind
  scope?: Scope
  namespace?: string
  agentSource?: string | null
  tags?: string[]
  metadata?: Record<string, unknown>
}

export interface UpdateContextInput {
  title?: string | null
  body?: string
  addTags?: string[]
  removeTags?: string[]
  setMetadata?: Record<string, unknown>
  agentSource?: string | null
}

/** Plain-context API surface (note/rule/snippet/decision/skill). */
export const contextsApi = {
  list: (p: ListContextsParams = {}) =>
    api.get<Context[]>(
      `/contexts${qs({ kind: p.kind, scope: p.scope, tag: p.tag, namespace: p.namespace, q: p.q, limit: p.limit })}`,
    ),
  get: (id: string) => api.get<Context>(`/contexts/${id}`),
  create: (input: CreateContextInput) => api.post<Context>('/contexts', input),
  update: (id: string, patch: UpdateContextInput) => api.patch<Context>(`/contexts/${id}`, patch),
  remove: (id: string, hard = false) =>
    api.del<{ deleted: boolean }>(`/contexts/${id}${hard ? '?hard=1' : ''}`),
  history: (id: string) => api.get<HistoryEntry[]>(`/contexts/${id}/history`),
  tags: () => api.get<TagCount[]>('/tags'),
}
