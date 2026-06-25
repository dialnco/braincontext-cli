import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { importSkill, loadSkill } from '../src/core/skills'
import { readSkillDir } from '../src/skillbundles/parse'
import { reconstructSkill } from '../src/skillbundles/reconstruct'
import { validateSkill } from '../src/skillbundles/validate'
import { freshDb } from './_db'

function makeSkillDir(): string {
  const base = mkdtempSync(join(tmpdir(), 'bctx-skill-'))
  const dir = join(base, 'demo-skill')
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(
    join(dir, 'SKILL.md'),
    '---\nname: demo-skill\ndescription: A demo skill for tests\nallowed-tools: Bash(echo:*)\n---\n\n# Demo\n\nBody here.\n',
  )
  const script = join(dir, 'scripts', 'run.sh')
  writeFileSync(script, '#!/usr/bin/env bash\necho hi\n')
  chmodSync(script, 0o755)
  writeFileSync(join(dir, 'assets', 'blob.bin'), Buffer.from([0x00, 0xff, 0x10, 0x80, 0x7f]))
  return dir
}

describe('skill bundles', () => {
  it('imports and reconstructs byte-identically with exec bit + frontmatter', async () => {
    const db = await freshDb()
    const dir = makeSkillDir()

    const parsed = readSkillDir(dir)
    expect(
      validateSkill({ name: parsed.name, description: parsed.description, dirName: 'demo-skill' }),
    ).toEqual([])
    expect(parsed.frontmatter['allowed-tools']).toBe('Bash(echo:*)')
    expect(parsed.files.length).toBe(2)

    const ctx = await importSkill(db, {
      name: parsed.name,
      description: parsed.description,
      body: parsed.body,
      frontmatter: parsed.frontmatter,
      files: parsed.files,
    })
    expect(ctx.kind).toBe('skill')

    const loaded = await loadSkill(db, 'demo-skill')
    if (!loaded) throw new Error('skill not found after import')

    const outBase = mkdtempSync(join(tmpdir(), 'bctx-skill-out-'))
    const root = reconstructSkill(loaded, outBase)

    const blob = readFileSync(join(root, 'assets', 'blob.bin'))
    expect([...blob]).toEqual([0x00, 0xff, 0x10, 0x80, 0x7f])
    expect(statSync(join(root, 'scripts', 'run.sh')).mode & 0o111).not.toBe(0)

    const skillMd = readFileSync(join(root, 'SKILL.md'), 'utf8')
    expect(skillMd).toContain('name: demo-skill')
    expect(skillMd).toContain('description: A demo skill for tests')
    expect(skillMd).toContain('Body here.')

    rmSync(outBase, { recursive: true, force: true })
    await db.destroy()
  })

  it('re-importing the same name replaces (no duplicates)', async () => {
    const db = await freshDb()
    const dir = makeSkillDir()
    const parsed = readSkillDir(dir)
    const input = {
      name: parsed.name,
      description: parsed.description,
      body: parsed.body,
      frontmatter: parsed.frontmatter,
      files: parsed.files,
    }
    await importSkill(db, input)
    await importSkill(db, input)
    const { listSkillContexts } = await import('../src/core/skills')
    expect((await listSkillContexts(db)).length).toBe(1)
    await db.destroy()
  })

  it('rejects bad kebab and name != folder', () => {
    expect(
      validateSkill({ name: 'Demo_Skill', description: 'x', dirName: 'Demo_Skill' }).length,
    ).toBeGreaterThan(0)
    expect(validateSkill({ name: 'demo', description: 'x', dirName: 'other' })).toContain(
      'name "demo" must equal the folder name "other"',
    )
  })
})
