import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { Kysely } from 'kysely'
import type { Context } from '../core/contexts'
import type { Database } from '../core/types'
import { getPage, type LintFinding, listPages, updatePage } from '../core/wiki'

/**
 * Code↔doc drift detection. A page opts in by declaring the files it documents in
 * `metadata.sources` (repo-relative paths). Verifying the page snapshots each file's
 * content hash into `metadata.sourceHashes`; a later drift check re-hashes and flags
 * pages whose documented files changed since they were last verified.
 *
 * Lives beside export/import (fs work stays out of src/core, which is db-only).
 */

/** The `metadata.sources` list of a page (repo-relative paths it documents). */
export function pageSources(page: Pick<Context, 'metadata'>): string[] {
  const raw = page.metadata.sources
  return Array.isArray(raw) ? raw.filter((s): s is string => typeof s === 'string') : []
}

function hashFile(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return null // missing/unreadable — recorded as null, surfaced by the drift check
  }
}

/** sha256 per source path (null = missing/unreadable), resolved against `root`. */
export function hashSources(paths: string[], root: string): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  for (const p of paths) out[p] = hashFile(isAbsolute(p) ? p : join(root, p))
  return out
}

/**
 * Record the current content hashes of a page's declared sources (run at verify
 * time, from the repo root). Returns the snapshot, or null when the page has no
 * sources (nothing to baseline).
 */
export async function snapshotSourceHashes(
  db: Kysely<Database>,
  pageId: string,
  root: string,
): Promise<Record<string, string | null> | null> {
  const page = await getPage(db, pageId)
  if (!page) return null
  const sources = pageSources(page)
  if (sources.length === 0) return null
  const hashes = hashSources(sources, root)
  await updatePage(db, pageId, { setMetadata: { sourceHashes: hashes } })
  return hashes
}

/**
 * Compare every page's recorded source hashes against the files on disk.
 * Kinds of drift surfaced (all as kind 'drift', distinguished by detail):
 * not-baselined (sources declared but never snapshotted), file missing, and
 * content changed since the last verify.
 */
export async function driftFindings(db: Kysely<Database>, root: string): Promise<LintFinding[]> {
  const findings: LintFinding[] = []
  const pages = await listPages(db, { limit: 100000 })
  for (const p of pages) {
    const sources = pageSources(p)
    if (sources.length === 0) continue
    const recorded =
      p.metadata.sourceHashes && typeof p.metadata.sourceHashes === 'object'
        ? (p.metadata.sourceHashes as Record<string, unknown>)
        : {}
    for (const s of sources) {
      const before = s in recorded ? recorded[s] : undefined
      const now = hashFile(isAbsolute(s) ? s : join(root, s))
      let detail: string | null = null
      if (before === undefined) {
        detail = `${s}: not baselined — run \`bctx wiki verify\` to snapshot`
      } else if (now === null) {
        detail = `${s}: file missing`
      } else if (before !== now) {
        detail = `${s}: changed since last verify`
      }
      if (detail) {
        findings.push({ kind: 'drift', pageId: p.id, title: p.title ?? '', detail })
      }
    }
  }
  return findings
}
