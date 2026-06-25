#!/usr/bin/env node
import { Command } from 'commander'
import { addCommand } from './commands/add'
import { getCommand } from './commands/get'
import { initCommand } from './commands/init'
import { listCommand } from './commands/list'
import { rmCommand } from './commands/rm'
import { searchCommand } from './commands/search'
import { skillsCommand } from './commands/skills'
import { updateCommand } from './commands/update'
import { getVersion } from './lib/pkg'

const program = new Command()

program
  .name('bctx')
  .description('braincontext — a local-first context store shared across AI agents')
  .version(getVersion(), '-v, --version')
  .option('--db <path>', 'explicit path to the SQLite store')
  .option('--global', 'use the global store (~/.braincontext/store.db)')
  .option('--local', 'use the project store (./.braincontext/store.db)')

program.addCommand(initCommand())
program.addCommand(addCommand())
program.addCommand(getCommand())
program.addCommand(listCommand())
program.addCommand(updateCommand())
program.addCommand(rmCommand())
program.addCommand(searchCommand())
program.addCommand(skillsCommand())

program.addHelpText(
  'after',
  `
Examples:
  $ bctx init --global
  $ echo "Use pnpm, never npm" | bctx add --kind rule --tags tooling,policy --agent claude
  $ bctx list --kind rule --json
  $ bctx search "pnpm"
  $ bctx update <id> --add-tag important --set-meta source=meeting
  $ bctx skills get braincontext --full

Store precedence: --db > --global/--local > ./.braincontext (if present) > ~/.braincontext
`,
)

try {
  await program.parseAsync(process.argv)
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
}
