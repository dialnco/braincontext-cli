import { hostname, userInfo } from 'node:os'

function safeUser(): string {
  try {
    return userInfo().username || 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * Resolve the agent-source label used for attribution. An explicit value always wins;
 * otherwise we detect a known coding agent from the environment (or an explicit
 * `BCTX_AGENT` override), falling back to `user@host`. This makes attribution
 * on-by-default and meaningful in a shared store — and pre-wires the identity the future
 * audit / RBAC layer will attribute writes to — at near-zero cost. Detection is
 * deliberately conservative (only strong, agent-specific signals) to avoid mislabeling.
 */
export function resolveAgent(explicit?: string | null): string {
  const e = explicit?.trim()
  if (e) return e
  const env = process.env
  if (env.BCTX_AGENT?.trim()) return env.BCTX_AGENT.trim()
  if (env.CLAUDECODE || env.CLAUDE_CODE) return 'claude'
  if (env.CURSOR_TRACE_ID) return 'cursor'
  if (env.CODEX_SANDBOX) return 'codex'
  return `${safeUser()}@${hostname()}`
}
