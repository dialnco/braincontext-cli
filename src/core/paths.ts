import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const STORE_DIR = '.braincontext'
const STORE_FILE = 'store.db'

export interface DbOpts {
  /** Explicit path to a SQLite file. Highest precedence. */
  db?: string
  /** Force the global store (~/.braincontext/store.db). */
  global?: boolean
  /** Force the project store (./.braincontext/store.db). */
  local?: boolean
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
 * Resolve which store to read/write.
 * Precedence: explicit --db > --global/--local flags > project store if present > global store.
 */
export function resolveDbPath(opts: DbOpts = {}): string {
  if (opts.db) return opts.db
  if (opts.global) return globalDbPath()
  if (opts.local) return localDbPath()
  const local = localDbPath()
  return existsSync(local) ? local : globalDbPath()
}
