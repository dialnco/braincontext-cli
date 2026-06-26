import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { DbTarget } from './db'
import { DEFAULT_PROJECT, getProject, projectToTarget, readConfig } from './registry'

const STORE_DIR = '.braincontext'
const STORE_FILE = 'store.db'

export interface DbOpts {
  /** Explicit path to a SQLite file. Highest precedence. */
  db?: string
  /** Force the global store (~/.braincontext/store.db). */
  global?: boolean
  /** Force the project store (./.braincontext/store.db). */
  local?: boolean
  /** Named project from the registry (~/.braincontext/config.json). */
  project?: string
  /** Skip replica sync for this operation (faster; may read/write stale). */
  noSync?: boolean
}

/** ~/.braincontext/store.db */
export function globalDbPath(): string {
  return join(homedir(), STORE_DIR, STORE_FILE)
}

/** <cwd>/.braincontext/store.db */
export function localDbPath(cwd: string = process.cwd()): string {
  return join(cwd, STORE_DIR, STORE_FILE)
}

/**
 * Resolve which store path to read/write.
 * Precedence: explicit --db > --global/--local flags > project store if present > global store.
 */
export function resolveDbPath(opts: DbOpts = {}): string {
  if (opts.db) return opts.db
  if (opts.global) return globalDbPath()
  if (opts.local) return localDbPath()
  const local = localDbPath()
  return existsSync(local) ? local : globalDbPath()
}

/**
 * Resolve a connection target (local file / embedded replica / remote).
 *
 * Precedence:
 *   1. `--db <path>` / `BCTX_DB`            → explicit local file
 *   2. `--global` / `--local`              → forced legacy store paths
 *   3. `--project <name>` / `BCTX_PROJECT` → named project from the registry
 *   4. an explicitly-selected current project (not `default`)
 *   5. a project store in the cwd (`./.braincontext/store.db`) if present
 *   6. the current/`default` project → the global store (`~/.braincontext/store.db`)
 */
export function resolveTarget(opts: DbOpts = {}): DbTarget {
  if (opts.db) return { mode: 'local', file: opts.db }
  if (process.env.BCTX_DB) return { mode: 'local', file: process.env.BCTX_DB }
  if (opts.global) return { mode: 'local', file: globalDbPath() }
  if (opts.local) return { mode: 'local', file: localDbPath() }

  const named = opts.project ?? process.env.BCTX_PROJECT
  if (named) {
    const entry = getProject(named)
    if (!entry) throw new Error(`No such project: "${named}". Run \`bctx project list\`.`)
    return projectToTarget(named, entry)
  }

  const cfg = readConfig()
  const resolveCurrent = (): DbTarget => {
    const entry = cfg.projects[cfg.currentProject]
    return entry
      ? projectToTarget(cfg.currentProject, entry)
      : { mode: 'local', file: globalDbPath() }
  }
  // An explicitly-chosen project wins over the cwd auto-detect below.
  if (cfg.currentProject !== DEFAULT_PROJECT && cfg.projects[cfg.currentProject]) {
    return resolveCurrent()
  }
  // Back-compat: a project-local store in the working directory.
  const local = localDbPath()
  if (existsSync(local)) return { mode: 'local', file: local }
  // The current (default) project → the global store.
  return resolveCurrent()
}
