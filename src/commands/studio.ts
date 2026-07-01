import { Command } from 'commander'
import { runStudio } from '../studio/run'
import { dbOptsFrom, parsePositiveInt } from './_shared'

export function studioCommand(): Command {
  return new Command('studio')
    .description('Serve the braincontext Studio web UI + JSON API over the store (localhost only).')
    .option('-p, --port <number>', 'port to bind (default 8420; auto-increments if busy)')
    .option('--no-open', 'do not open the Studio UI in a browser on startup')
    .addHelpText(
      'after',
      `
Binds 127.0.0.1 only — the API exposes store contents, so it is NOT reachable from other
machines. Target a project with --project <name> (or BCTX_PROJECT). Like \`bctx mcp\`, this owns
the store while running; for an ONLINE (replica) project don't also run \`bctx\` CLI writes
against the same project on this machine while it runs.
`,
    )
    .action(async (opts, command: Command) => {
      await runStudio({
        ...dbOptsFrom(command),
        port: parsePositiveInt(opts.port, 'port'),
        open: opts.open,
      })
    })
}
