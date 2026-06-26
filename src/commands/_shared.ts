import type { Command } from 'commander'
import type { Kysely } from 'kysely'
import { type Context, getContext } from '../core/contexts'
import type { DbOpts } from '../core/paths'
import type { Database } from '../core/types'

/** Pull the inherited global store flags (--db/--global/--local/--project/--no-sync). */
export function dbOptsFrom(command: Command): DbOpts {
  const o = command.optsWithGlobals()
  // commander exposes `--no-sync` as `o.sync === false`.
  return {
    db: o.db,
    global: o.global,
    local: o.local,
    project: o.project,
    noSync: o.sync === false,
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
    throw new Error(`${id} is a wiki page — use \`bctx wiki get/show/rm\` instead.`)
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
