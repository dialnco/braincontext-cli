import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { DbTarget } from './db'

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
  mkdirSync(homeDir(), { recursive: true })
  atomicWrite(configPath(), `${JSON.stringify(cfg, null, 2)}\n`)
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
  mkdirSync(homeDir(), { recursive: true })
  atomicWrite(credentialsPath(), `${JSON.stringify(creds, null, 2)}\n`, 0o600)
}

/** Persist (or clear, with `null`) a project's auth token in credentials.json. */
export function setToken(name: string, token: string | null): void {
  const creds = readCredentials()
  if (token === null) delete creds[name]
  else creds[name] = token
  writeCredentials(creds)
}

function tokenEnvKey(name: string): string {
  return `BCTX_TOKEN_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`
}

/** Resolve a project's token: `BCTX_TOKEN_<NAME>` env wins, else credentials.json. */
export function resolveToken(name: string): string | undefined {
  return process.env[tokenEnvKey(name)] ?? readCredentials()[name]
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

export function setCurrent(name: string): void {
  const cfg = readConfig()
  if (!cfg.projects[name]) throw new Error(`No such project: "${name}". Run \`bctx project list\`.`)
  cfg.currentProject = name
  writeConfig(cfg)
}

export function addProject(
  name: string,
  entry: ProjectEntry,
  opts: { setCurrent?: boolean } = {},
): void {
  validateProjectName(name)
  const cfg = readConfig()
  if (cfg.projects[name]) throw new Error(`Project already exists: "${name}".`)
  cfg.projects[name] = entry
  if (opts.setCurrent) cfg.currentProject = name
  writeConfig(cfg)
}

export function updateProject(name: string, patch: Partial<ProjectEntry>): void {
  const cfg = readConfig()
  const e = cfg.projects[name]
  if (!e) throw new Error(`No such project: "${name}".`)
  cfg.projects[name] = { ...e, ...patch }
  writeConfig(cfg)
}

export function removeProject(name: string): ProjectEntry {
  if (name === DEFAULT_PROJECT) throw new Error(`Cannot remove the "${DEFAULT_PROJECT}" project.`)
  const cfg = readConfig()
  const e = cfg.projects[name]
  if (!e) throw new Error(`No such project: "${name}".`)
  delete cfg.projects[name]
  if (cfg.currentProject === name) cfg.currentProject = DEFAULT_PROJECT
  writeConfig(cfg)
  setToken(name, null)
  return e
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
