import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { DbTarget } from './db'
import { withFileLockSync } from './lock'

/** Write atomically (temp file + rename) so a concurrent reader/crash never sees a
 * half-written or truncated registry file. */
function atomicWrite(path: string, data: string, mode?: number): void {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, data, mode !== undefined ? { mode } : 'utf8')
  renameSync(tmp, path)
  if (mode !== undefined) {
    try {
      chmodSync(path, mode)
    } catch {
      // best-effort on platforms without POSIX perms
    }
  }
}

/** Create the home dir owner-only (0700) — it holds store files, config, and remote URLs. */
function ensureHome(): string {
  const dir = homeDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    chmodSync(dir, 0o700) // tighten even if it pre-existed with looser perms
  } catch {
    // best-effort on platforms without POSIX perms
  }
  return dir
}

const HOME_DIR = '.braincontext'
const CONFIG_FILE = 'config.json'
const CREDENTIALS_FILE = 'credentials.json'
const PROJECTS_SUBDIR = 'projects'
const STORE_FILE = 'store.db'

/** The implicit project backed by the legacy global store (`~/.braincontext/store.db`). */
export const DEFAULT_PROJECT = 'default'

export type ProjectMode = 'local' | 'replica' | 'remote'

export interface ProjectEntry {
  mode: ProjectMode
  /** Local file, relative to the home dir (local/replica). Absolute paths honored. */
  file?: string
  /** Remote primary URL (replica/remote). */
  syncUrl?: string
  /** Background sync interval in seconds (replica). */
  syncInterval?: number
  createdAt: string
}

export interface Config {
  version: number
  currentProject: string
  projects: Record<string, ProjectEntry>
}

/** Root of the braincontext home. `BCTX_HOME` overrides it (used by tests). */
export function homeDir(): string {
  return process.env.BCTX_HOME || join(homedir(), HOME_DIR)
}
function configPath(): string {
  return join(homeDir(), CONFIG_FILE)
}
function credentialsPath(): string {
  return join(homeDir(), CREDENTIALS_FILE)
}
/** Directory holding per-project local files: `~/.braincontext/projects/`. */
export function projectsDir(): string {
  return join(homeDir(), PROJECTS_SUBDIR)
}
/** Default relative path for a named project's local file. */
export function defaultProjectFile(name: string): string {
  return join(PROJECTS_SUBDIR, `${name}.db`)
}

const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i
export function validateProjectName(name: string): void {
  if (!NAME_RE.test(name) || name.includes('..')) {
    throw new Error(`Invalid project name: "${name}" (use letters, digits, '-', '_', '.').`)
  }
}

function defaultEntry(): ProjectEntry {
  return { mode: 'local', file: STORE_FILE, createdAt: new Date().toISOString() }
}

/** Read the registry, healing missing/invalid pieces and always providing `default`. */
export function readConfig(): Config {
  const fallback: Config = {
    version: 1,
    currentProject: DEFAULT_PROJECT,
    projects: { [DEFAULT_PROJECT]: defaultEntry() },
  }
  const p = configPath()
  if (!existsSync(p)) return fallback
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<Config>
    if (!raw || typeof raw !== 'object' || !raw.projects || typeof raw.projects !== 'object') {
      return fallback
    }
    const cfg: Config = {
      version: typeof raw.version === 'number' ? raw.version : 1,
      currentProject: raw.currentProject ?? DEFAULT_PROJECT,
      projects: raw.projects as Record<string, ProjectEntry>,
    }
    if (!cfg.projects[DEFAULT_PROJECT]) cfg.projects[DEFAULT_PROJECT] = defaultEntry()
    if (!cfg.projects[cfg.currentProject]) cfg.currentProject = DEFAULT_PROJECT
    return cfg
  } catch {
    return fallback
  }
}

export function writeConfig(cfg: Config): void {
  ensureHome()
  // 0600: config.json holds remote primary URLs (and project topology) — owner-only.
  atomicWrite(configPath(), `${JSON.stringify(cfg, null, 2)}\n`, 0o600)
}

// ── Credentials (tokens) live apart from config.json, with 0600 perms ──────────

/**
 * Per-project secrets. Two distinct things, both bearer credentials:
 *  - `authToken` — the libSQL token that reaches the remote primary;
 *  - `accessKey` — this member's bctx key, which decides what they may do
 *    (see core/access). Absent for projects without access control.
 */
export interface ProjectCredentials {
  authToken?: string
  accessKey?: string
}

/** On disk an entry is either the object form or a bare token string (pre-0.9). */
type StoredCredentials = Record<string, string | ProjectCredentials>

function readCredentials(): Record<string, ProjectCredentials> {
  const p = credentialsPath()
  if (!existsSync(p)) return {}
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8'))
    if (!raw || typeof raw !== 'object') return {}
    const out: Record<string, ProjectCredentials> = {}
    for (const [name, value] of Object.entries(raw as StoredCredentials)) {
      // Legacy entries are the token itself; normalize on read so callers see one shape.
      if (typeof value === 'string') out[name] = { authToken: value }
      else if (value && typeof value === 'object') {
        out[name] = {
          authToken: typeof value.authToken === 'string' ? value.authToken : undefined,
          accessKey: typeof value.accessKey === 'string' ? value.accessKey : undefined,
        }
      }
    }
    return out
  } catch {
    return {}
  }
}

function writeCredentials(creds: Record<string, ProjectCredentials>): void {
  ensureHome()
  const out: StoredCredentials = {}
  for (const [name, value] of Object.entries(creds)) {
    if (!value.authToken && !value.accessKey) continue
    // Keep the legacy string shape when there is nothing else to store, so a store
    // that never uses access control stays readable by an older bctx.
    out[name] = value.accessKey ? value : (value.authToken as string)
  }
  atomicWrite(credentialsPath(), `${JSON.stringify(out, null, 2)}\n`, 0o600)
}

function mutateCredential(name: string, patch: ProjectCredentials): void {
  const creds = readCredentials()
  creds[name] = { ...creds[name], ...patch }
  writeCredentials(creds)
}

/** Persist (or clear, with `null`) a project's auth token in credentials.json. */
export function setToken(name: string, token: string | null): void {
  mutateCredential(name, { authToken: token ?? undefined })
}

/** Persist (or clear, with `null`) this member's bctx access key for a project. */
export function setAccessKey(name: string, key: string | null): void {
  mutateCredential(name, { accessKey: key ?? undefined })
}

/** Forget every secret held for a project. */
export function clearCredentials(name: string): void {
  const creds = readCredentials()
  delete creds[name]
  writeCredentials(creds)
}

/**
 * Env-var key for a per-project secret, or null when the name can't map unambiguously.
 * Env var names allow only `[A-Z0-9_]`, so a name with `.`/`-` would collapse to `_` and
 * could collide with a *different* project (sending the wrong token to the wrong remote).
 * For those, we expose no env override — credentials.json is keyed by the exact name.
 */
function envKey(prefix: string, name: string): string | null {
  return /^[A-Za-z0-9_]+$/.test(name) ? `${prefix}${name.toUpperCase()}` : null
}

/** Resolve a project's token: `BCTX_TOKEN_<NAME>` env wins, else credentials.json. */
export function resolveToken(name: string): string | undefined {
  const key = envKey('BCTX_TOKEN_', name)
  const fromEnv = key ? process.env[key] : undefined
  return fromEnv ?? readCredentials()[name]?.authToken
}

/**
 * Resolve this member's access key: `BCTX_KEY_<NAME>` env, then credentials.json,
 * then the unscoped `BCTX_KEY`.
 *
 * The unscoped fallback exists because a `--db <path>` target has no project name
 * to key on. It is safe to try against the wrong project: a key only verifies
 * against the store that issued it, so a mismatch fails authentication rather than
 * granting anything.
 */
export function resolveAccessKey(name?: string): string | undefined {
  if (name) {
    const key = envKey('BCTX_KEY_', name)
    const fromEnv = key ? process.env[key] : undefined
    if (fromEnv) return fromEnv
    const stored = readCredentials()[name]?.accessKey
    if (stored) return stored
  }
  return process.env.BCTX_KEY || undefined
}

// ── Project CRUD ───────────────────────────────────────────────────────────────

export interface ProjectListing {
  name: string
  entry: ProjectEntry
  current: boolean
}

export function listProjects(): ProjectListing[] {
  const cfg = readConfig()
  return Object.entries(cfg.projects).map(([name, entry]) => ({
    name,
    entry,
    current: name === cfg.currentProject,
  }))
}

export function getProject(name: string): ProjectEntry | undefined {
  return readConfig().projects[name]
}

export function currentProjectName(): string {
  return readConfig().currentProject
}

/** Read-modify-write the config under a cross-process lock so two concurrent `bctx project`
 *  commands can't lose an update (atomic writes alone prevent torn files, not lost updates). */
function mutateConfig(mutate: (cfg: Config) => void): void {
  ensureHome()
  withFileLockSync(join(homeDir(), 'config.lock'), () => {
    const cfg = readConfig()
    mutate(cfg)
    writeConfig(cfg)
  })
}

export function setCurrent(name: string): void {
  mutateConfig((cfg) => {
    if (!cfg.projects[name]) {
      throw new Error(`No such project: "${name}". Run \`bctx project list\`.`)
    }
    cfg.currentProject = name
  })
}

export function addProject(
  name: string,
  entry: ProjectEntry,
  opts: { setCurrent?: boolean } = {},
): void {
  validateProjectName(name)
  mutateConfig((cfg) => {
    if (cfg.projects[name]) throw new Error(`Project already exists: "${name}".`)
    cfg.projects[name] = entry
    if (opts.setCurrent) cfg.currentProject = name
  })
}

export function updateProject(name: string, patch: Partial<ProjectEntry>): void {
  mutateConfig((cfg) => {
    const e = cfg.projects[name]
    if (!e) throw new Error(`No such project: "${name}".`)
    cfg.projects[name] = { ...e, ...patch }
  })
}

export function removeProject(name: string): ProjectEntry {
  if (name === DEFAULT_PROJECT) throw new Error(`Cannot remove the "${DEFAULT_PROJECT}" project.`)
  let removed: ProjectEntry | undefined
  mutateConfig((cfg) => {
    const e = cfg.projects[name]
    if (!e) throw new Error(`No such project: "${name}".`)
    removed = e
    delete cfg.projects[name]
    if (cfg.currentProject === name) cfg.currentProject = DEFAULT_PROJECT
  })
  clearCredentials(name)
  // mutateConfig throws above if the project was missing, so `removed` is always set here.
  return removed as ProjectEntry
}

/** Absolute local file path for a project entry (relative paths resolve under home). */
export function projectFilePath(entry: ProjectEntry): string {
  const f = entry.file ?? STORE_FILE
  return isAbsolute(f) ? f : join(homeDir(), f)
}

/** Convert a registry entry into a connection target (local/replica/remote). */
export function projectToTarget(name: string, entry: ProjectEntry): DbTarget {
  if (entry.mode === 'remote') {
    if (!entry.syncUrl) throw new Error(`Project "${name}" is remote but has no syncUrl.`)
    return { mode: 'remote', url: entry.syncUrl, authToken: resolveToken(name), project: name }
  }
  const file = projectFilePath(entry)
  if (entry.mode === 'replica') {
    if (!entry.syncUrl) throw new Error(`Project "${name}" is a replica but has no syncUrl.`)
    return {
      mode: 'replica',
      file,
      syncUrl: entry.syncUrl,
      authToken: resolveToken(name),
      syncInterval: entry.syncInterval,
      project: name,
    }
  }
  return { mode: 'local', file, project: name }
}
