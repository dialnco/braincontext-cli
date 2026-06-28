import { describe, expect, it } from 'vitest'
import { resolveAgent } from '../src/lib/agent'

describe('resolveAgent', () => {
  it('prefers an explicit, non-blank label', () => {
    expect(resolveAgent('codex')).toBe('codex')
    // a blank explicit value falls through to a derived identity (never stored as blank)
    expect(resolveAgent('   ').trim().length).toBeGreaterThan(0)
  })

  it('derives a meaningful identity when none is given (detected agent or user@host)', () => {
    const a = resolveAgent()
    expect(a.length).toBeGreaterThan(0)
    const known = a === 'claude' || a === 'cursor' || a === 'codex'
    expect(known || a.includes('@')).toBe(true)
  })

  it('honors the BCTX_AGENT env override', () => {
    const prev = process.env.BCTX_AGENT
    process.env.BCTX_AGENT = 'ci-bot'
    try {
      expect(resolveAgent()).toBe('ci-bot')
    } finally {
      if (prev === undefined) delete process.env.BCTX_AGENT
      else process.env.BCTX_AGENT = prev
    }
  })
})
