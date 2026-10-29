import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseFrontmatter } from '../lib/frontmatter'
import { packageRoot } from '../lib/root'

function skillsRoot(): string {
  return join(packageRoot(), 'skills')
}

export interface BundledSkill {
  name: string
  description: string
  dir: string
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** List bundled skills (each subdirectory of skills/ with a SKILL.md). */
export function listSkills(): BundledSkill[] {
  const root = skillsRoot()
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const dir = join(root, e.name)
      const skillFile = join(dir, 'SKILL.md')
      const data = existsSync(skillFile)
        ? parseFrontmatter(readFileSync(skillFile, 'utf8')).data
        : {}
      return { name: str(data.name) || e.name, description: str(data.description), dir }
    })
}

/** The reference docs a skill ships (`references/*.md`), sorted. */
export function listSkillRefs(name: string): string[] {
  const skill = listSkills().find((s) => s.name === name)
  if (!skill) return []
  const refDir = join(skill.dir, 'references')
  return existsSync(refDir)
    ? readdirSync(refDir)
        .filter((f) => f.endsWith('.md'))
        .sort()
    : []
}

function renderRef(dir: string, file: string): string {
  return `# reference: ${file}\n\n${readFileSync(join(dir, 'references', file), 'utf8')}`
}

/**
 * Return a skill's SKILL.md content (version-matched to the installed CLI).
 * With `full`, append every references/*.md for progressive disclosure.
 */
export function getSkill(name: string, full = false): string | null {
  const skill = listSkills().find((s) => s.name === name)
  if (!skill) return null
  const skillFile = join(skill.dir, 'SKILL.md')
  let out = existsSync(skillFile) ? readFileSync(skillFile, 'utf8') : ''
  if (full) {
    for (const f of listSkillRefs(name)) out += `\n\n---\n\n${renderRef(skill.dir, f)}`
  }
  return out
}

/**
 * Just the named references of a skill — the narrowest rung of the ladder. An agent
 * that needs one topic (say, the inbox, first met through a hook) loads ~1k tokens
 * instead of `--full`'s every reference. Names match with or without `.md`.
 * Throws on an unknown name, listing what exists.
 */
export function getSkillRefs(name: string, refs: string[]): string | null {
  const skill = listSkills().find((s) => s.name === name)
  if (!skill) return null
  const available = listSkillRefs(name)
  const files = refs.map((r) => {
    const file = `${r.trim().replace(/\.md$/i, '').toLowerCase()}.md`
    if (!available.includes(file)) {
      const names = available.map((f) => f.replace(/\.md$/, '')).join(', ') || '(none)'
      throw new Error(`Skill "${name}" has no reference "${r}". Available: ${names}.`)
    }
    return file
  })
  const body = [...new Set(files)].map((f) => renderRef(skill.dir, f)).join('\n\n---\n\n')
  return `${body}\n\n---\n\n(Part of the "${name}" skill. Overview: \`bctx skills get ${name}\` · everything: \`bctx skills get ${name} --full\`.)`
}

export function skillPath(name?: string): string {
  if (!name) return skillsRoot()
  const skill = listSkills().find((s) => s.name === name)
  return skill ? skill.dir : skillsRoot()
}
