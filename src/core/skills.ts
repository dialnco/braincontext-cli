import type { Kysely } from 'kysely'
import { ulid } from 'ulidx'
import { type Context, getContext, listContexts } from './contexts'
import { withWriteRetry } from './tx'
import type { Database } from './types'

/** Normalize a stored BLOB to a Node Buffer (libSQL returns ArrayBuffer, not Buffer). */
function toBuffer(v: unknown): Buffer {
  if (Buffer.isBuffer(v)) return v
  if (v instanceof ArrayBuffer) return Buffer.from(v)
  if (ArrayBuffer.isView(v)) return Buffer.from(v.buffer, v.byteOffset, v.byteLength)
  return Buffer.from(v as ArrayLike<number>)
}

export interface SkillFileInput {
  relPath: string
  content: Buffer
  isExecutable: boolean
}

export interface ImportSkillInput {
  name: string
  description: string
  body: string
  /** Full SKILL.md frontmatter, stored losslessly so export round-trips. */
  frontmatter: Record<string, unknown>
  files: SkillFileInput[]
  namespace?: string
  agentSource?: string | null
}

export interface LoadedSkill {
  context: Context
  files: SkillFileInput[]
}

function nowIso(): string {
  return new Date().toISOString()
}

/**
 * Import a parsed skill bundle: one transaction creates a kind='skill' context
 * (frontmatter in metadata, SKILL.md body in body) plus its sidecar files.
 * Re-importing the same name replaces the previous bundle (update semantics).
 */
export async function importSkill(db: Kysely<Database>, input: ImportSkillInput): Promise<Context> {
  const id = ulid()
  const ts = nowIso()
  const agentSource = input.agentSource ?? null

  await withWriteRetry(db, async (trx) => {
    const existing = await trx
      .selectFrom('contexts')
      .select('id')
      .where('kind', '=', 'skill')
      .where('title', '=', input.name)
      .where('namespace', '=', input.namespace ?? 'global')
      .where('deleted_at', 'is', null)
      .execute()
    for (const row of existing) {
      await trx
        .insertInto('context_history')
        .values({
          context_id: row.id,
          event: 'delete',
          old_body: null,
          new_body: null,
          agent_source: agentSource,
          changed_at: ts,
        })
        .execute()
      await trx.deleteFrom('contexts').where('id', '=', row.id).execute() // cascades skill_files
    }

    await trx
      .insertInto('contexts')
      .values({
        id,
        namespace: input.namespace ?? 'global',
        title: input.name,
        body: input.body,
        kind: 'skill',
        scope: 'project',
        agent_source: agentSource,
        metadata: JSON.stringify(input.frontmatter ?? {}),
        created_at: ts,
        updated_at: ts,
        deleted_at: null,
      })
      .execute()

    await trx
      .insertInto('context_history')
      .values({
        context_id: id,
        event: 'create',
        old_body: null,
        new_body: input.body,
        agent_source: agentSource,
        changed_at: ts,
      })
      .execute()

    if (input.files.length > 0) {
      await trx
        .insertInto('skill_files')
        .values(
          input.files.map((f) => ({
            context_id: id,
            rel_path: f.relPath,
            content: f.content,
            is_executable: f.isExecutable ? 1 : 0,
          })),
        )
        .execute()
    }
  })

  // Build the result in-memory (no read-back: a replica file may not yet hold the
  // just-written frames). Matches the row inserted above.
  return {
    id,
    namespace: input.namespace ?? 'global',
    title: input.name,
    body: input.body,
    kind: 'skill',
    scope: 'project',
    agentSource,
    metadata: input.frontmatter ?? {},
    pageType: null,
    slug: null,
    tags: [],
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
  }
}

/** Load a stored skill bundle (context + sidecar files) by skill name. */
export async function loadSkill(db: Kysely<Database>, name: string): Promise<LoadedSkill | null> {
  const row = await db
    .selectFrom('contexts')
    .select('id')
    .where('kind', '=', 'skill')
    .where('title', '=', name)
    .where('deleted_at', 'is', null)
    .orderBy('id', 'desc')
    .executeTakeFirst()
  if (!row) return null

  const ctx = await getContext(db, row.id)
  if (!ctx) return null

  const files = await db
    .selectFrom('skill_files')
    .select(['rel_path', 'content', 'is_executable'])
    .where('context_id', '=', row.id)
    .orderBy('rel_path')
    .execute()

  return {
    context: ctx,
    files: files.map((f) => ({
      relPath: f.rel_path,
      // libSQL returns BLOBs as ArrayBuffer; normalize to Buffer for fs/consumers.
      content: toBuffer(f.content),
      isExecutable: f.is_executable === 1,
    })),
  }
}

/** List skills stored in the DB (kind='skill'). */
export async function listSkillContexts(db: Kysely<Database>): Promise<Context[]> {
  return listContexts(db, { kind: 'skill' })
}
