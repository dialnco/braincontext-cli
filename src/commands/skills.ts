import { Command } from 'commander'
import { getSkill, listSkills, skillPath } from '../skills/index'

export function skillsCommand(): Command {
  const skills = new Command('skills').description(
    'Bundled, version-matched skill docs for agents (progressive disclosure).',
  )

  skills
    .command('list', { isDefault: true })
    .description('List bundled skills.')
    .option('--json', 'output JSON')
    .action((opts) => {
      const all = listSkills()
      if (opts.json) {
        console.log(JSON.stringify(all, null, 2))
        return
      }
      if (all.length === 0) {
        console.log('No bundled skills found.')
        return
      }
      for (const s of all) {
        console.log(`${s.name}\n  ${s.description}`)
      }
    })

  skills
    .command('get [name]')
    .description('Print a skill (version-matched). Use --full to include reference docs.')
    .option('--full', 'include references/*.md (progressive disclosure)')
    .option('--all', 'print every bundled skill')
    .action((name: string | undefined, opts) => {
      if (opts.all || !name) {
        const parts = listSkills()
          .map((s) => getSkill(s.name, Boolean(opts.full)))
          .filter((x): x is string => x !== null)
        console.log(parts.join('\n\n===\n\n'))
        return
      }
      const content = getSkill(name, Boolean(opts.full))
      if (content === null) {
        console.error(`No bundled skill named "${name}".`)
        process.exitCode = 1
        return
      }
      console.log(content)
    })

  skills
    .command('path [name]')
    .description('Print the filesystem path to a bundled skill (or the skills root).')
    .action((name: string | undefined) => {
      console.log(skillPath(name))
    })

  return skills
}
