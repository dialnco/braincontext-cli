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
  'datatable',
  'view',
  'source',
  'index',
] as const
export type PageType = (typeof PAGE_TYPES)[number]

/**
 * Page types an agent may author directly with a free-form body (excludes the DERIVED
 * types whose body is generated: `index`, `view`, and `source` which is ingest-only).
 */
export const AUTHORED_PAGE_TYPES = [
  'entity',
  'concept',
  'summary',
  'comparison',
  'analysis',
  'datatable',
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

/**
 * The reserved auto-derived transclusion channel: `![[Title]]` in a body embeds that page
 * (typically a datatable) into this one. Managed by syncBodyLinks exactly like
 * `references`, and — like it — kept out of LINK_TYPES so explicit links never collide.
 */
export const EMBEDS_LINK = 'embeds'

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
  /** Authenticated author, when the project has access control on. See 0004. */
  principal_id: string | null
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
  /** Authenticated author, when the project has access control on. See 0004. */
  principal_id: string | null
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

/**
 * Derived scalar-property mirror of a page's `metadata.props`, rebuilt on every write
 * (see rebuildPageProperties). One row per (page, key); `value` is the canonical string
 * form and `type` tells the query compiler whether to compare it as text or a number.
 * Fully derived — never the source of truth, so it can be dropped and rebuilt freely.
 */
export interface PagePropertiesTable {
  context_id: string
  key: string
  value: string | null
  /** 'string' | 'number' | 'boolean' — how the query layer compares `value`. */
  type: string
}

/** Per-store key-value settings (namespaced keys, e.g. `storage.*`). See 0003. */
export interface StoreConfigTable {
  key: string
  value: string
  updated_at: string
}

/**
 * Metadata/references for files stored in the configured S3-compatible bucket.
 * The blobs live ONLY in object storage — never in this database. See 0003.
 */
export interface FilesTable {
  id: string
  /** Object key in the bucket: `<prefix>/files/<ulid>/<sanitized-name>`. */
  object_key: string
  filename: string
  mime: string
  size: number
  sha256: string | null
  agent_source: string | null
  /** JSON-encoded free-form metadata. */
  metadata: string
  created_at: string
  /** Soft delete keeps the id stable for dangling markdown references. */
  deleted_at: string | null
  /** Authenticated uploader, when the project has access control on. See 0004. */
  principal_id: string | null
}

// ---------------------------------------------------------------------------
// Access control (see 0004 and core/access/). Inert until `access.enabled`.
// ---------------------------------------------------------------------------

/** Project roles, ordered most- to least-privileged. */
export const ROLES = ['owner', 'admin', 'writer', 'reader'] as const
export type Role = (typeof ROLES)[number]

export const PRINCIPAL_STATUSES = ['active', 'disabled'] as const
export type PrincipalStatus = (typeof PRINCIPAL_STATUSES)[number]

/** A named identity on this project. */
export interface PrincipalsTable {
  id: string
  handle: string
  display_name: string | null
  role: Role
  /** JSON object of per-capability overrides merged over the role defaults. */
  capabilities: string | null
  status: PrincipalStatus
  created_at: string
  /** Principal id of the creator (null for the bootstrap owner). */
  created_by: string | null
  updated_at: string
}

/** A key belonging to a principal. The secret itself is never stored. */
export interface PrincipalKeysTable {
  id: string
  principal_id: string
  label: string | null
  /** Public lookup half of `bctxk.<prefix>.<secret>`. */
  prefix: string
  /** PHC-style `scrypt$N$r$p$salt$hash`. */
  secret_hash: string
  created_at: string
  expires_at: string | null
  last_used_at: string | null
  revoked_at: string | null
  created_by: string | null
}

/** Append-only allow/deny decisions. `handle` is denormalized so the log
 *  outlives the principal it describes. */
export interface AccessLogTable {
  id: Generated<number>
  at: string
  principal_id: string | null
  handle: string | null
  agent_source: string | null
  /** 'cli' | 'studio' | 'mcp'. */
  surface: string
  /** The command path or route that was attempted, e.g. `wiki new`. */
  action: string
  target_type: string | null
  target_id: string | null
  decision: 'allow' | 'deny'
  /** JSON-encoded extra detail (e.g. the missing capability). */
  detail: string | null
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
  page_properties: PagePropertiesTable
  store_config: StoreConfigTable
  files: FilesTable
  principals: PrincipalsTable
  principal_keys: PrincipalKeysTable
  access_log: AccessLogTable
}
