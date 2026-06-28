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

type Credentials = Record<string, string>

function readCredentials(): Credentials {
  const p = credentialsPath()
  if (!existsSync(p)) return {}
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8'))
    return raw && typeof raw === 'object' ? (raw as Credentials) : {}
  } catch {
    return {}
  }
}

function writeCredentials(creds: Credentials): void {
  ensureHome()
  atomicWrite(credentialsPath(), `${JSON.stringify(creds, null, 2)}\n`, 0o600)
}

/** Persist (or clear, with `null`) a project's auth token in credentials.json. */
export function setToken(name: string, token: string | null): void {
  const creds = readCredentials()
  if (token === null) delete creds[name]
  else creds[name] = token
  writeCredentials(creds)
}

/**
 * Env-var key for a project token, or null when the name can't map unambiguously. Env var
 * names allow only `[A-Z0-9_]`, so a name with `.`/`-` would collapse to `_` and could
 * collide with a *different* project (sending the wrong token to the wrong remote). For
 * those, we expose no env override — credentials.json is keyed by the exact name.
 */
function tokenEnvKey(name: string): string | null {
  return /^[A-Za-z0-9_]+$/.test(name) ? `BCTX_TOKEN_${name.toUpperCase()}` : null
}

/** Resolve a project's token: `BCTX_TOKEN_<NAME>` env wins, else credentials.json. */
export function resolveToken(name: string): string | undefined {
  const key = tokenEnvKey(name)
  const fromEnv = key ? process.env[key] : undefined
  return fromEnv ?? readCredentials()[name]
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
  setToken(name, null)
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
    return { mode: 'remote', url: entry.syncUrl, authToken: resolveToken(name) }
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
    }
  }
  return { mode: 'local', file }
}
