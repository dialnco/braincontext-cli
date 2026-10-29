import type { DbTarget } from '../db'
import { INBOX_SETUP_STEPS, InboxError } from './errors'

/**
 * Escape hatch for tests and offline end-to-end runs ONLY: lets the inbox run on a
 * plain local file. It skips the shared-project check, never the access-control one.
 */
export const INBOX_LOCAL_TEST_ENV = 'BCTX_TEST_INBOX_LOCAL'

export function inboxLocalAllowed(): boolean {
  return process.env[INBOX_LOCAL_TEST_ENV] === '1'
}

/**
 * Where inbox operations run: always the shared primary.
 *
 * A replica is swapped for a direct remote connection to its primary. Messaging
 * cannot tolerate stale reads (a joined replica has no background sync by default),
 * and talking to the primary never touches the local replica file — so a CLI inbox
 * call cannot collide with a `bctx mcp` server that owns that file.
 */
export function inboxTarget(target: DbTarget): DbTarget {
  if (target.mode === 'remote') return target
  if (target.mode === 'replica') {
    return {
      mode: 'remote',
      url: target.syncUrl,
      authToken: target.authToken,
      project: target.project,
    }
  }
  if (inboxLocalAllowed()) return target
  throw new InboxError(
    `The inbox is only available on shared (online) projects; this one is local.\n${INBOX_SETUP_STEPS}`,
    'unavailable',
  )
}
