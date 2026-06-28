import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createContext } from '../src/core/contexts'
import { selectContexts } from '../src/export/select'
import { runExport } from '../src/export/write'
import { freshDb } from './_db'

describe('export', () => {
  it('writes AGENTS.md sections, a CLAUDE.md @AGENTS.md bridge, one .mdc per rule; idempotent', async () => {
    const db = await freshDb()
    await createContext(db, {
      body: 'Use pnpm, never npm',
      kind: 'rule',
      title: 'Package manager',
      tags: ['tooling'],
    })
    await createContext(db, { body: 'We deploy via Fly.io', kind: 'decision', title: 'Hosting' })
    const items = await selectContexts(db, {})

    const out = mkdtempSync(join(tmpdir(), 'bctx-exp-'))
    const r1 = runExport(items, { outDir: out, targets: ['agents', 'claude', 'cursor'] })
    expect(r1.changed.length).toBe(3)

    const agents = readFileSync(join(out, 'AGENTS.md'), 'utf8')
    expect(agents).toContain('## Rules')
    expect(agents).toContain('Use pnpm, never npm')
    expect(agents).toContain('## Decisions')
    expect(agents).toContain('BEGIN braincontext-cli')

    expect(readFileSync(join(out, 'CLAUDE.md'), 'utf8')).toContain('@AGENTS.md')

    const mdc = readFileSync(join(out, '.cursor', 'rules', 'package-manager.mdc'), 'utf8')
    expect(mdc.startsWith('---\n')).toBe(true)
    expect(mdc).toContain('alwaysApply: false')
    expect(mdc).toContain('Use pnpm, never npm')

    // second run = no changes (idempotent managed blocks)
    expect(
      runExport(items, { outDir: out, targets: ['agents', 'claude', 'cursor'] }).changed.length,
    ).toBe(0)

    rmSync(out, { recursive: true, force: true })
    await db.destroy()
  })

  it('always emits a self-onboarding preamble, even for an empty store', async () => {
    const db = await freshDb()
    const out = mkdtempSync(join(tmpdir(), 'bctx-exp-'))
    // no contexts stored at all — the managed block must still tell an agent the store exists
    const r = runExport(await selectContexts(db, {}), { outDir: out, targets: ['agents'] })
    expect(r.changed.length).toBe(1)
    const agents = readFileSync(join(out, 'AGENTS.md'), 'utf8')
    expect(agents).toContain('braincontext')
    expect(agents).toContain('bctx wiki search')
    expect(agents).toContain('bctx mcp')
    rmSync(out, { recursive: true, force: true })
    await db.destroy()
  })

  it('preserves hand-written content outside the managed fence', async () => {
    const db = await freshDb()
    await createContext(db, { body: 'a rule', kind: 'rule', title: 'R' })
    const items = await selectContexts(db, {})

    const out = mkdtempSync(join(tmpdir(), 'bctx-exp2-'))
    writeFileSync(join(out, 'AGENTS.md'), '# My Project\n\nHand-written intro.\n')
    runExport(items, { outDir: out, targets: ['agents'] })

    const agents = readFileSync(join(out, 'AGENTS.md'), 'utf8')
    expect(agents).toContain('Hand-written intro.')
    expect(agents).toContain('BEGIN braincontext-cli')

    rmSync(out, { recursive: true, force: true })
    await db.destroy()
  })

  it('--check reports changes without writing', async () => {
    const db = await freshDb()
    await createContext(db, { body: 'x', kind: 'rule', title: 'R' })
    const items = await selectContexts(db, {})
    const out = mkdtempSync(join(tmpdir(), 'bctx-exp3-'))
    const r = runExport(items, { outDir: out, targets: ['agents'], check: true })
    expect(r.changed.length).toBe(1)
    // nothing written under check
    expect(() => readFileSync(join(out, 'AGENTS.md'), 'utf8')).toThrow()
    rmSync(out, { recursive: true, force: true })
    await db.destroy()
  })
})
