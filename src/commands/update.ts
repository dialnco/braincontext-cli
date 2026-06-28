import { Command } from 'commander'
import { z } from 'zod'
import { type UpdateInput, updateContext } from '../core/contexts'
import { withDb } from '../core/db'
import { KINDS, SCOPES } from '../core/types'
import { formatContext } from '../lib/format'
import { resolveBody } from '../lib/stdin'
import { collect, dbOptsFrom, requireContext } from './_shared'

export function updateCommand(): Command {
  return new Command('update')
    .description('Update a context: title, body, tags, metadata, or its kind/scope/namespace.')
    .argument('<id>', 'context id (ULID)')
    .option('--title <title>', 'set the title')
    .option('--body <text>', 'set the body inline')
    .option('--file <path>', 'set the body from a file (use - for stdin)')
    .option('--add-tag <tag>', 'add a tag (repeatable)', collect, [])
    .option('--rm-tag <tag>', 'remove a tag (repeatable)', collect, [])
    .option('--set-meta <k=v>', 'set a metadata key (repeatable)', collect, [])
    .option('--kind <kind>', `re-home the kind: ${KINDS.join(' | ')}`)
    .option('--scope <scope>', `re-home the scope: ${SCOPES.join(' | ')}`)
    .option('--namespace <ns>', 're-home the namespace')
    .option('--agent <name>', 'agent source label for this change')
    .option('--json', 'output JSON')
    .action(async (id: string, opts, command: Command) => {
      const patch: UpdateInput = {}
      if (opts.title !== undefined) patch.title = opts.title
      if (opts.body !== undefined) patch.body = opts.body
      else if (opts.file) patch.body = await resolveBody(opts.file, [])
      if (patch.body !== undefined && !patch.body.trim()) {
        throw new Error(
          'Refusing to set an empty body (this would wipe the content). Omit --body/--file to keep it.',
        )
      }
      if (opts.addTag.length > 0) patch.addTags = opts.addTag
      if (opts.rmTag.length > 0) patch.removeTags = opts.rmTag
      if (opts.setMeta.length > 0) {
        const meta: Record<string, unknown> = {}
        for (const kv of opts.setMeta as string[]) {
          const i = kv.indexOf('=')
          if (i <= 0) {
            throw new Error(`Invalid --set-meta "${kv}" (expected key=value with a non-empty key).`)
          }
          meta[kv.slice(0, i)] = kv.slice(i + 1)
        }
        patch.setMetadata = meta
      }
      if (opts.kind !== undefined) patch.kind = z.enum(KINDS).parse(opts.kind)
      if (opts.scope !== undefined) patch.scope = z.enum(SCOPES).parse(opts.scope)
      if (opts.namespace !== undefined) patch.namespace = opts.namespace
      if (opts.agent) patch.agentSource = opts.agent

      const ctx = await withDb(dbOptsFrom(command), async (db) => {
        if (!(await requireContext(db, id))) return null
        return updateContext(db, id, patch)
      })
      if (!ctx) {
        console.error(`No context found with id ${id}`)
        process.exitCode = 1
        return
      }
      console.log(opts.json ? JSON.stringify(ctx, null, 2) : formatContext(ctx))
    })
}
