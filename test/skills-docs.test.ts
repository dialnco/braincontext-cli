import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getSkill, listSkills } from '../src/skills/index'

/**
 * Guards on the AGENT-FACING docs.
 *
 * These exist because the access-control feature shipped with the bundled skills
 * still telling agents "auth/permissions are not built yet" — the code was right
 * and the thing agents actually read was wrong. Code has a typechecker; prose
 * doesn't, so the few checkable invariants are worth asserting.
 */
describe('bundled skills', () => {
  const skills = listSkills()

  it('finds the bundled skills', () => {
    expect(skills.map((s) => s.name).sort()).toEqual(['braincontext', 'braincontext-wiki'])
    for (const s of skills) expect(s.description.length).toBeGreaterThan(20)
  })

  it('links every reference from its SKILL.md', () => {
    // An unlinked reference is invisible: progressive disclosure works by the
    // SKILL.md naming what to load next, so a new file nobody points at is dead.
    for (const skill of skills) {
      const refDir = join(skill.dir, 'references')
      if (!existsSync(refDir)) continue
      const body = readFileSync(join(skill.dir, 'SKILL.md'), 'utf8')
      const unlinked = readdirSync(refDir)
        .filter((f) => f.endsWith('.md'))
        .filter((f) => !body.includes(f))
      expect(unlinked, `${skill.name}: references not mentioned in SKILL.md`).toEqual([])
    }
  })

  it('includes every reference in `--full` (the disclosure mechanism)', () => {
    const full = getSkill('braincontext', true) ?? ''
    const brief = getSkill('braincontext', false) ?? ''
    expect(full.length).toBeGreaterThan(brief.length)
    for (const f of ['access.md', 'projects.md', 'schema.md', 'search.md', 'workflows.md']) {
      expect(full).toContain(`# reference: ${f}`)
    }
  })
})

describe('access control is discoverable by an agent', () => {
  const brief = getSkill('braincontext', false) ?? ''
  const full = getSkill('braincontext', true) ?? ''
  const wiki = getSkill('braincontext-wiki', false) ?? ''

  it('names the identity command in the skill an agent loads first', () => {
    // The single most important thing for a refused agent: how to find out why.
    expect(brief).toContain('bctx whoami')
    expect(brief).toContain('Permission denied')
    expect(brief).toContain('references/access.md')
  })

  it('tells a refused wiki agent what to do', () => {
    expect(wiki).toContain('bctx whoami')
    expect(wiki).toMatch(/Permission denied/)
  })

  it('documents the admin surface and the advisory limit', () => {
    expect(full).toContain('bctx access init')
    expect(full).toContain('bctx access user add')
    expect(full).toContain('bctx project join')
    expect(full).toContain('bctx access recover')
    // The honest disclosure must survive any future edit of this doc.
    expect(full).toMatch(/advisory, not a security boundary/i)
    expect(full).toMatch(/join code contains that token/i)
  })

  it('no longer claims permissions are unbuilt', () => {
    // The exact staleness this suite was written for.
    for (const [name, text] of [
      ['braincontext', full],
      ['braincontext-wiki', getSkill('braincontext-wiki', true) ?? ''],
    ] as const) {
      expect(text, `${name} still says auth is unbuilt`).not.toMatch(
        /(auth|permissions?)[^.\n]{0,40}(are |is )?not built|share one project token/i,
      )
    }
  })
})
