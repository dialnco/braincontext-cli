import type { Generated } from 'kysely'

/** Allowed values for a context entry's `kind`. */
export const KINDS = ['note', 'rule', 'snippet', 'decision', 'skill'] as const
export type Kind = (typeof KINDS)[number]

/** Allowed values for a context entry's `scope`. */
export const SCOPES = ['global', 'user', 'project', 'local'] as const
export type Scope = (typeof SCOPES)[number]

/** Append-only audit events. */
export type HistoryEvent = 'create' | 'update' | 'delete'

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

export interface Database {
  contexts: ContextsTable
  tags: TagsTable
  context_tags: ContextTagsTable
  context_history: ContextHistoryTable
  skill_files: SkillFilesTable
  contexts_fts: ContextsFtsTable
}
