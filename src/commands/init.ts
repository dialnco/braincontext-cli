import { Command } from 'commander'
import { withDb } from '../core/db'
import { resolveTarget } from '../core/paths'
import { dbOptsFrom } from './_shared'

/** Human description of where a resolved target lives (file path or remote URL). */
function describeTarget(opts: ReturnType<typeof dbOptsFrom>): string {
  const t = resolveTarget(opts)
  return t.mode === 'remote' ? t.url : t.file
}

export function initCommand(): Command {
  return new Command('init')
    .description('Create and migrate the braincontext store for the resolved target (idempotent).')
    .action(async (_opts, command: Command) => {
      const opts = dbOptsFrom(command)
      // Use the same resolution every other command uses, so `init` honors
      // --db/--global/--local/--project, BCTX_DB/BCTX_PROJECT/BCTX_HOME, and the
      // current project. withDb opens, prepares (WAL/FK), syncs a replica, and
      // migrates — exactly what the store needs, for local/replica/remote alike.
      const where = describeTarget(opts)
      await withDb(opts, async () => {})
      console.log(`Initialized braincontext store at ${where}`)
      console.log(
        'Next: `bctx export` writes an AGENTS.md/CLAUDE.md preamble so agents discover and use\n' +
          '      the store; `bctx mcp` exposes it natively. See `bctx skills get braincontext`.',
      )
    })
}
