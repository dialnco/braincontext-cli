import { Command } from 'commander'
import { runMcpStdio } from '../mcp/run'
import { dbOptsFrom } from './_shared'

export function mcpCommand(): Command {
  return new Command('mcp')
    .description('Run an MCP (Model Context Protocol) stdio server over the store for AI agents.')
    .addHelpText(
      'after',
      `
Register with Claude Code:
  $ claude mcp add --transport stdio bctx -- bctx mcp

Or in .mcp.json:
  { "mcpServers": { "bctx": { "type": "stdio", "command": "bctx", "args": ["mcp"] } } }

Target a project with --project <name> (or BCTX_PROJECT). Concurrent agents/sessions can
share one store safely. Caveat: for an ONLINE (replica) project this server owns the local
replica file — don't also run \`bctx\` CLI writes against the same project on this machine
while it runs; route writes through the server or use a separate device.
`,
    )
    .action(async (_opts, command: Command) => {
      await runMcpStdio(dbOptsFrom(command))
    })
}
