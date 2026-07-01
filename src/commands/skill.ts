import { basename, resolve } from 'node:path'
import { Command } from 'commander'
import { withDb } from '../core/db'
import { importSkill, listSkillContexts, loadSkill } from '../core/skills'
import { resolveAgent } from '../lib/agent'
import { formatList } from '../lib/format'
import { readSkillDir } from '../skillbundles/parse'
import { reconstructSkill } from '../skillbundles/reconstruct'
import { validateSkill } from '../skillbundles/validate'
import { type InstallResult, installSkill } from '../skills/install'
import { dbOptsFrom, splitCsv } from './_shared'

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
          agentSource: resolveAgent(opts.agent),
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
    .option('--namespace <ns>', 'disambiguate when the name exists in multiple namespaces')
    .action(async (name: string, dir: string, opts, command: Command) => {
      const loaded = await withDb(dbOptsFrom(command), (db) => loadSkill(db, name, opts.namespace))
      if (!loaded) {
        console.error(`No stored skill named "${name}".`)
        process.exitCode = 1
        return
      }
      const root = reconstructSkill(loaded, resolve(dir))
      console.log(`Exported skill "${name}" to ${root}`)
    })

  skill
    .command('init [name]')
    .description(
      'Scaffold a bundled skill into this project: .agents/skills/<name> + agent symlinks.',
    )
    .option('--full', 'copy the full SKILL.md + references instead of a discovery stub')
    .option('--agents <list>', 'comma-separated agent dirs to link into (default: claude)')
    .option('--dir <path>', 'project root to write into (default: current directory)')
    .option('--no-symlink', 'copy the skill into each agent dir instead of symlinking')
    .option('--force', 'replace an existing non-managed entry at an agent path')
    .option('--json', 'output JSON')
    .action((name: string | undefined, opts) => {
      const agents = splitCsv(opts.agents)
      let result: InstallResult
      try {
        result = installSkill({
          name: name ?? 'braincontext',
          dir: resolve(opts.dir ?? process.cwd()),
          full: Boolean(opts.full),
          agents: agents.length > 0 ? agents : undefined,
          // commander exposes `--no-symlink` as `opts.symlink === false`.
          noSymlink: opts.symlink === false,
          force: Boolean(opts.force),
        })
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err))
        process.exitCode = 1
        return
      }

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2))
        return
      }

      console.log(`Installed skill "${result.name}" (${result.mode}) → ${result.canonicalDir}`)
      for (const link of result.links) {
        const how = link.target ? `→ ${link.target} (${link.action})` : `(${link.action})`
        console.log(`  ${link.path} ${how}`)
      }
      console.log(
        `\nAgents that read .agents/skills or an agent skills dir now load the "${result.name}" skill.`,
      )
      console.log(`See the full, version-matched content: bctx skills get ${result.name} --full`)
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
