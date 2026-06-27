import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packageRoot } from '../lib/root'

/**
 * Locate the built SPA directory (dist/studio).
 *  - PROD (bundled): this module is inlined into dist/cli.js (tsup splitting:false),
 *    so the sibling build dir is `new URL('./studio', import.meta.url)` -> dist/studio.
 *  - DEV (tsx src/cli.ts): that URL points into src/, which has no built assets, so
 *    fall back to <packageRoot>/dist/studio — the same convention the shipped skills/
 *    directory uses (src/lib/root.ts). Build first (`pnpm build`) for the dev path.
 * The caller tolerates a missing dir (API still serves; UI returns 503).
 */
export function resolveStudioDir(): string {
  const sibling = fileURLToPath(new URL('./studio', import.meta.url))
  if (existsSync(sibling)) return sibling
  return join(packageRoot(), 'dist', 'studio')
}
