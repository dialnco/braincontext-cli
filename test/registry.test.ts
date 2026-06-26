import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveTarget } from '../src/core/paths'
import {
  addProject,
  currentProjectName,
  getProject,
  listProjects,
  projectToTarget,
  readConfig,
  removeProject,
  resolveToken,
  setCurrent,
  setToken,
} from '../src/core/registry'

let home: string
const orig = {
  home: process.env.BCTX_HOME,
  db: process.env.BCTX_DB,
  project: process.env.BCTX_PROJECT,
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'bctx-reg-'))
  process.env.BCTX_HOME = home
  process.env.BCTX_DB = undefined
  process.env.BCTX_PROJECT = undefined
  delete process.env.BCTX_DB
  delete process.env.BCTX_PROJECT
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  for (const [k, v] of Object.entries({
    BCTX_HOME: orig.home,
    BCTX_DB: orig.db,
    BCTX_PROJECT: orig.project,
  })) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

describe('project registry', () => {
  it('provides a default project with no config file', () => {
    const cfg = readConfig()
    expect(cfg.currentProject).toBe('default')
    expect(cfg.projects.default?.mode).toBe('local')
  })

  it('create → use → list → remove (removing current resets to default)', () => {
    addProject('work', { mode: 'local', file: 'projects/work.db', createdAt: 'x' })
    expect(
      listProjects()
        .map((p) => p.name)
        .sort(),
    ).toEqual(['default', 'work'])
    setCurrent('work')
    expect(currentProjectName()).toBe('work')
    removeProject('work')
    expect(getProject('work')).toBeUndefined()
    expect(currentProjectName()).toBe('default')
  })

  it('cannot remove the default project', () => {
    expect(() => removeProject('default')).toThrow(/Cannot remove/)
  })

  it('rejects path-traversal / invalid names', () => {
    expect(() => addProject('../evil', { mode: 'local', createdAt: 'x' })).toThrow(
      /Invalid project name/,
    )
  })

  it('keeps tokens out of config.json; credentials.json is 0600', () => {
    addProject('work', {
      mode: 'replica',
      file: 'projects/work.db',
      syncUrl: 'libsql://x',
      createdAt: 'x',
    })
    setToken('work', 'SECRET123')
    expect(readFileSync(join(home, 'config.json'), 'utf8')).not.toContain('SECRET123')
    const credPath = join(home, 'credentials.json')
    expect(readFileSync(credPath, 'utf8')).toContain('SECRET123')
    expect(statSync(credPath).mode & 0o777).toBe(0o600)
    expect(resolveToken('work')).toBe('SECRET123')
  })

  it('env BCTX_TOKEN_<NAME> overrides the stored token', () => {
    addProject('work', { mode: 'replica', file: 'p.db', syncUrl: 'libsql://x', createdAt: 'x' })
    setToken('work', 'stored')
    process.env.BCTX_TOKEN_WORK = 'fromenv'
    expect(resolveToken('work')).toBe('fromenv')
    delete process.env.BCTX_TOKEN_WORK
  })

  it('resolveTarget precedence: --db > --project > BCTX_PROJECT > default', () => {
    addProject('work', { mode: 'local', file: 'projects/work.db', createdAt: 'x' })
    expect(resolveTarget({ db: '/tmp/x.db' })).toEqual({ mode: 'local', file: '/tmp/x.db' })

    const byFlag = resolveTarget({ project: 'work' })
    expect(byFlag).toMatchObject({ mode: 'local' })
    expect('file' in byFlag && byFlag.file).toContain('work.db')

    process.env.BCTX_PROJECT = 'work'
    const byEnv = resolveTarget()
    expect('file' in byEnv && byEnv.file).toContain('work.db')
    delete process.env.BCTX_PROJECT

    const def = resolveTarget()
    expect('file' in def && def.file).toContain('store.db')
  })

  it('unknown --project throws', () => {
    expect(() => resolveTarget({ project: 'nope' })).toThrow(/No such project/)
  })

  it('projectToTarget builds replica and remote targets', () => {
    expect(
      projectToTarget('r', { mode: 'remote', syncUrl: 'libsql://x', createdAt: 'x' }),
    ).toMatchObject({
      mode: 'remote',
      url: 'libsql://x',
    })
    const rep = projectToTarget('p', {
      mode: 'replica',
      file: 'p.db',
      syncUrl: 'libsql://x',
      createdAt: 'x',
    })
    expect(rep.mode).toBe('replica')
    expect('syncUrl' in rep && rep.syncUrl).toBe('libsql://x')
  })
})
