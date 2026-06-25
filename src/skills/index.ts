import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { packageRoot } from '../lib/root'

function skillsRoot(): string {
  return join(packageRoot(), 'skills')
}

export interface BundledSkill {
  name: string
  description: string
  dir: string
}

/** Minimal YAML frontmatter parser (key: value lines only) — avoids a yaml dep. */
function parseFrontmatter(md: string): Record<string, string> {
  const out: Record<string, string> = {}
  const match = md.match(/^---\n([\s\S]*?)\n---/)
  const frontmatter = match?.[1]
  if (!frontmatter) return out
  for (const line of frontmatter.split('\n')) {
    const i = line.indexOf(':')
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return out
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
      const fm = existsSync(skillFile) ? parseFrontmatter(readFileSync(skillFile, 'utf8')) : {}
      return { name: fm.name ?? e.name, description: fm.description ?? '', dir }
    })
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
    const refDir = join(skill.dir, 'references')
    if (existsSync(refDir)) {
      const refs = readdirSync(refDir)
        .filter((f) => f.endsWith('.md'))
        .sort()
      for (const f of refs) {
        out += `\n\n---\n\n# reference: ${f}\n\n${readFileSync(join(refDir, f), 'utf8')}`
      }
    }
  }
  return out
}

export function skillPath(name?: string): string {
  if (!name) return skillsRoot()
  const skill = listSkills().find((s) => s.name === name)
  return skill ? skill.dir : skillsRoot()
}
