import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'
import { parseFrontmatter } from '../lib/frontmatter'

export interface SkillFile {
  relPath: string
  content: Buffer
  isExecutable: boolean
}

export interface ParsedSkill {
  name: string
  description: string
  body: string
  frontmatter: Record<string, unknown>
  files: SkillFile[]
  dirName: string
}

function walk(root: string, dir: string, out: SkillFile[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name)
    const st = statSync(abs) // follows symlinks
    if (st.isDirectory()) {
      walk(root, abs, out)
      continue
    }
    if (!st.isFile()) continue
    const rel = relative(root, abs).split(sep).join('/')
    if (rel === 'SKILL.md') continue
    out.push({
      relPath: rel,
      content: readFileSync(abs),
      isExecutable: (st.mode & 0o111) !== 0,
    })
  }
}

/**
 * Read a skill bundle directory into memory: parse SKILL.md frontmatter+body and
 * capture every other file as bytes + its executable bit. Throws on missing
 * SKILL.md or malformed YAML (callers present a clean error).
 */
export function readSkillDir(dir: string): ParsedSkill {
  const raw = readFileSync(join(dir, 'SKILL.md'), 'utf8')
  const { data, body } = parseFrontmatter<Record<string, unknown>>(raw)

  const dirName = basename(dir)
  const name = typeof data.name === 'string' && data.name.length > 0 ? data.name : dirName
  const description = typeof data.description === 'string' ? data.description : ''

  const files: SkillFile[] = []
  walk(dir, dir, files)

  // Ensure name/description are present in the stored frontmatter for round-trips.
  const frontmatter = { ...data, name, description }
  return { name, description, body, frontmatter, files, dirName }
}
