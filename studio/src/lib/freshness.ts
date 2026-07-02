import type { Context } from '../api/types'

/** Mirrors src/core/wiki.ts pageFreshness — derived, never stored. */
export const DEFAULT_STALE_DAYS = 45

export type VerificationState = 'unverified' | 'verified' | 'stale'

export interface PageFreshness {
  state: VerificationState
  /** Days since last verification (or last update when never verified). */
  ageDays: number
  verifiedAt: string | null
  verifiedBy: string | null
}

export function pageFreshness(
  page: Pick<Context, 'metadata' | 'updatedAt'>,
  staleDays = DEFAULT_STALE_DAYS,
): PageFreshness {
  const verifiedAt = typeof page.metadata.verifiedAt === 'string' ? page.metadata.verifiedAt : null
  const verifiedBy = typeof page.metadata.verifiedBy === 'string' ? page.metadata.verifiedBy : null
  const verifiedMs = verifiedAt ? new Date(verifiedAt).getTime() : Number.NEGATIVE_INFINITY
  const updatedMs = new Date(page.updatedAt).getTime()
  const ageDays = Math.max(
    0,
    Math.floor((Date.now() - Math.max(verifiedMs, updatedMs)) / 86_400_000),
  )
  // A verification only counts while no later edit invalidated it (5s tolerance —
  // the server stamps verifiedAt and updatedAt within the same write).
  const verifiedCurrent = verifiedAt !== null && verifiedMs >= updatedMs - 5000
  const state: VerificationState =
    ageDays > staleDays ? 'stale' : verifiedCurrent ? 'verified' : 'unverified'
  return { state, ageDays, verifiedAt, verifiedBy }
}

/** Chip color per state (works on both themes — matches existing accent usage). */
export function freshnessColor(state: VerificationState): string {
  if (state === 'verified') return '#4caf7d'
  if (state === 'stale') return '#c98a6a'
  return 'var(--muted)'
}
