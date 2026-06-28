import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { withFileLockSync } from '../src/core/lock'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bctx-lock-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('withFileLockSync', () => {
  it('runs fn under the lock and releases it after', () => {
    const lock = join(dir, 'x.lock')
    expect(withFileLockSync(lock, () => 42)).toBe(42)
    expect(existsSync(lock)).toBe(false)
  })

  it('releases the lock even when fn throws', () => {
    const lock = join(dir, 'x.lock')
    expect(() =>
      withFileLockSync(lock, () => {
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(existsSync(lock)).toBe(false)
  })

  it('steals a stale lock left by a dead pid', () => {
    const lock = join(dir, 'x.lock')
    writeFileSync(lock, '999999') // a pid that is (almost certainly) not alive
    expect(withFileLockSync(lock, () => 'ok', { timeoutMs: 1000 })).toBe('ok')
  })
})
