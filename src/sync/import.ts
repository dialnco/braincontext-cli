import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Kysely } from 'kysely'
import {
  createContext,
  deleteContext,
  getContext,
  type ListFilters,
  listContexts,
  updateContext,
} from '../core/contexts'
import { type Database, KINDS, type Kind, SCOPES, type Scope } from '../core/types'
import { parseFrontmatter } from '../lib/frontmatter'

/** Sidecar written by `export --targets store` so `import --prune` knows the export's scope. */
export const EXPORT_MANIFEST = '.braincontext-export.json'

/** Skip reason for a file whose frontmatter could not be parsed (used to gate --prune). */
export const MALFORMED_FRONTMATTER = 'malformed frontmatter'

export interface ExportFilters {
  namespace?: string
  kind?: string
  scope?: string
  tag?: string
  agentSource?: string
}

export function writeExportManifest(dir: string, filters: ExportFilters): void {
  writeFileSync(join(dir, EXPORT_MANIFEST), `${JSON.stringify({ filters }, null, 2)}\n`, 'utf8')
}

interface FileEntry {
  file: string
  id?: string
  kind?: Kind
  namespace: string
  scope?: Scope
  title: string | null
  tags: string[]
  agent: string | null
  metadata: Record<string, unknown>
  body: string
}

export interface ImportPlan {
  create: FileEntry[]
  update: Array<{ entry: FileEntry; id: string }>
  unchanged: number
  /** Non-wiki contexts in the prune scope with no corresponding file (removed only with --prune). */
  missing: Array<{ id: string; title: string | null }>
  skipped: Array<{ file: string; reason: string }>
  /** True if a prune scope could be determined (manifest present or --namespace given). */
  pruneScopeKnown: boolean
}

export interface ImportResult {
  created: number
  updated: number
  unchanged: number
  pruned: number
  missing: number
  skipped: number
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}
function asKind(v: unknown): Kind | undefined {
  return typeof v === 'string' && (KINDS as readonly string[]).includes(v) ? (v as Kind) : undefined
}
function asScope(v: unknown): Scope | undefined {
  return typeof v === 'string' && (SCOPES as readonly string[]).includes(v)
    ? (v as Scope)
    : undefined
}
function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}
function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}
function stableJson(o: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1))))
}

function readManifest(dir: string): ExportFilters | null {
  const p = join(dir, EXPORT_MANIFEST)
  if (!existsSync(p)) return null
  try {
    const m = JSON.parse(readFileSync(p, 'utf8'))
    return (m && typeof m === 'object' && (m.filters as ExportFilters)) || {}
  } catch {
    return null
  }
}

function readEntries(dir: string): { entries: FileEntry[]; badFiles: string[] } {
  const entries: FileEntry[] = []
  const badFiles: string[] = []
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
    try {
      const { data, body } = parseFrontmatter<Record<string, unknown>>(
        readFileSync(join(dir, file), 'utf8'),
      )
      entries.push({
        file,
        id: str(data.id) ?? undefined,
        kind: asKind(data.kind),
        namespace: str(data.namespace) ?? 'global',
        scope: asScope(data.scope),
        title: str(data.title),
        tags: asStringArray(data.tags),
        agent: str(data.agent),
        metadata: asRecord(data.metadata),
        body: body.replace(/\n+$/, ''),
      })
    } catch {
      badFiles.push(file) // malformed frontmatter — skip, keep going
    }
  }
  return { entries, badFiles }
}

function sameTags(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const sa = [...a].sort()
  const sb = [...b].sort()
  return sa.every((x, i) => x === sb[i])
}

/** Compute what `import` would do (no writes). */
export async function planImport(
  db: Kysely<Database>,
  dir: string,
  opts: { pruneNamespace?: string } = {},
): Promise<ImportPlan> {
  const { entries, badFiles } = readEntries(dir)
  const create: FileEntry[] = []
  const update: Array<{ entry: FileEntry; id: string }> = []
  const skipped: Array<{ file: string; reason: string }> = badFiles.map((file) => ({
    file,
    reason: MALFORMED_FRONTMATTER,
  }))
  const seenIds = new Set<string>()
  let unchanged = 0

  for (const e of entries) {
    if (e.id) {
      const existing = await getContext(db, e.id)
      if (existing) {
        if (existing.pageType !== null) {
          skipped.push({ file: e.file, reason: 'id resolves to a wiki page' })
          continue
        }
        if (existing.deletedAt !== null) {
          skipped.push({ file: e.file, reason: 'id resolves to a soft-deleted context' })
          continue
        }
        seenIds.add(e.id)
        // kind/scope/namespace are structural identity: synced on create, immutable on
        // update (re-homing must be a deliberate `bctx update`, not a side effect of a
        // text edit). Surface a divergence instead of silently reporting "unchanged".
        const idShift =
          (e.kind !== undefined && e.kind !== existing.kind) ||
          (e.scope !== undefined && e.scope !== existing.scope) ||
          e.namespace !== existing.namespace
        const contentChanged =
          (e.title ?? null) !== (existing.title ?? null) ||
          e.body.trim() !== existing.body.trim() ||
          !sameTags(e.tags, existing.tags) ||
          stableJson(e.metadata) !== stableJson(existing.metadata)
        if (idShift) {
          skipped.push({
            file: e.file,
            reason:
              'kind/scope/namespace differ but are immutable on import — change with `bctx update`',
          })
        }
        if (contentChanged) update.push({ entry: e, id: e.id })
        else if (!idShift) unchanged++
        continue
      }
    }
    create.push(e)
    if (e.id) seenIds.add(e.id)
  }

  // Determine the prune scope: the export manifest is authoritative; otherwise an
  // explicit --namespace; otherwise prune is not safely scopable.
  const manifest = readManifest(dir)
  let pruneScope: ListFilters | null = null
  if (manifest) {
    pruneScope = {
      namespace: manifest.namespace,
      kind: asKind(manifest.kind),
      scope: asScope(manifest.scope),
      tag: manifest.tag,
      agentSource: manifest.agentSource,
      pageScope: 'context',
      includeDeleted: false,
      limit: 100000,
    }
  } else if (opts.pruneNamespace) {
    pruneScope = { namespace: opts.pruneNamespace, pageScope: 'context', limit: 100000 }
  }

  const missing: Array<{ id: string; title: string | null }> = []
  if (pruneScope) {
    for (const c of await listContexts(db, pruneScope)) {
      if (!seenIds.has(c.id)) missing.push({ id: c.id, title: c.title })
    }
  }

  return { create, update, unchanged, missing, skipped, pruneScopeKnown: pruneScope !== null }
}

/** Plan, then (unless dryRun) apply: create/update always, prune only with `prune`. */
export async function applyImport(
  db: Kysely<Database>,
  dir: string,
  opts: {
    prune?: boolean
    dryRun?: boolean
    agentSource?: string | null
    pruneNamespace?: string
  } = {},
): Promise<{ plan: ImportPlan; result: ImportResult }> {
  const plan = await planImport(db, dir, { pruneNamespace: opts.pruneNamespace })
  const agentSource = opts.agentSource ?? null

  if (opts.prune && !plan.pruneScopeKnown) {
    throw new Error(
      `Cannot --prune: no ${EXPORT_MANIFEST} in this directory (was it produced by \`export --targets store\`?). Pass --namespace <ns> to scope the prune explicitly.`,
    )
  }

  // A present-but-unparseable file would be wrongly treated as "gone" (its id never lands
  // in the seen set) and its context soft-deleted on --prune. Refuse rather than risk it.
  if (opts.prune) {
    const parseFailures = plan.skipped.filter((s) => s.reason === MALFORMED_FRONTMATTER)
    if (parseFailures.length > 0) {
      const names = parseFailures.map((s) => s.file).join(', ')
      throw new Error(
        `Cannot --prune: ${parseFailures.length} file(s) failed to parse (${names}). A present-but-unreadable file would be wrongly treated as deleted — fix or remove it, then re-run.`,
      )
    }
  }

  if (!opts.dryRun) {
    for (const e of plan.create) {
      await createContext(db, {
        id: e.id,
        title: e.title,
        body: e.body,
        kind: e.kind ?? 'note',
        namespace: e.namespace,
        scope: e.scope ?? 'project',
        agentSource: agentSource ?? e.agent,
        tags: e.tags,
        metadata: e.metadata,
      })
    }
    for (const { entry: e, id } of plan.update) {
      const existing = await getContext(db, id)
      const current = existing?.tags ?? []
      await updateContext(db, id, {
        title: e.title,
        body: e.body,
        addTags: e.tags.filter((t) => !current.includes(t)),
        removeTags: current.filter((t) => !e.tags.includes(t)),
        setMetadata: Object.keys(e.metadata).length > 0 ? e.metadata : undefined,
        agentSource: agentSource ?? e.agent,
      })
    }
    if (opts.prune) {
      for (const m of plan.missing) {
        await deleteContext(db, m.id, { hard: false, agentSource })
      }
    }
  }

  return {
    plan,
    result: {
      created: plan.create.length,
      updated: plan.update.length,
      unchanged: plan.unchanged,
      pruned: opts.prune ? plan.missing.length : 0,
      missing: plan.missing.length,
      skipped: plan.skipped.length,
    },
  }
}
