import { basename, resolve } from 'node:path'
import { Command } from 'commander'
import { withDb } from '../core/db'
import { importSkill, listSkillContexts, loadSkill } from '../core/skills'
import { formatList } from '../lib/format'
import { readSkillDir } from '../skillbundles/parse'
import { reconstructSkill } from '../skillbundles/reconstruct'
import { validateSkill } from '../skillbundles/validate'
import { dbOptsFrom } from './_shared'

export function skillCommand(): Command {
  const skill = new Command('skill').description(
    'Import/export SKILL.md bundles stored in the database (distinct from `skills` docs).',
  )

  skill
    .command('add <dir>')
    .description('Import a SKILL.md bundle directory into the store (kind=skill + sidecar files).')
    .option('--namespace <ns>', 'namespace', 'global')
    .option('--agent <name>', 'agent source label')
    .option('--json', 'output JSON')
    .action(async (dir: string, opts, command: Command) => {
      const abs = resolve(dir)
      let parsed: ReturnType<typeof readSkillDir>
      try {
        parsed = readSkillDir(abs)
      } catch (err) {
        console.error(`Failed to read skill at ${abs}: ${err instanceof Error ? err.message : err}`)
        process.exitCode = 1
        return
      }

      const errors = validateSkill({
        name: parsed.name,
        description: parsed.description,
        dirName: basename(abs),
      })
      if (errors.length > 0) {
        console.error(`Invalid skill bundle:\n- ${errors.join('\n- ')}`)
        process.exitCode = 1
        return
      }

      const ctx = await withDb(dbOptsFrom(command), (db) =>
        importSkill(db, {
          name: parsed.name,
          description: parsed.description,
          body: parsed.body,
          frontmatter: parsed.frontmatter,
          files: parsed.files,
          namespace: opts.namespace,
          agentSource: opts.agent ?? null,
        }),
      )

      console.log(
        opts.json
          ? JSON.stringify(ctx, null, 2)
          : `Imported skill "${ctx.title}" (${ctx.id}) with ${parsed.files.length} sidecar file(s).`,
      )
    })

  skill
    .command('export <name> <dir>')
    .description('Reconstruct a stored skill on disk (SKILL.md + sidecars, chmod +x scripts/).')
    .action(async (name: string, dir: string, _opts, command: Command) => {
      const loaded = await withDb(dbOptsFrom(command), (db) => loadSkill(db, name))
      if (!loaded) {
        console.error(`No stored skill named "${name}".`)
        process.exitCode = 1
        return
      }
      const root = reconstructSkill(loaded, resolve(dir))
      console.log(`Exported skill "${name}" to ${root}`)
    })

  skill
    .command('list')
    .description('List skills stored in the database.')
    .option('--json', 'output JSON')
    .action(async (opts, command: Command) => {
      const items = await withDb(dbOptsFrom(command), (db) => listSkillContexts(db))
      console.log(opts.json ? JSON.stringify(items, null, 2) : formatList(items))
    })

  return skill
}
