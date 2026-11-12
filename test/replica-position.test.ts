import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { replicaPosition } from '../src/core/db'

// Turso answers `frames_synced: 1` to EVERY sync, so "did a sync bring anything?" is
// read from the replica's own `<file>-info` log position instead (verified against a
// real primary: it moves exactly when the primary takes a write).
describe('replicaPosition', () => {
  let dir: string
  let file: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bctx-rpos-'))
    file = join(dir, 'r.db')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('reads generation + durable frame from <file>-info', () => {
    writeFileSync(
      `${file}-info`,
      JSON.stringify({ hash: 1, version: 0, durable_frame_num: 106, generation: 9 }),
    )
    expect(replicaPosition(file)).toEqual({ generation: 9, frame: 106 })
  })

  it('is null when the info file is missing or malformed (callers fall back)', () => {
    expect(replicaPosition(file)).toBeNull()
    writeFileSync(`${file}-info`, 'not json')
    expect(replicaPosition(file)).toBeNull()
    writeFileSync(`${file}-info`, JSON.stringify({ generation: 'x' }))
    expect(replicaPosition(file)).toBeNull()
  })
})
