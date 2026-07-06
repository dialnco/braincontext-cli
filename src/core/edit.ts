import type { Kysely } from 'kysely'
import { findSections, replaceOccurrence, replaceSection, type Section } from '../lib/section'
import type { Context } from './contexts'
import type { Database } from './types'
import { resolvePageRef, updatePage } from './wiki'

/**
 * Sub-body mutation for the prose/bullet/link majority a table op can't reach: read/patch a
 * heading-anchored section, or make an anchored exact find/replace. Both are
 * EXACT-MATCH-OR-REFUSE — an ambiguous or missing anchor throws loudly (never a fuzzy,
 * wrong-place edit) — and both write through `updatePage`, so history / FTS / link re-sync /
 * the immutable-source guard / `ifRev` CAS all apply exactly as for a whole-body write.
 */

/** Thrown when a section/find anchor is missing or ambiguous (the write is refused). */
export class EditError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EditError'
  }
}

export interface SectionView {
  pageId: string
  slug: string | null
  heading: string
  level: number
  /** The section markdown, heading line included. */
  text: string
  /** Page rev — pass back as `ifRev` to a patch to catch a concurrent edit. */
  rev: string
}

export interface EditOpts {
  ifRev?: string
  agentSource?: string | null
}

/** Resolve a page ref + locate exactly one section by heading, or throw EditError. */
async function resolveSection(
  db: Kysely<Database>,
  ref: string,
  heading: string,
): Promise<{ page: Context; section: Section }> {
  const page = await resolvePageRef(db, ref)
  if (!page) throw new EditError(`No wiki page matching "${ref}"`)
  const matches = findSections(page.body, heading)
  if (matches.length === 0) throw new EditError(`No section with heading "${heading}" on the page`)
  if (matches.length > 1) {
    throw new EditError(`"${heading}" matches ${matches.length} headings — make the heading unique`)
  }
  return { page, section: matches[0] as Section }
}

/** Read a single heading-anchored section (its markdown + the page rev), without the full body. */
export async function getPageSection(
  db: Kysely<Database>,
  ref: string,
  heading: string,
): Promise<SectionView> {
  const { page, section } = await resolveSection(db, ref, heading)
  return {
    pageId: page.id,
    slug: page.slug,
    heading: section.heading,
    level: section.level,
    text: section.text,
    rev: page.rev,
  }
}

/**
 * Replace one heading-anchored section's content. `newBody` is spliced in verbatim, so include
 * the heading line to keep it (omit it to drop the heading too). Goes through `updatePage`.
 */
export async function patchPageSection(
  db: Kysely<Database>,
  ref: string,
  heading: string,
  newBody: string,
  opts: EditOpts = {},
): Promise<Context> {
  const { page, section } = await resolveSection(db, ref, heading)
  const body = replaceSection(page.body, section, newBody)
  const updated = await updatePage(db, page.id, {
    body,
    ifRev: opts.ifRev,
    agentSource: opts.agentSource,
  })
  if (!updated) throw new EditError(`No wiki page matching "${ref}"`)
  return updated
}

/**
 * Anchored exact find/replace. Refuses (EditError) unless `find` matches exactly: with no
 * `occurrence`, `find` must occur exactly once; with `occurrence` (1-based), it must be in
 * range. A miss is never a silent no-op or a wrong-place edit. Goes through `updatePage`.
 */
export async function editPage(
  db: Kysely<Database>,
  ref: string,
  find: string,
  replace: string,
  opts: EditOpts & { occurrence?: number } = {},
): Promise<Context> {
  const page = await resolvePageRef(db, ref)
  if (!page) throw new EditError(`No wiki page matching "${ref}"`)
  if (find === '') throw new EditError('find must be a non-empty string')

  const { body, count } = replaceOccurrence(page.body, find, replace, opts.occurrence)
  if (count === 0)
    throw new EditError(`find text not present on "${page.title ?? ref}" (no change)`)
  if (opts.occurrence === undefined && count > 1) {
    throw new EditError(
      `find text occurs ${count}× — pass occurrence (1..${count}) to disambiguate`,
    )
  }
  if (opts.occurrence !== undefined && (opts.occurrence < 1 || opts.occurrence > count)) {
    throw new EditError(`occurrence ${opts.occurrence} out of range (found ${count})`)
  }

  const updated = await updatePage(db, page.id, {
    body,
    ifRev: opts.ifRev,
    agentSource: opts.agentSource,
  })
  if (!updated) throw new EditError(`No wiki page matching "${ref}"`)
  return updated
}
