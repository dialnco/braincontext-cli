import { api, qs } from './client'

/** Inbox client. Mirrors src/core/inbox/threads.ts + src/studio/routes/inbox.ts. */

export type InboxKind = 'ask' | 'task' | 'fyi'
export type InboxStatus = 'open' | 'in_progress' | 'resolved' | 'declined' | 'cancelled'
export type InboxBox = 'mine' | 'assigned' | 'sent' | 'team' | 'all'
export type InboxAction =
  | 'claim'
  | 'unclaim'
  | 'resolve'
  | 'decline'
  | 'reopen'
  | 'cancel'
  | 'reassign'
  | 'mark_read'

export const INBOX_KINDS: InboxKind[] = ['ask', 'task', 'fyi']
export const OPEN_STATUSES: InboxStatus[] = ['open', 'in_progress']

export interface PersonRef {
  id: string
  handle: string
  removed: boolean
}

export interface ThreadSummary {
  num: number
  id: string
  kind: InboxKind
  title: string
  status: InboxStatus
  urgent: boolean
  from: PersonRef
  assignee: PersonRef | null
  claimed: { session: string | null; agent: string | null; at: string } | null
  resolution: string | null
  closedBy: string | null
  closedAt: string | null
  awaiting: string | null
  unread: boolean
  lastSeq: number
  createdAt: string
  updatedAt: string
}

export interface InboxMessage {
  seq: number
  id: string
  author: PersonRef
  agentSource: string | null
  surface: 'cli' | 'mcp' | 'studio'
  byAgent: boolean
  type: 'message' | 'event'
  event: string | null
  body: string
  createdAt: string
}

/** A page/context/file a thread points at, described at read time (mirrors core InboxRef). */
export interface InboxRef {
  type: 'page' | 'context' | 'file'
  id: string
  /** Page/context title or file name. Untrusted member-written text. */
  label?: string | null
  mime?: string
  size?: number
  /** Deleted since it was referenced. */
  missing?: boolean
}

export interface ThreadView extends ThreadSummary {
  refs: InboxRef[]
  messages: InboxMessage[]
}

export interface InboxSummary {
  unread: number
  assigned: number
  team: number
  sent: number
  maxSeq: number
}

export interface InboxStatusInfo {
  available: boolean
  reason: 'access_off' | 'unauthenticated' | 'local_project' | null
  steps: string | null
}

export interface Member {
  handle: string
  displayName: string | null
}

export interface SendInput {
  to: string
  body: string
  title?: string
  kind?: InboxKind
  urgent?: boolean
  refs?: string[]
}

export const inboxApi = {
  status: () => api.get<InboxStatusInfo>('/inbox/status'),
  summary: () => api.get<InboxSummary>('/inbox/summary'),
  members: () => api.get<Member[]>('/inbox/members'),
  list: (p: { box?: InboxBox; status?: string; kind?: InboxKind } = {}) =>
    api.get<ThreadSummary[]>(`/inbox/threads${qs({ ...p, limit: 200 })}`),
  get: (ref: number | string) => api.get<ThreadView>(`/inbox/threads/${ref}`),
  send: (input: SendInput) => api.post<ThreadView>('/inbox/threads', input),
  reply: (ref: number, body: string, after?: 'claim' | 'resolve') =>
    api.post<ThreadView>(`/inbox/threads/${ref}/reply`, { body, after }),
  act: (
    ref: number,
    action: InboxAction,
    extra: { note?: string; to?: string; force?: boolean } = {},
  ) => api.post<ThreadView>(`/inbox/threads/${ref}/action`, { action, ...extra }),
}
