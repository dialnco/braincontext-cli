#!/usr/bin/env node
import { Command } from 'commander'
import { addCommand } from './commands/add'
import { exportCommand } from './commands/export'
import { getCommand } from './commands/get'
import { initCommand } from './commands/init'
import { listCommand } from './commands/list'
import { mcpCommand } from './commands/mcp'
import { rmCommand } from './commands/rm'
import { searchCommand } from './commands/search'
import { skillCommand } from './commands/skill'
import { skillsCommand } from './commands/skills'
import { updateCommand } from './commands/update'
import { wikiCommand } from './commands/wiki'
import { getVersion } from './lib/pkg'

const program = new Command()

program
  .name('bctx')
  .description(
    'braincontext — a local-first context store for AI agents.\n' +
      'Preferred workflow: build a linked knowledge wiki (bctx wiki). The direct\n' +
      'context commands (add/get/list/search/update/rm) are for individual entries.',
  )
  .version(getVersion(), '-v, --version')
  .option('--db <path>', 'explicit path to the SQLite store')
  .option('--global', 'use the global store (~/.braincontext/store.db)')
  .option('--local', 'use the project store (./.braincontext/store.db)')

program.addCommand(initCommand())
// Preferred workflow first.
program.addCommand(wikiCommand())
// Direct context operations (individual entries).
program.addCommand(addCommand())
program.addCommand(getCommand())
program.addCommand(listCommand())
program.addCommand(updateCommand())
program.addCommand(rmCommand())
program.addCommand(searchCommand())
// Agent-facing surfaces.
program.addCommand(skillsCommand())
program.addCommand(skillCommand())
program.addCommand(exportCommand())
program.addCommand(mcpCommand())

program.addHelpText(
  'after',
  `
Preferred — knowledge wiki (durable, linked, compounding):
  $ bctx wiki ingest ./article.md --title "TLS notes"   # store a source + synthesis checklist
  $ echo "See [[Gateway]]." | bctx wiki new "OAuth2" --type concept --file -
  $ bctx wiki link "OAuth2" "Gateway" --type relates
  $ bctx wiki search "tls"   ·   bctx wiki lint   ·   bctx wiki index
  $ bctx skills get braincontext-wiki --full           # the wiki-maintainer playbook

Individual context operations (single entries — CRUD):
  $ echo "Use pnpm, never npm" | bctx add --kind rule --tags tooling --agent claude
  $ bctx list --kind rule --json   ·   bctx search "pnpm"   ·   bctx get <id>
  $ bctx update <id> --add-tag important   ·   bctx rm <id>

Wiki pages are hidden from plain list/search (use --include-wiki to include them).
Store precedence: --db > --global/--local > ./.braincontext (if present) > ~/.braincontext
`,
)

try {
  await program.parseAsync(process.argv)
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
}
