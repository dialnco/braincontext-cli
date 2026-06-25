import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { LoadedSkill } from '../core/skills'
import { stringifyFrontmatter } from '../lib/frontmatter'

/** Join, refusing any component that escapes `base` (path-traversal guard). */
function safeJoin(base: string, rel: string): string {
  const target = join(base, rel)
  const r = relative(base, target)
  if (r === '..' || r.startsWith(`..${sep}`) || isAbsolute(r)) {
    throw new Error(`unsafe path in skill bundle: ${rel}`)
  }
  return target
}

/**
 * Write a loaded skill bundle to `<outDir>/<name>/`: SKILL.md (frontmatter+body)
 * plus every sidecar at its relative path, restoring the stored executable bit.
 */
export function reconstructSkill(loaded: LoadedSkill, outDir: string): string {
  const root = safeJoin(outDir, loaded.context.title ?? 'skill')
  mkdirSync(root, { recursive: true })

  writeFileSync(
    join(root, 'SKILL.md'),
    stringifyFrontmatter(loaded.context.metadata, loaded.context.body),
    'utf8',
  )

  for (const f of loaded.files) {
    const target = safeJoin(root, f.relPath)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, f.content)
    chmodSync(target, f.isExecutable ? 0o755 : 0o644)
  }

  return root
}
