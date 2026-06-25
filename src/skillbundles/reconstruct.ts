import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { LoadedSkill } from '../core/skills'
import { stringifyFrontmatter } from '../lib/frontmatter'

/**
 * Write a loaded skill bundle to `<outDir>/<name>/`: SKILL.md (frontmatter+body)
 * plus every sidecar at its relative path. Files flagged executable — and
 * anything under scripts/ — are chmod 0o755; everything else 0o644.
 */
export function reconstructSkill(loaded: LoadedSkill, outDir: string): string {
  const name = loaded.context.title ?? 'skill'
  const root = join(outDir, name)
  mkdirSync(root, { recursive: true })

  writeFileSync(
    join(root, 'SKILL.md'),
    stringifyFrontmatter(loaded.context.metadata, loaded.context.body),
    'utf8',
  )

  for (const f of loaded.files) {
    const target = join(root, f.relPath)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, f.content)
    const exec = f.isExecutable || f.relPath.startsWith('scripts/')
    chmodSync(target, exec ? 0o755 : 0o644)
  }

  return root
}
