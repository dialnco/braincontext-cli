import type { Generated } from 'kysely'

/** Allowed values for a context entry's `kind`. */
export const KINDS = ['note', 'rule', 'snippet', 'decision', 'skill'] as const
export type Kind = (typeof KINDS)[number]

/** Allowed values for a context entry's `scope`. */
export const SCOPES = ['global', 'user', 'project', 'local'] as const
export type Scope = (typeof SCOPES)[number]

/** Append-only audit events. */
export type HistoryEvent = 'create' | 'update' | 'delete'

/** Wiki page types. A context with a non-null page_type is a wiki page. */
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

/** Page types an agent may create directly (excludes the derived `index`). */
export const AUTHORED_PAGE_TYPES = [
  'entity',
  'concept',
  'summary',
  'comparison',
  'analysis',
] as const

/**
 * Page verification lifecycle (the gist's confidence/verification states).
 * Derived from `metadata.verifiedAt` + `updatedAt`, never stored directly, so a
 * recorded state can't silently outlive the facts it was computed from.
 */
export const VERIFICATION_STATES = ['unverified', 'verified', 'stale'] as const
export type VerificationState = (typeof VERIFICATION_STATES)[number]

/**
 * User-selectable link relations. The reserved `references` channel
 * (auto-derived from [[..]] in page bodies) is intentionally NOT here, so
 * explicit links never collide with — and get clobbered by — body re-sync.
 */
export const LINK_TYPES = ['relates', 'supersedes', 'part-of', 'mentions', 'source'] as const
export type LinkType = (typeof LINK_TYPES)[number]

/** The reserved auto-derived link channel (managed by syncBodyLinks). */
export const REFERENCES_LINK = 'references'

export interface ContextsTable {
  id: string
  namespace: string
  title: string | null
  body: string
  kind: Kind
  scope: Scope
  agent_source: string | null
  /** JSON-encoded free-form metadata. */
  metadata: string
  /** Non-null marks this row as a wiki page of that type; null = normal context. */
  page_type: string | null
  /** Stable, unique-among-pages filename slug for export round-trips. */
  slug: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export interface TagsTable {
  id: Generated<number>
  name: string
}

export interface ContextTagsTable {
  context_id: string
  tag_id: number
}

export interface ContextHistoryTable {
  id: Generated<number>
  context_id: string
  event: HistoryEvent
  old_body: string | null
  new_body: string | null
  agent_source: string | null
  changed_at: string
}

/** Sidecar files of a SKILL.md bundle (scripts/references/assets). See 0002. */
export interface SkillFilesTable {
  id: Generated<number>
  context_id: string
  rel_path: string
  /** Raw file bytes (BLOB) so binary assets round-trip faithfully. */
  content: Buffer
  /** 1 if the file should be chmod +x on export (scripts/**). */
  is_executable: number
}

/** FTS5 external-content mirror of contexts(title, body). Queried via raw SQL. */
export interface ContextsFtsTable {
  rowid: number
  title: string
  body: string
}

/** Typed edges between wiki pages. to_id NULL + to_title => a wanted/red link. */
export interface LinksTable {
  id: Generated<number>
  from_id: string
  to_id: string | null
  to_title: string | null
  type: string
  created_at: string
}

/** Append-only log of wiki operations (ingest/query/maintenance). */
export interface WikiLogTable {
  id: Generated<number>
  op: string
  ref_id: string | null
  title: string | null
  detail: string | null
  agent_source: string | null
  created_at: string
}

export interface Database {
  contexts: ContextsTable
  tags: TagsTable
  context_tags: ContextTagsTable
  context_history: ContextHistoryTable
  skill_files: SkillFilesTable
  contexts_fts: ContextsFtsTable
  links: LinksTable
  wiki_log: WikiLogTable
}
