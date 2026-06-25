import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Kysely } from 'kysely'
import {
  createContext,
  deleteContext,
  getContext,
  listContexts,
  updateContext,
} from '../core/contexts'
import { type Database, KINDS, type Kind, SCOPES, type Scope } from '../core/types'
import { parseFrontmatter } from '../lib/frontmatter'

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
  /** Non-wiki contexts (in the seen namespaces) with no file — removed only with --prune. */
  missing: Array<{ id: string; title: string | null }>
  skipped: Array<{ file: string; reason: string }>
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

function readEntries(dir: string): FileEntry[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((file) => {
      const { data, body } = parseFrontmatter<Record<string, unknown>>(
        readFileSync(join(dir, file), 'utf8'),
      )
      return {
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
      }
    })
}

function sameTags(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const sa = [...a].sort()
  const sb = [...b].sort()
  return sa.every((x, i) => x === sb[i])
}

/** Compute what `import` would do (no writes). */
export async function planImport(db: Kysely<Database>, dir: string): Promise<ImportPlan> {
  const entries = readEntries(dir)
  const create: FileEntry[] = []
  const update: Array<{ entry: FileEntry; id: string }> = []
  const skipped: Array<{ file: string; reason: string }> = []
  const seenIds = new Set<string>()
  const seenNamespaces = new Set<string>()
  let unchanged = 0

  for (const e of entries) {
    seenNamespaces.add(e.namespace)
    if (e.id) {
      const existing = await getContext(db, e.id)
      if (existing) {
        if (existing.pageType !== null) {
          skipped.push({ file: e.file, reason: 'id resolves to a wiki page' })
          continue
        }
        seenIds.add(e.id)
        const changed =
          (e.title ?? null) !== (existing.title ?? null) ||
          e.body.trim() !== existing.body.trim() ||
          !sameTags(e.tags, existing.tags)
        if (changed) update.push({ entry: e, id: e.id })
        else unchanged++
        continue
      }
    }
    create.push(e)
    if (e.id) seenIds.add(e.id)
  }

  // Missing = non-wiki contexts in the seen namespaces with no corresponding file.
  const missing: Array<{ id: string; title: string | null }> = []
  for (const ns of seenNamespaces) {
    const rows = await listContexts(db, { namespace: ns, pageScope: 'context', limit: 100000 })
    for (const c of rows) if (!seenIds.has(c.id)) missing.push({ id: c.id, title: c.title })
  }

  return { create, update, unchanged, missing, skipped }
}

/** Plan, then (unless dryRun) apply: create/update always, prune only with `prune`. */
export async function applyImport(
  db: Kysely<Database>,
  dir: string,
  opts: { prune?: boolean; dryRun?: boolean; agentSource?: string | null } = {},
): Promise<{ plan: ImportPlan; result: ImportResult }> {
  const plan = await planImport(db, dir)
  const agentSource = opts.agentSource ?? null

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
