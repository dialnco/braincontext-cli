/**
 * Stress worker: one OS process = one "agent" with its own libSQL connection to a
 * shared store. Bursts many CRUD ops, tallies per-op outcomes, and writes a JSON
 * result. Driven by env from scripts/stress/local.mts.
 *
 * Phases:
 *   own    — general CRUD on this worker's own ids
 *   shared — every op updates a shared id pool (same-row contention)
 *   meta   — every op setMetadata({unique key}) on ONE shared id (lost-update test)
 *   wiki   — createPage/updatePage with shared [[titles]] (slug + link-dedup races)
 *   skill  — importSkill from a small shared name pool (replace-on-reimport race)
 */
import { writeFileSync } from 'node:fs'
import {
  createContext,
  deleteContext,
  getContext,
  listContexts,
  searchContexts,
  updateContext,
} from '../../src/core/contexts'
import { type DbTarget, openStore } from '../../src/core/db'
import { migrateToLatest } from '../../src/core/migrate'
import { importSkill } from '../../src/core/skills'
import { addLink, createPage, listPages, updatePage } from '../../src/core/wiki'

const file = process.env.BCTX_STRESS_DB as string
const storeMode = (process.env.BCTX_STRESS_MODE ?? 'local') as 'local' | 'remote' | 'replica'
const url = process.env.BCTX_STRESS_URL ?? ''
const token = process.env.BCTX_STRESS_TOKEN || undefined
const workerId = Number(process.env.BCTX_STRESS_WORKER ?? '0')
const ops = Number(process.env.BCTX_STRESS_OPS ?? '100')
const phase = process.env.BCTX_STRESS_PHASE ?? 'own'
const resultPath = process.env.BCTX_STRESS_RESULT as string
const shared = (process.env.BCTX_STRESS_SHARED_IDS ?? '').split(',').filter(Boolean)
const ns = process.env.BCTX_STRESS_NS ?? 'global'

const SKILL_NAMES = ['alpha-skill', 'beta-skill', 'gamma-skill']
const WIKI_TITLES = ['Gateway', 'OAuth2', 'Token', 'Session', 'Cache']

const errors: Record<string, number> = {}
const errorSamples: string[] = []
const opCounts: Record<string, number> = {}
const created: string[] = []
let succeeded = 0
let failed = 0

function classify(e: unknown): string {
  const anyE = e as { code?: string; message?: string }
  const code = anyE.code
  const msg = anyE.message ?? String(e)
  if (code) return code
  if (/SQLITE_BUSY|database is locked/i.test(msg)) return 'SQLITE_BUSY'
  if (/UNIQUE/i.test(msg)) return 'UNIQUE'
  if (/no such table|no such column/i.test(msg)) return 'SCHEMA'
  return msg.slice(0, 60)
}

function pick<T>(arr: T[]): T | undefined {
  return arr.length ? arr[Math.floor(Math.random() * arr.length)] : undefined
}
const rnd = () => Math.random().toString(36).slice(2, 8)
function tally(op: string) {
  opCounts[op] = (opCounts[op] ?? 0) + 1
  succeeded++
}

// biome-ignore lint/suspicious/noExplicitAny: stress harness uses the core Kysely directly
async function doOp(db: any, i: number): Promise<void> {
  if (phase === 'seed') {
    // Deterministic pure-add: convergence tests count these across replicas.
    const c = await createContext(db, {
      body: `seed w${workerId} op${i} ${rnd()}`,
      kind: 'note',
      title: `seed-w${workerId}-${i}`,
      namespace: ns,
      tags: [`w${workerId}`],
    })
    created.push(c.id)
    return tally('seed')
  }

  if (phase === 'meta') {
    const id = shared[0]
    await updateContext(db, id, {
      setMetadata: { [`w${workerId}_${i}`]: i },
      agentSource: `w${workerId}`,
    })
    return tally('meta')
  }

  if (phase === 'skill') {
    const name = SKILL_NAMES[i % SKILL_NAMES.length]
    await importSkill(db, {
      name,
      description: `d ${workerId}`,
      body: `# ${name}\nworker ${workerId} op ${i} ${rnd()}`,
      frontmatter: { name, description: 'd' },
      files: [
        { relPath: 'ref.md', content: Buffer.from(`ref ${workerId}-${i}`), isExecutable: false },
      ],
      namespace: ns,
    })
    return tally('skill')
  }

  if (phase === 'wiki') {
    const r = Math.random()
    if (r < 0.5 || created.length === 0) {
      // create a page; sometimes a SHARED title (slug race), always linking shared titles
      const title =
        Math.random() < 0.4 ? (pick(WIKI_TITLES) as string) : `W${workerId}-${i}-${rnd()}`
      const body = `see [[${pick(WIKI_TITLES)}]] and [[${pick(WIKI_TITLES)}]]`
      const p = await createPage(db, { title, pageType: 'concept', body, namespace: ns })
      created.push(p.id)
      return tally('page-create')
    }
    if (r < 0.8) {
      const id = pick(created) as string
      await updatePage(db, id, {
        body: `edit ${rnd()} [[${pick(WIKI_TITLES)}]] [[${pick(WIKI_TITLES)}]]`,
      })
      return tally('page-update')
    }
    const id = pick(created) as string
    await addLink(db, id, { toTitle: pick(WIKI_TITLES) as string, type: 'relates' })
    return tally('link')
  }

  if (phase === 'shared') {
    const id = pick(shared)
    if (!id) return
    await updateContext(db, id, {
      body: `w${workerId} edit ${i} ${rnd()}`,
      addTags: [`u${workerId}`],
      agentSource: `w${workerId}`,
    })
    return tally('update')
  }

  // phase 'own': mixed CRUD on this worker's own ids
  const r = Math.random()
  const op = r < 0.5 ? 'add' : r < 0.7 ? 'update' : r < 0.85 ? 'search' : r < 0.9 ? 'list' : 'rm'
  if (op === 'add') {
    const c = await createContext(db, {
      body: `w${workerId} op${i} pnpm rust tls ${rnd()}`,
      kind: 'note',
      title: `w${workerId}-${i}`,
      namespace: ns,
      tags: [`w${workerId}`, `t${i % 5}`, 'shared-tag'],
    })
    created.push(c.id)
    return tally('add')
  }
  if (op === 'update') {
    const id = pick(created)
    if (!id) return
    await updateContext(db, id, {
      body: `w${workerId} edit op${i} ${rnd()}`,
      addTags: [`u${workerId}`],
    })
    return tally('update')
  }
  if (op === 'search') {
    await searchContexts(db, pick(['pnpm', 'rust', 'tls', 'shared-tag', 'edit']) ?? 'pnpm', {
      namespace: ns,
    })
    return tally('search')
  }
  if (op === 'list') {
    if (phase === 'wiki') await listPages(db, { namespace: ns, limit: 20 })
    else await listContexts(db, { namespace: ns, limit: 20 })
    return tally('list')
  }
  // rm
  const id = pick(created)
  if (!id) return
  await deleteContext(db, id, { hard: false, agentSource: `w${workerId}` })
  created.splice(created.indexOf(id), 1)
  return tally('rm')
}

function target(): DbTarget {
  if (storeMode === 'remote') return { mode: 'remote', url, authToken: token }
  if (storeMode === 'replica') return { mode: 'replica', file, syncUrl: url, authToken: token }
  return { mode: 'local', file }
}

async function run() {
  const store = openStore(target())
  try {
    await store.prepare()
    await store.sync() // replica: pull latest before starting
    await migrateToLatest(store.db, { lockFile: storeMode === 'local' ? file : undefined })
    for (let i = 0; i < ops; i++) {
      try {
        await doOp(store.db, i)
        if (storeMode === 'replica') await store.sync() // settle each write-through
      } catch (e) {
        failed++
        const k = classify(e)
        errors[k] = (errors[k] ?? 0) + 1
        if (errorSamples.length < 5) errorSamples.push(`${phase}: ${(e as Error).message ?? e}`)
      }
    }
    await store.sync()
  } finally {
    await store.close()
  }
}

run()
  .then(() => {
    writeFileSync(
      resultPath,
      JSON.stringify({
        workerId,
        phase,
        ops,
        succeeded,
        failed,
        opCounts,
        errors,
        errorSamples,
        created,
      }),
    )
    process.exit(0)
  })
  .catch((e) => {
    writeFileSync(
      resultPath,
      JSON.stringify({
        workerId,
        phase,
        ops,
        succeeded,
        failed: failed + 1,
        opCounts,
        errors: { ...errors, FATAL: 1 },
        errorSamples: [...errorSamples, `FATAL: ${(e as Error).message ?? e}`],
        created,
      }),
    )
    process.exit(1)
  })
