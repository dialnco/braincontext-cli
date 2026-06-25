import type { Command } from 'commander'
import type { DbOpts } from '../core/paths'

/** Pull the inherited global store flags (--db/--global/--local) off a command. */
export function dbOptsFrom(command: Command): DbOpts {
  const o = command.optsWithGlobals()
  return { db: o.db, global: o.global, local: o.local }
}

/** commander reducer for repeatable options (--add-tag a --add-tag b). */
export function collect(value: string, previous: string[]): string[] {
  return [...previous, value]
}

/** Split a comma-separated option value into trimmed, non-empty parts. */
export function splitCsv(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}
