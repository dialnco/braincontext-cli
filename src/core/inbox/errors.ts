/**
 * Inbox failures, each with a stable `code` the surfaces map to an exit message,
 * an MCP error, or an HTTP status. Messages are written to be read by an agent: they
 * say what happened and what to do next.
 */
export type InboxErrorCode =
  | 'unavailable'
  | 'not_found'
  | 'no_such_member'
  | 'forbidden'
  | 'conflict'
  | 'invalid'
  | 'answer_required'
  | 'rate_limited'
  | 'agent_turn_limit'

export class InboxError extends Error {
  constructor(
    message: string,
    readonly code: InboxErrorCode,
  ) {
    super(message)
    this.name = 'InboxError'
  }
}

/** HTTP status for each code (Studio). */
export const INBOX_HTTP_STATUS: Record<InboxErrorCode, 400 | 403 | 404 | 409 | 412 | 429> = {
  unavailable: 412,
  not_found: 404,
  no_such_member: 404,
  forbidden: 403,
  conflict: 409,
  invalid: 400,
  answer_required: 400,
  rate_limited: 429,
  agent_turn_limit: 429,
}

/** What to do to get an inbox, shown wherever it is unavailable. */
export const INBOX_SETUP_STEPS = [
  'The inbox needs a shared project with access control on:',
  '  1. bctx project migrate-online <name> --url libsql://… --auth-token …   (if still local)',
  '  2. bctx access init                       (you become owner)',
  '  3. bctx access user add <handle> --role writer   (prints a join code per member)',
  '  4. each member runs: bctx project join <code>',
  'Note: once access control is on, members using the raw database token need a join code too.',
].join('\n')
