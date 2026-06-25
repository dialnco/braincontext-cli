import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Context } from '../core/contexts'
import { applyManagedBlock } from './managed'
import { renderAgentsBody, renderClaudeBody, renderMdc } from './render'
import { renderContextFile } from './store'

export type Target = 'agents' | 'claude' | 'cursor' | 'store'
export const ALL_TARGETS: Target[] = ['agents', 'claude', 'cursor']
/** `store` is the round-trippable per-context dir; opt-in (not in ALL_TARGETS). */
export const ALL_TARGET_NAMES: Target[] = ['agents', 'claude', 'cursor', 'store']

export interface ExportOptions {
  outDir: string
  targets: Target[]
  dryRun?: boolean
  check?: boolean
}

export interface PlannedFile {
  path: string
  content: string
}

export interface ExportResult {
  changed: PlannedFile[]
  unchanged: string[]
}

/** Compute the desired content of every target file (managed blocks applied). */
export function planExport(items: Context[], opts: ExportOptions): PlannedFile[] {
  const files: PlannedFile[] = []
  const has = (t: Target) => opts.targets.includes(t)

  const managed = (name: string, body: string): PlannedFile => {
    const path = join(opts.outDir, name)
    const existing = existsSync(path) ? readFileSync(path, 'utf8') : ''
    return { path, content: applyManagedBlock(existing, body) }
  }

  if (has('agents')) files.push(managed('AGENTS.md', renderAgentsBody(items)))
  if (has('claude')) files.push(managed('CLAUDE.md', renderClaudeBody()))
  if (has('cursor')) {
    for (const c of items.filter((x) => x.kind === 'rule')) {
      const { filename, content } = renderMdc(c)
      files.push({ path: join(opts.outDir, '.cursor', 'rules', filename), content })
    }
  }
  if (has('store')) {
    const used = new Set<string>()
    for (const c of items) {
      const { filename, content } = renderContextFile(c)
      let name = filename
      for (let i = 2; used.has(name); i++) name = filename.replace(/\.md$/, `-${i}.md`)
      used.add(name)
      files.push({ path: join(opts.outDir, name), content })
    }
  }
  return files
}

/** Plan, then (unless dry-run/check) write changed files. */
export function runExport(items: Context[], opts: ExportOptions): ExportResult {
  const planned = planExport(items, opts)
  const changed: PlannedFile[] = []
  const unchanged: string[] = []

  for (const f of planned) {
    const current = existsSync(f.path) ? readFileSync(f.path, 'utf8') : null
    if (current === f.content) {
      unchanged.push(f.path)
      continue
    }
    changed.push(f)
    if (!opts.dryRun && !opts.check) {
      mkdirSync(dirname(f.path), { recursive: true })
      writeFileSync(f.path, f.content, 'utf8')
    }
  }
  return { changed, unchanged }
}
