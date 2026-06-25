import SQLite from 'better-sqlite3'
import { Kysely, SqliteDialect } from 'kysely'
import { describe, expect, it } from 'vitest'
import {
  createContext,
  deleteContext,
  getContext,
  listContexts,
  searchContexts,
  updateContext,
} from '../src/core/contexts'
import { migrateToLatest } from '../src/core/migrate'
import type { Database } from '../src/core/types'

async function freshDb(): Promise<Kysely<Database>> {
  const sqlite = new SQLite(':memory:')
  sqlite.pragma('foreign_keys = ON')
  const db = new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) })
  await migrateToLatest(db)
  return db
}

describe('contexts core', () => {
  it('creates and reads back an entry with tags', async () => {
    const db = await freshDb()
    const ctx = await createContext(db, {
      body: 'Use pnpm always',
      kind: 'rule',
      namespace: 'proj',
      tags: ['tooling', 'policy'],
      agentSource: 'claude',
    })
    expect(ctx.id).toBeTruthy()
    expect(ctx.kind).toBe('rule')

    const got = await getContext(db, ctx.id)
    expect(got?.body).toBe('Use pnpm always')
    expect(got?.tags.slice().sort()).toEqual(['policy', 'tooling'])
    expect(got?.agentSource).toBe('claude')
    await db.destroy()
  })

  it('filters in list by kind and tag', async () => {
    const db = await freshDb()
    await createContext(db, { body: 'a rule', kind: 'rule', tags: ['x'] })
    await createContext(db, { body: 'a note', kind: 'note', tags: ['y'] })
    expect((await listContexts(db, { kind: 'rule' })).length).toBe(1)
    expect((await listContexts(db, { tag: 'y' })).length).toBe(1)
    expect((await listContexts(db)).length).toBe(2)
    await db.destroy()
  })

  it('finds entries via FTS search', async () => {
    const db = await freshDb()
    await createContext(db, { body: 'The deployment uses Docker and Fly.io' })
    await createContext(db, { body: 'Prefer pnpm over npm' })
    const hits = await searchContexts(db, 'pnpm')
    expect(hits.length).toBe(1)
    expect(hits[0]?.body).toContain('pnpm')
    await db.destroy()
  })

  it('updates body and tags, recording history', async () => {
    const db = await freshDb()
    const c = await createContext(db, { body: 'old body', tags: ['keep', 'drop'] })
    const updated = await updateContext(db, c.id, {
      body: 'new body',
      addTags: ['added'],
      removeTags: ['drop'],
      setMetadata: { reviewed: true },
    })
    expect(updated?.body).toBe('new body')
    expect(updated?.tags.slice().sort()).toEqual(['added', 'keep'])
    expect(updated?.metadata.reviewed).toBe(true)

    const history = await db
      .selectFrom('context_history')
      .selectAll()
      .where('context_id', '=', c.id)
      .execute()
    expect(history.map((h) => h.event)).toEqual(['create', 'update'])
    await db.destroy()
  })

  it('soft-deletes by default and hard-deletes on request', async () => {
    const db = await freshDb()
    const soft = await createContext(db, { body: 'temp soft' })
    expect(await deleteContext(db, soft.id)).toBe(true)
    expect((await listContexts(db)).find((x) => x.id === soft.id)).toBeUndefined()
    expect((await getContext(db, soft.id))?.deletedAt).toBeTruthy()

    const hard = await createContext(db, { body: 'temp hard' })
    expect(await deleteContext(db, hard.id, { hard: true })).toBe(true)
    expect(await getContext(db, hard.id)).toBeNull()
    await db.destroy()
  })

  it('returns false when deleting a missing id', async () => {
    const db = await freshDb()
    expect(await deleteContext(db, 'nonexistent')).toBe(false)
    await db.destroy()
  })
})
