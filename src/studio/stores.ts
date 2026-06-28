import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Kysely } from 'kysely'
import { type DbTarget, openStore, type Store } from '../core/db'
import { migrateToLatest } from '../core/migrate'
import { type DbOpts, resolveTarget } from '../core/paths'
import {
  currentProjectName,
  getProject,
  listProjects,
  type ProjectMode,
  projectToTarget,
} from '../core/registry'
import type { Database } from '../core/types'

/** A snapshot of which store the Studio server is currently serving. */
export interface ProjectStatus {
  /** Registry project name, or null when launched via --db/--global/--local. */
  project: string | null
  mode: DbTarget['mode']
  /** Local file path (local/replica) or remote URL. */
  location: string
  syncInterval?: number
  noSync: boolean
}

export interface ProjectInfo {
  name: string
  mode: ProjectMode
  current: boolean
}

/**
 * What the HTTP layer needs from the store: the live Kysely handle plus the
 * project-switch lifecycle. Injected into {@link buildStudioApp} so tests can pass
 * a trivial in-memory provider (see {@link staticProvider}) while `run.ts` passes
 * the real {@link StoreManager}.
 */
export interface StoreProvider {
  /** The current store's Kysely handle. Re-read on every request — it changes on switch. */
  db(): Kysely<Database>
  status(): ProjectStatus
  projects(): ProjectInfo[]
  switch(name: string): Promise<ProjectStatus>
  sync(): Promise<void>
  close(): Promise<void>
  /** Bracket a data request so a project switch can quiesce before closing the old store. */
  enter(): void
  leave(): void
}

/** Open + prepare + (optionally) sync + migrate a target into a ready Store. */
async function bootstrap(target: DbTarget, noSync: boolean): Promise<Store> {
  if (target.mode !== 'remote') mkdirSync(dirname(target.file), { recursive: true })
  const store = openStore(target)
  await store.prepare()
  if (!noSync) await store.sync()
  await migrateToLatest(store.db, { lockFile: target.mode !== 'remote' ? target.file : undefined })
  return store
}

function initialName(opts: DbOpts): string | null {
  if (opts.project) return opts.project
  // --db/--global/--local target a file with no registry identity.
  if (opts.db || opts.global || opts.local) return null
  return currentProjectName()
}

/**
 * Owns the long-lived store for `bctx studio` and supports switching projects at
 * runtime. Switches are serialized (a promise chain) so two concurrent switch
 * requests can't race, and each switch opens the next store before closing the
 * previous — different projects are different files, so the embedded-replica
 * single-owner rule is preserved (only one syncer per file at any instant), and a
 * failed open leaves the current store intact.
 */
export async function createStoreManager(opts: DbOpts): Promise<StoreProvider> {
  let target = resolveTarget(opts)
  let store = await bootstrap(target, !!opts.noSync)
  let name = initialName(opts)
  const noSync = !!opts.noSync
  let chain: Promise<unknown> = Promise.resolve()

  // In-flight data-request counter so a project switch waits for handlers that already
  // captured the old store handle to finish before we close it (avoids destroying a
  // connection mid-query). Bounded by a timeout so a hung request can't wedge a switch.
  let inflight = 0
  let drainWaiters: Array<() => void> = []
  const drain = (): Promise<void> =>
    inflight === 0 ? Promise.resolve() : new Promise<void>((resolve) => drainWaiters.push(resolve))
  const enter = (): void => {
    inflight++
  }
  const leave = (): void => {
    inflight = Math.max(0, inflight - 1)
    if (inflight === 0 && drainWaiters.length > 0) {
      const waiters = drainWaiters
      drainWaiters = []
      for (const w of waiters) w()
    }
  }

  const status = (): ProjectStatus => ({
    project: name,
    mode: target.mode,
    location: target.mode === 'remote' ? target.url : target.file,
    syncInterval: target.mode === 'replica' ? target.syncInterval : undefined,
    noSync,
  })

  const doSwitch = async (next: string): Promise<ProjectStatus> => {
    if (next === name) return status() // no-op: avoid double-opening the same replica file
    const entry = getProject(next)
    if (!entry) throw new Error(`No such project: "${next}". Run \`bctx project list\`.`)
    const nextStore = await bootstrap(projectToTarget(next, entry), noSync)
    const old = store
    store = nextStore
    target = projectToTarget(next, entry)
    name = next
    // Let in-flight data requests holding the old handle finish first (bounded at 3s so a
    // stuck request can't wedge the switch). The switch route itself is not counted.
    await Promise.race([drain(), new Promise<void>((r) => setTimeout(r, 3000))])
    await old.close()
    return status()
  }

  return {
    db: () => store.db,
    status,
    projects: () =>
      listProjects().map((p) => ({ name: p.name, mode: p.entry.mode, current: p.name === name })),
    switch: (next) => {
      const run = chain.then(() => doSwitch(next))
      // Keep the chain alive even if this switch rejects (its caller still sees the error).
      chain = run.catch(() => undefined)
      return run
    },
    sync: () => store.sync(),
    close: () => store.close(),
    enter,
    leave,
  }
}

/**
 * A fixed-store provider over a pre-opened Kysely handle (tests + `app.request()`).
 * Switching/syncing are no-ops; the caller owns the db lifecycle.
 */
export function staticProvider(db: Kysely<Database>): StoreProvider {
  return {
    db: () => db,
    status: () => ({ project: 'test', mode: 'local', location: ':test:', noSync: true }),
    projects: () => [{ name: 'test', mode: 'local', current: true }],
    switch: async () => ({ project: 'test', mode: 'local', location: ':test:', noSync: true }),
    sync: async () => undefined,
    close: async () => undefined,
    enter: () => undefined,
    leave: () => undefined,
  }
}
