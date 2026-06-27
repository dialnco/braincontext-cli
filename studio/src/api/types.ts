/**
 * Frontend DTOs that mirror the braincontext core types (src/core). Kept as a
 * local copy rather than imported across the CLI/studio tsconfig boundary — the
 * shapes are the JSON the studio API returns.
 */

export const KINDS = ['note', 'rule', 'snippet', 'decision', 'skill'] as const
export type Kind = (typeof KINDS)[number]

export const SCOPES = ['global', 'user', 'project', 'local'] as const
export type Scope = (typeof SCOPES)[number]

/** Page types a user may author in Studio (excludes derived `index` + immutable `source`). */
export const AUTHORED_PAGE_TYPES = [
  'entity',
  'concept',
  'summary',
  'comparison',
  'analysis',
] as const
export type AuthoredPageType = (typeof AUTHORED_PAGE_TYPES)[number]

/** Every page type that can appear in stored data. */
export const PAGE_TYPES = [
  'entity',
  'concept',
  'summary',
  'comparison',
  'analysis',
  'source',
  'index',
] as const
export type PageType = (typeof PAGE_TYPES)[number]

export const LINK_TYPES = ['relates', 'supersedes', 'part-of', 'mentions', 'source'] as const
export type LinkType = (typeof LINK_TYPES)[number]

/** A context entry OR a wiki page (pageType != null marks a page). The studio API
 *  returns this shape from both /api/contexts and /api/wiki/pages. */
export interface Context {
  id: string
  namespace: string
  title: string | null
  body: string
  kind: Kind
  scope: Scope
  agentSource: string | null
  metadata: Record<string, unknown>
  pageType: string | null
  slug: string | null
  tags: string[]
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

/** An outbound/inbound typed edge as returned by the links/backlinks endpoints. */
export interface LinkView {
  id: number
  type: string
  /** The other endpoint's page id (target for outbound, source for backlinks). */
  pageId: string | null
  title: string | null
  /** True when this is a "wanted"/red link (no resolved target page yet). */
  wanted: boolean
}

export interface GraphNode {
  id: string
  title: string | null
  pageType: string | null
  degree: number
}

export interface GraphEdge {
  from: string
  to: string
  type: string
}

export interface WikiGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export interface TagCount {
  name: string
  count: number
}

export interface HistoryEntry {
  id: number
  event: 'create' | 'update' | 'delete'
  oldBody: string | null
  newBody: string | null
  agentSource: string | null
  changedAt: string
}

export type ProjectMode = 'local' | 'replica' | 'remote'

export interface ProjectStatus {
  project: string | null
  mode: ProjectMode
  location: string
  syncInterval?: number
  noSync: boolean
}

export interface ProjectInfo {
  name: string
  mode: ProjectMode
  current: boolean
}

export interface WikiLogRow {
  op: string
  refId: string | null
  title: string | null
  detail: string | null
  agentSource: string | null
  createdAt: string
}
