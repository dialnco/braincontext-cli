import type { Command } from 'commander'
import type { Kysely } from 'kysely'
import { resolveCommandCapability } from '../core/access/commands'
import { type Context, getContext } from '../core/contexts'
import type { DbOpts } from '../core/paths'
import type { Database } from '../core/types'

/**
 * The command's full path, root name excluded: `bctx wiki table set` → `wiki table set`.
 * The root program is the only Command without a parent, which is what stops the walk.
 */
export function commandPath(command: Command): string {
  const parts: string[] = []
  for (let c: Command | null = command; c?.parent; c = c.parent) parts.unshift(c.name())
  return parts.join(' ')
}

/**
 * Pull the inherited global store flags (--db/--global/--local/--project/--no-sync)
 * plus the access capability this command requires.
 *
 * Deriving the capability here — rather than at each of the ~70 call sites — is why
 * gating the CLI needed no changes inside the command handlers: every one of them
 * already funnels its store access through `withDb(dbOptsFrom(command), …)`.
 */
export function dbOptsFrom(command: Command): DbOpts {
  const o = command.optsWithGlobals()
  const action = commandPath(command)
  // commander exposes `--no-sync` as `o.sync === false`.
  return {
    db: o.db,
    global: o.global,
    local: o.local,
    project: o.project,
    noSync: o.sync === false,
    requires: resolveCommandCapability(action),
    action,
  }
}

/**
 * Fetch a context by id for the by-id context surfaces (get/update/rm). Throws if
 * the id is a wiki page — those go through `bctx wiki` (which keeps links + the
 * source-immutability invariant intact).
 */
export async function requireContext(db: Kysely<Database>, id: string): Promise<Context | null> {
  const ctx = await getContext(db, id)
  if (ctx && ctx.pageType !== null) {
    throw new Error(`${id} is a wiki page — use \`bctx wiki update/show/rm\` instead.`)
  }
  return ctx
}

/** commander reducer for repeatable options (--add-tag a --add-tag b). */
export function collect(value: string, previous: string[]): string[] {
  return [...previous, value]
}

/** Parse a CLI numeric option as a positive integer, or throw a clean error. */
export function parsePositiveInt(value: string | undefined, label = 'value'): number | undefined {
  if (value === undefined) return undefined
  const n = Number(value)
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid ${label}: "${value}" (expected a positive integer)`)
  }
  return n
}

/** Split a comma-separated option value into trimmed, non-empty parts. */
export function splitCsv(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}
