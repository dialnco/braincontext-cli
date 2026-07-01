import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { installSkill } from '../src/skills/install'

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'bctx-skillinit-'))
}

const canonical = (root: string) => join(root, '.agents', 'skills', 'braincontext')
const claudeLink = (root: string) => join(root, '.claude', 'skills', 'braincontext')

describe('skill init', () => {
  it('writes a stub and a relative symlink into .claude', () => {
    const root = tmp()
    const res = installSkill({ name: 'braincontext', dir: root })

    // Stub content lives once under .agents/skills.
    const skillFile = join(canonical(root), 'SKILL.md')
    expect(existsSync(skillFile)).toBe(true)
    const md = readFileSync(skillFile, 'utf8')
    expect(md).toMatch(/^---\n[\s\S]*name: braincontext/)
    expect(md).toContain('description:') // real description copied for agent activation
    expect(md).toContain('bctx skills get braincontext --full')
    // A stub does not carry the reference docs.
    expect(existsSync(join(canonical(root), 'references'))).toBe(false)

    // .claude entry is a relative symlink back to the canonical dir.
    expect(lstatSync(claudeLink(root)).isSymbolicLink()).toBe(true)
    expect(readlinkSync(claudeLink(root))).toBe(
      join('..', '..', '.agents', 'skills', 'braincontext'),
    )
    expect(realpathSync(claudeLink(root))).toBe(realpathSync(canonical(root)))

    expect(res.mode).toBe('stub')
    expect(res.links[0]!).toMatchObject({ agent: 'claude', action: 'symlinked' })
  })

  it('--full copies the real SKILL.md plus references', () => {
    const root = tmp()
    const res = installSkill({ name: 'braincontext', dir: root, full: true })
    expect(res.mode).toBe('full')
    expect(existsSync(join(canonical(root), 'SKILL.md'))).toBe(true)
    expect(existsSync(join(canonical(root), 'references'))).toBe(true)
    // The full copy is not a stub — it does not point back at the CLI.
    expect(readFileSync(join(canonical(root), 'SKILL.md'), 'utf8')).not.toContain('discovery stub')
  })

  it('--no-symlink materializes a real directory copy', () => {
    const root = tmp()
    const res = installSkill({ name: 'braincontext', dir: root, noSymlink: true })
    expect(lstatSync(claudeLink(root)).isSymbolicLink()).toBe(false)
    expect(lstatSync(claudeLink(root)).isDirectory()).toBe(true)
    expect(existsSync(join(claudeLink(root), 'SKILL.md'))).toBe(true)
    expect(res.links[0]!.action).toBe('copied')
  })

  it('is idempotent — a second symlink run reports unchanged', () => {
    const root = tmp()
    installSkill({ name: 'braincontext', dir: root })
    const again = installSkill({ name: 'braincontext', dir: root })
    expect(again.links[0]!.action).toBe('unchanged')
    expect(lstatSync(claudeLink(root)).isSymbolicLink()).toBe(true)
  })

  it('re-running --no-symlink refreshes the copy without --force', () => {
    const root = tmp()
    installSkill({ name: 'braincontext', dir: root, noSymlink: true })
    const again = installSkill({ name: 'braincontext', dir: root, noSymlink: true })
    expect(again.links[0]!.action).toBe('copied')
    expect(lstatSync(claudeLink(root)).isDirectory()).toBe(true)
  })

  it('throws on an unknown skill name', () => {
    const root = tmp()
    expect(() => installSkill({ name: 'does-not-exist', dir: root })).toThrow(/No bundled skill/)
  })

  it('refuses to clobber a real dir without --force, replaces it with --force', () => {
    const root = tmp()
    mkdirSync(claudeLink(root), { recursive: true })
    writeFileSync(join(claudeLink(root), 'keep.txt'), 'user data', 'utf8')

    expect(() => installSkill({ name: 'braincontext', dir: root })).toThrow(/--force/)

    const res = installSkill({ name: 'braincontext', dir: root, force: true })
    expect(res.links[0]!.action).toBe('symlinked')
    expect(lstatSync(claudeLink(root)).isSymbolicLink()).toBe(true)
  })
})
