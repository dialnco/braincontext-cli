import { Command } from 'commander'
import { type UpdateInput, updateContext } from '../core/contexts'
import { withDb } from '../core/db'
import { formatContext } from '../lib/format'
import { resolveBody } from '../lib/stdin'
import { collect, dbOptsFrom } from './_shared'

export function updateCommand(): Command {
  return new Command('update')
    .description('Update a context: title, body, tags, or metadata.')
    .argument('<id>', 'context id (ULID)')
    .option('--title <title>', 'set the title')
    .option('--body <text>', 'set the body inline')
    .option('--file <path>', 'set the body from a file (use - for stdin)')
    .option('--add-tag <tag>', 'add a tag (repeatable)', collect, [])
    .option('--rm-tag <tag>', 'remove a tag (repeatable)', collect, [])
    .option('--set-meta <k=v>', 'set a metadata key (repeatable)', collect, [])
    .option('--agent <name>', 'agent source label for this change')
    .option('--json', 'output JSON')
    .action(async (id: string, opts, command: Command) => {
      const patch: UpdateInput = {}
      if (opts.title !== undefined) patch.title = opts.title
      if (opts.body !== undefined) patch.body = opts.body
      else if (opts.file) patch.body = await resolveBody(opts.file, [])
      if (opts.addTag.length > 0) patch.addTags = opts.addTag
      if (opts.rmTag.length > 0) patch.removeTags = opts.rmTag
      if (opts.setMeta.length > 0) {
        const meta: Record<string, unknown> = {}
        for (const kv of opts.setMeta as string[]) {
          const i = kv.indexOf('=')
          if (i > 0) meta[kv.slice(0, i)] = kv.slice(i + 1)
        }
        patch.setMetadata = meta
      }
      if (opts.agent) patch.agentSource = opts.agent

      const ctx = await withDb(dbOptsFrom(command), (db) => updateContext(db, id, patch))
      if (!ctx) {
        console.error(`No context found with id ${id}`)
        process.exitCode = 1
        return
      }
      console.log(opts.json ? JSON.stringify(ctx, null, 2) : formatContext(ctx))
    })
}
