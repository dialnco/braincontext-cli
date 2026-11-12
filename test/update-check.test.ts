import { describe, expect, it } from 'vitest'
import { formatNotice, isNewer, planUpdateCheck, updateCheckEnabled } from '../src/lib/updateCheck'

const NOW = Date.parse('2026-11-12T12:00:00Z')
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString()

describe('isNewer', () => {
  it('compares x.y.z numerically', () => {
    expect(isNewer('0.9.3', '0.9.2')).toBe(true)
    expect(isNewer('0.10.0', '0.9.9')).toBe(true)
    expect(isNewer('1.0.0', '0.99.99')).toBe(true)
    expect(isNewer('0.9.2', '0.9.2')).toBe(false)
    expect(isNewer('0.9.1', '0.9.2')).toBe(false)
  })
  it('never offers a pre-release; a release beats its own pre-release', () => {
    expect(isNewer('1.0.0-beta.1', '0.9.2')).toBe(false)
    expect(isNewer('1.0.0', '1.0.0-rc.1')).toBe(true)
    expect(isNewer('garbage', '0.9.2')).toBe(false)
  })
})

describe('planUpdateCheck', () => {
  it('first run: no notice, starts a check and stamps checkedAt', () => {
    const p = planUpdateCheck({}, '0.9.2', NOW, true)
    expect(p.notice).toBeNull()
    expect(p.check).toBe(true)
    expect(p.next?.checkedAt).toBe(new Date(NOW).toISOString())
  })

  it('checks at most once a day (also throttles retries while offline)', () => {
    expect(planUpdateCheck({ checkedAt: hoursAgo(2) }, '0.9.2', NOW, true).check).toBe(false)
    expect(planUpdateCheck({ checkedAt: hoursAgo(25) }, '0.9.2', NOW, true).check).toBe(true)
  })

  it('a terminal sees the notice on every run until upgraded', () => {
    const cache = { checkedAt: hoursAgo(1), latest: '0.9.3' }
    const p = planUpdateCheck(cache, '0.9.2', NOW, true)
    expect(p.notice).toContain('0.9.2 → 0.9.3')
    expect(p.notice).toContain('npm i -g braincontext-cli@latest')
    expect(p.notice).toContain('/releases/tag/v0.9.3')
    expect(p.next).toBeNull() // nothing to persist
    expect(planUpdateCheck(cache, '0.9.3', NOW, true).notice).toBeNull()
  })

  it('agents/pipes see it at most once a day per version', () => {
    const cache = { checkedAt: hoursAgo(1), latest: '0.9.3' }
    const first = planUpdateCheck(cache, '0.9.2', NOW, false)
    expect(first.notice).toContain('0.9.3')
    expect(first.next).toMatchObject({ notifiedVersion: '0.9.3' })
    const again = planUpdateCheck({ ...cache, ...first.next }, '0.9.2', NOW + 3_600_000, false)
    expect(again.notice).toBeNull()
    const nextDay = planUpdateCheck(
      { ...cache, ...first.next },
      '0.9.2',
      NOW + 25 * 3_600_000,
      false,
    )
    expect(nextDay.notice).not.toBeNull()
    // A newer release than the one already announced is announced right away.
    const newer = planUpdateCheck({ ...first.next, latest: '0.9.4' }, '0.9.2', NOW, false)
    expect(newer.notice).toContain('0.9.4')
  })
})

describe('updateCheckEnabled', () => {
  it('is off for CI, tests, opt-outs, mcp, and the inbox hook', () => {
    expect(updateCheckEnabled(['status'], {})).toBe(true)
    expect(updateCheckEnabled(['--project', 'p', 'inbox', 'ls'], {})).toBe(true)
    expect(updateCheckEnabled(['status'], { CI: 'true' })).toBe(false)
    expect(updateCheckEnabled(['status'], { VITEST: 'true' })).toBe(false)
    expect(updateCheckEnabled(['status'], { BCTX_NO_UPDATE_CHECK: '1' })).toBe(false)
    expect(updateCheckEnabled(['status'], { NO_UPDATE_NOTIFIER: '1' })).toBe(false)
    expect(updateCheckEnabled(['mcp'], {})).toBe(false)
    expect(updateCheckEnabled(['--project', 'inbox', 'mcp'], {})).toBe(false)
    expect(updateCheckEnabled(['inbox', 'hook'], {})).toBe(false)
  })
})

describe('formatNotice', () => {
  it('is plain text without colour', () => {
    expect(formatNotice('0.9.2', '0.9.3', false)).not.toContain('\x1b[')
  })
})
