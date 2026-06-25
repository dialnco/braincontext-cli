import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

let cached: string | null = null

/**
 * Locate the installed package root (nearest ancestor with a package.json).
 * Works both in dev (tsx, src/lib/root.ts) and bundled (dist/cli.js), so the
 * sibling `skills/` directory and package version can always be found.
 */
export function packageRoot(): string {
  if (cached) return cached
  let dir = dirname(fileURLToPath(import.meta.url))
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, 'package.json'))) {
      cached = dir
      return dir
    }
    dir = dirname(dir)
  }
  throw new Error('Could not locate package root')
}
