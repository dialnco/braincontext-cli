import type { Capability } from './capabilities'

/** A rule of the access layer was violated (bad input, broken invariant). */
export class AccessError extends Error {
  readonly code: string
  constructor(message: string, code = 'access_error') {
    super(message)
    this.name = 'AccessError'
    this.code = code
  }
}

/**
 * The caller is not permitted to do this. Carries the capability that was missing
 * so the audit log and the HTTP layer can report it without re-deriving it.
 */
export class AccessDeniedError extends AccessError {
  readonly capability: Capability | undefined
  /** True when no identity could be established at all (vs. an identity that lacks the capability). */
  readonly unauthenticated: boolean
  constructor(
    message: string,
    opts: { capability?: Capability; unauthenticated?: boolean; code?: string } = {},
  ) {
    super(message, opts.code ?? (opts.unauthenticated ? 'unauthenticated' : 'forbidden'))
    this.name = 'AccessDeniedError'
    this.capability = opts.capability
    this.unauthenticated = opts.unauthenticated ?? false
  }
}
