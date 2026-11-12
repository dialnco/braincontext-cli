import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homeDir } from '../core/registry'
import { accent, bold, dim, isInteractive } from './ansi'
import { getVersion } from './pkg'

/**
 * "A newer bctx is published" notice — the update-notifier pattern, without the
 * dependency:
 *
 * - It NEVER delays a command. The registry lookup runs in a detached child process
 *   at most once a day, and only writes a small cache (`~/.braincontext/update-check.json`).
 *   The notice itself is printed from that cache, so it shows on the run AFTER the
 *   check found something.
 * - It goes to stderr only, so `--json` / piped stdout stays clean.
 * - Off for CI, tests, `bctx mcp` (a stdio protocol), and `bctx inbox hook` (its output
 *   feeds an agent's context). Opt out with `BCTX_NO_UPDATE_CHECK=1` (or the common
 *   `NO_UPDATE_NOTIFIER`).
 * - In a terminal it shows on every run until you upgrade; for agents/pipes, at most
 *   once a day per version, so a busy agent session isn't spammed.
 */

export const PACKAGE_NAME = 'braincontext-cli'
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000
const NOTIFY_EVERY_MS = 24 * 60 * 60 * 1000
const DEFAULT_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`
const RELEASES_URL = 'https://github.com/dialnco/braincontext-cli/releases'

export interface UpdateCache {
  /** Last time a check was STARTED (also throttles retries while offline). */
  checkedAt?: string
  /** The registry's `latest` dist-tag at the last successful check. */
  latest?: string
  /** Version + time of the last non-interactive notice (once-a-day throttle). */
  notifiedVersion?: string
  notifiedAt?: string
}

export function cachePath(): string {
  return join(homeDir(), 'update-check.json')
}

function readCache(file: string): UpdateCache {
  try {
    const v: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return v && typeof v === 'object' ? (v as UpdateCache) : {}
  } catch {
    return {}
  }
}

function writeCache(file: string, cache: UpdateCache): void {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(cache))
  } catch {
    // A read-only home just means no notices.
  }
}

/** `a` is a strictly newer release than `b` (x.y.z; a pre-release never counts as newer). */
export function isNewer(a: string, b: string): boolean {
  const parse = (v: string) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(v.trim())
    return m ? { n: [Number(m[1]), Number(m[2]), Number(m[3])], pre: !!m[4] } : null
  }
  const x = parse(a)
  const y = parse(b)
  if (!x || !y || x.pre) return false
  for (let i = 0; i < 3; i++) {
    if (x.n[i] !== y.n[i]) return (x.n[i] ?? 0) > (y.n[i] ?? 0)
  }
  return y.pre // same x.y.z: the release is newer than its own pre-release
}

/** The positional words of argv (`bctx --project p inbox hook` → ['inbox','hook']). */
function positionals(argv: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? ''
    if (a === '--db' || a === '--project') i++
    else if (!a.startsWith('-')) out.push(a)
  }
  return out
}

/** Whether this invocation should check/notify at all. */
export function updateCheckEnabled(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.BCTX_NO_UPDATE_CHECK || env.NO_UPDATE_NOTIFIER || env.CI) return false
  if (env.VITEST || env.NODE_ENV === 'test') return false
  const [cmd, sub] = positionals(argv)
  if (cmd === 'mcp') return false
  if (cmd === 'inbox' && sub === 'hook') return false
  return true
}

export function formatNotice(current: string, latest: string, color = isInteractive): string {
  const c = (f: (s: string) => string, s: string) => (color ? f(s) : s)
  return [
    '',
    `${c(accent, 'bctx')}: update available ${c(dim, current)} → ${c(bold, latest)}`,
    `  upgrade:     npm i -g ${PACKAGE_NAME}@latest`,
    `  what's new:  ${RELEASES_URL}/tag/v${latest}`,
    c(dim, '  (silence with BCTX_NO_UPDATE_CHECK=1)'),
    '',
  ].join('\n')
}

/**
 * Decide what to do from the cache alone (pure — the caller does the I/O): whether
 * to print a notice, whether to start a background check, and the cache to persist.
 */
export function planUpdateCheck(
  cache: UpdateCache,
  current: string,
  now: number,
  interactive: boolean,
): { notice: string | null; check: boolean; next: UpdateCache | null } {
  let next: UpdateCache | null = null
  let notice: string | null = null
  if (cache.latest && isNewer(cache.latest, current)) {
    const recentlyNotified =
      cache.notifiedVersion === cache.latest &&
      !!cache.notifiedAt &&
      now - Date.parse(cache.notifiedAt) < NOTIFY_EVERY_MS
    if (interactive || !recentlyNotified) {
      notice = formatNotice(current, cache.latest, interactive)
      if (!interactive) {
        next = {
          ...cache,
          notifiedVersion: cache.latest,
          notifiedAt: new Date(now).toISOString(),
        }
      }
    }
  }
  const last = cache.checkedAt ? Date.parse(cache.checkedAt) : Number.NaN
  const check = !(now - last < CHECK_EVERY_MS)
  if (check) next = { ...(next ?? cache), checkedAt: new Date(now).toISOString() }
  return { notice, check, next }
}

// Runs in a detached child (`node -e`, CommonJS): fetch `latest`, merge it into the
// cache. Any failure is silent — the next attempt is a day later (checkedAt was set).
const CHILD_SCRIPT = `
const fs = require('node:fs');
const file = process.env.BCTX_UPDATE_CACHE, url = process.env.BCTX_UPDATE_URL;
fetch(url, { signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' } })
  .then((r) => (r.ok ? r.json() : null))
  .then((j) => {
    if (!j || typeof j.version !== 'string') return;
    let c = {};
    try { c = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch {}
    c.latest = j.version;
    fs.writeFileSync(file, JSON.stringify(c));
  })
  .catch(() => {});
`

/** Entry point from cli.ts: print a known update, refresh the cache in the background. */
export function runUpdateCheck(): void {
  if (!updateCheckEnabled()) return
  try {
    const file = cachePath()
    const plan = planUpdateCheck(readCache(file), getVersion(), Date.now(), isInteractive)
    if (plan.next) writeCache(file, plan.next)
    if (plan.notice) process.stderr.write(`${plan.notice}\n`)
    if (plan.check) {
      const child = spawn(process.execPath, ['-e', CHILD_SCRIPT], {
        detached: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          BCTX_UPDATE_CACHE: file,
          BCTX_UPDATE_URL: process.env.BCTX_UPDATE_URL || DEFAULT_URL,
        },
      })
      child.on('error', () => undefined)
      child.unref()
    }
  } catch {
    // Never let the notice break a command.
  }
}
