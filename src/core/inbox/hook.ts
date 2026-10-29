import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { ulid } from 'ulidx'
import { homeDir } from '../registry'
import type { InboxSummary } from './threads'

/**
 * Agent-hook support. A hook runs on every session start and every prompt, so it
 * must be fast and must never fail or block: it only ever READS a small cache file,
 * and refreshes that cache from the primary in a detached background process when
 * it is stale. The cache holds counts and thread numbers only — never titles or
 * bodies (another member's text must not land in a high-trust context unasked).
 */

export const HOOK_CACHE_TTL_MS = 60_000

export interface HookCache {
  at: string
  project: string | null
  handle: string
  summary: InboxSummary
  /** Highest seq already announced on UserPromptSubmit (announce only what is new). */
  notifiedSeq: number
}

function cacheFile(project: string | null): string {
  const safe = (project ?? 'default').replace(/[^a-zA-Z0-9._-]/g, '_')
  return join(homeDir(), 'inbox', `${safe}.json`)
}

export function readHookCache(project: string | null): HookCache | null {
  try {
    return JSON.parse(readFileSync(cacheFile(project), 'utf8')) as HookCache
  } catch {
    return null
  }
}

/** Atomic, owner-only write (temp file + rename, mode 0600). */
export function writeHookCache(project: string | null, cache: HookCache): void {
  const file = cacheFile(project)
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(cache), { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, file)
}

export function isFresh(cache: HookCache | null, now = Date.now()): boolean {
  return !!cache && now - Date.parse(cache.at) < HOOK_CACHE_TTL_MS
}

export type HookEvent = 'session-start' | 'prompt'

/**
 * Persist a per-session id for the agent's later Bash calls. Claude Code gives
 * SessionStart hooks a `CLAUDE_ENV_FILE` whose `export` lines apply to every
 * subsequent command in that session — which is how `bctx inbox` tells two of the
 * same member's sessions apart (claims, and `wait` not waking on its own messages).
 */
export function exportSessionId(envFile: string | undefined): string | null {
  if (!envFile || process.env.BCTX_SESSION) return process.env.BCTX_SESSION ?? null
  const id = `cc-${ulid()}`
  try {
    writeFileSync(envFile, `export BCTX_SESSION=${id}\n`, { flag: 'a' })
    return id
  } catch {
    return null
  }
}

// ── Installer ──────────────────────────────────────────────────────────────────

export type HookScope = 'project' | 'user'

export function claudeSettingsPath(scope: HookScope, cwd = process.cwd()): string {
  return scope === 'user'
    ? join(homedir(), '.claude', 'settings.json')
    : join(cwd, '.claude', 'settings.json')
}

interface HookEntry {
  matcher?: string
  hooks: Array<{ type: string; command: string; timeout?: number }>
}

/**
 * Merge the inbox hooks into a Claude Code settings file. Idempotent: an entry
 * whose command already invokes `bctx inbox hook` for that event is left alone.
 * Returns what was added (empty when nothing changed).
 */
export function installClaudeHooks(
  file: string,
  opts: { project?: string; dryRun?: boolean } = {},
): { added: string[]; content: string } {
  let settings: Record<string, unknown> = {}
  if (existsSync(file)) {
    const raw = readFileSync(file, 'utf8')
    try {
      settings = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {}
    } catch {
      throw new Error(`${file} is not valid JSON — fix it first; nothing was changed.`)
    }
  }
  const hooks = (settings.hooks ?? {}) as Record<string, HookEntry[]>
  const projectFlag = opts.project ? ` --project ${opts.project}` : ''
  const wanted: Array<[string, string]> = [
    ['SessionStart', `bctx${projectFlag} inbox hook --event session-start`],
    ['UserPromptSubmit', `bctx${projectFlag} inbox hook --event prompt`],
  ]
  const added: string[] = []
  for (const [event, command] of wanted) {
    const entries = Array.isArray(hooks[event]) ? hooks[event] : []
    const present = entries.some((e) =>
      e?.hooks?.some((h) => typeof h.command === 'string' && h.command.includes('inbox hook')),
    )
    if (present) continue
    entries.push({ hooks: [{ type: 'command', command, timeout: 5 }] })
    hooks[event] = entries
    added.push(`${event}: ${command}`)
  }
  settings.hooks = hooks
  const content = `${JSON.stringify(settings, null, 2)}\n`
  if (added.length && !opts.dryRun) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content)
  }
  return { added, content }
}
