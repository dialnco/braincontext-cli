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
`,
    )
    .action(async (_opts, command: Command) => {
      await runMcpStdio(dbOptsFrom(command))
    })
}
