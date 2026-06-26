/**
 * Local multi-process stress harness. Spawns N independent OS processes (each a
 * separate libSQL connection = a separate "agent") hammering the SAME local store,
 * then verifies data-integrity invariants. Run:
 *
 *   node_modules/.bin/tsx scripts/stress/local.mts --workers 12 --ops 150 --phase all
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sql } from 'kysely'
import { createContext, getContext } from '../../src/core/contexts'
import { openStore } from '../../src/core/db'
import { migrateToLatest } from '../../src/core/migrate'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const WORKER = join(HERE, 'worker.mts')
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx')

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}
const WORKERS = Number(arg('workers', '12'))
const OPS = Number(arg('ops', '150'))
const PHASE = arg('phase', 'all')

interface WorkerResult {
  workerId: number
  succeeded: number
  failed: number
  opCounts: Record<string, number>
  errors: Record<string, number>
  errorSamples: string[]
  created: string[]
}

function spawnWorker(env: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn(TSX, [WORKER], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'ignore', 'inherit'],
    })
    p.on('exit', (code) => resolve(code ?? 0))
  })
}

async function runPhase(
  label: string,
  file: string,
  phase: string,
  sharedIds: string[] = [],
): Promise<{ results: WorkerResult[]; wallMs: number }> {
  const dir = mkdtempSync(join(tmpdir(), 'bctx-stress-res-'))
  const t0 = Date.now()
  const codes = await Promise.all(
    Array.from({ length: WORKERS }, (_, w) =>
      spawnWorker({
        BCTX_STRESS_DB: file,
        BCTX_STRESS_WORKER: String(w),
        BCTX_STRESS_OPS: String(OPS),
        BCTX_STRESS_PHASE: phase,
        BCTX_STRESS_RESULT: join(dir, `w${w}.json`),
        BCTX_STRESS_SHARED_IDS: sharedIds.join(','),
        BCTX_STRESS_NS: 'stress',
      }),
    ),
  )
  const wallMs = Date.now() - t0
  const results: WorkerResult[] = []
  for (let w = 0; w < WORKERS; w++) {
    try {
      results.push(JSON.parse(readFileSync(join(dir, `w${w}.json`), 'utf8')))
    } catch {
      results.push({
        workerId: w,
        succeeded: 0,
        failed: OPS,
        opCounts: {},
        errors: { NO_RESULT: 1 },
        errorSamples: [`exit ${codes[w]}, no result file`],
        created: [],
      })
    }
  }
  rmSync(dir, { recursive: true, force: true })

  const agg = { succeeded: 0, failed: 0, errors: {} as Record<string, number> }
  for (const r of results) {
    agg.succeeded += r.succeeded
    agg.failed += r.failed
    for (const [k, v] of Object.entries(r.errors)) agg.errors[k] = (agg.errors[k] ?? 0) + v
  }
  console.log(
    `\n[${label}] ${WORKERS} workers × ${OPS} ops in ${wallMs}ms — ok=${agg.succeeded} fail=${agg.failed}`,
  )
  if (agg.failed > 0) {
    console.log(`  errors:`, JSON.stringify(agg.errors))
    const sample = results.find((r) => r.errorSamples.length)?.errorSamples[0]
    if (sample) console.log(`  e.g.:`, sample)
  }
  return { results, wallMs }
}

async function num(
  db: ReturnType<typeof openStore>['db'],
  q: ReturnType<typeof sql>,
): Promise<number> {
  const r = (await q.execute(db)) as { rows: Array<{ n: number | bigint }> }
  return Number(r.rows[0]?.n ?? 0)
}

async function verify(file: string): Promise<string[]> {
  const store = openStore({ mode: 'local', file })
  await store.prepare()
  const db = store.db
  const issues: string[] = []
  try {
    const total = await num(db, sql`SELECT count(*) AS n FROM contexts`)
    const live = await num(db, sql`SELECT count(*) AS n FROM contexts WHERE deleted_at IS NULL`)
    const dups = await num(
      db,
      sql`SELECT count(*) AS n FROM (SELECT id FROM contexts GROUP BY id HAVING count(*) > 1)`,
    )
    const orphanTags = await num(
      db,
      sql`SELECT count(*) AS n FROM context_tags ct LEFT JOIN contexts c ON c.id = ct.context_id WHERE c.id IS NULL`,
    )
    const orphanSkills = await num(
      db,
      sql`SELECT count(*) AS n FROM skill_files sf LEFT JOIN contexts c ON c.id = sf.context_id WHERE c.id IS NULL`,
    )
    const noCreate = await num(
      db,
      sql`SELECT count(*) AS n FROM contexts c WHERE NOT EXISTS (SELECT 1 FROM context_history h WHERE h.context_id = c.id AND h.event = 'create')`,
    )
    // FTS5 external-content integrity (throws if the shadow index drifted/corrupted).
    let ftsOk = true
    try {
      await sql`INSERT INTO contexts_fts(contexts_fts) VALUES('integrity-check')`.execute(db)
    } catch (e) {
      ftsOk = false
      issues.push(`FTS integrity-check failed: ${(e as Error).message}`)
    }
    // A live context must be findable via FTS (index not silently missing rows).
    const ftsDocs = await num(db, sql`SELECT count(*) AS n FROM contexts_fts`)

    console.log(
      `  verify: total=${total} live=${live} ftsDocs=${ftsDocs} fts=${ftsOk ? 'ok' : 'BAD'} ` +
        `dupIds=${dups} orphanTags=${orphanTags} orphanSkills=${orphanSkills} missingCreateHist=${noCreate}`,
    )
    if (dups > 0) issues.push(`duplicate context ids: ${dups}`)
    if (orphanTags > 0) issues.push(`orphan context_tags rows: ${orphanTags}`)
    if (orphanSkills > 0) issues.push(`orphan skill_files rows: ${orphanSkills}`)
    if (noCreate > 0) issues.push(`contexts missing a create history event: ${noCreate}`)
    if (ftsDocs !== total) issues.push(`FTS doc count ${ftsDocs} != contexts ${total}`)
  } finally {
    await store.close()
  }
  return issues
}

async function migrateFile(file: string): Promise<void> {
  const s = openStore({ mode: 'local', file })
  await s.prepare()
  await migrateToLatest(s.db, { lockFile: file })
  await s.close()
}

async function main() {
  const home = mkdtempSync(join(tmpdir(), 'bctx-stress-'))
  const allIssues: string[] = []

  // ── Migration race: workers start against an EMPTY file; each runs migrate. ──
  if (PHASE === 'all' || PHASE === 'migrate-race') {
    const file = join(home, 'migrate-race.db')
    const { results } = await runPhase('migrate-race', file, 'own')
    const failed = results.reduce((s, r) => s + r.failed, 0)
    if (failed > 0) allIssues.push(`migrate-race: ${failed} op failures`)
    allIssues.push(...(await verify(file)).map((i) => `migrate-race: ${i}`))
  }

  // ── General CRUD contention (pre-migrated). ──
  if (PHASE === 'all' || PHASE === 'own') {
    const file = join(home, 'own.db')
    {
      const s = openStore({ mode: 'local', file })
      await s.prepare()
      await migrateToLatest(s.db, { lockFile: file })
      await s.close()
    }
    const { results } = await runPhase('general-crud', file, 'own')
    const failed = results.reduce((s, r) => s + r.failed, 0)
    if (failed > 0) allIssues.push(`general-crud: ${failed} op failures`)
    allIssues.push(...(await verify(file)).map((i) => `general-crud: ${i}`))
  }

  // ── Same-row contention: all workers update a SHARED set concurrently. ──
  if (PHASE === 'all' || PHASE === 'shared') {
    const file = join(home, 'shared.db')
    const sharedIds: string[] = []
    {
      const s = openStore({ mode: 'local', file })
      await s.prepare()
      await migrateToLatest(s.db, { lockFile: file })
      for (let k = 0; k < 5; k++) {
        const c = await createContext(s.db, {
          body: `shared ${k}`,
          kind: 'note',
          namespace: 'stress',
        })
        sharedIds.push(c.id)
      }
      await s.close()
    }
    const { results } = await runPhase('same-row', file, 'shared', sharedIds)
    const failed = results.reduce((s, r) => s + r.failed, 0)
    if (failed > 0) allIssues.push(`same-row: ${failed} op failures`)
    // Shared rows must survive and stay readable.
    {
      const s = openStore({ mode: 'local', file })
      await s.prepare()
      for (const id of sharedIds) {
        const c = await getContext(s.db, id)
        if (!c) allIssues.push(`same-row: shared id ${id} vanished`)
      }
      await s.close()
    }
    allIssues.push(...(await verify(file)).map((i) => `same-row: ${i}`))
  }

  // ── Lost-update: all workers setMetadata({unique key}) on ONE shared id. ──
  if (PHASE === 'all' || PHASE === 'meta') {
    const file = join(home, 'meta.db')
    let id = ''
    {
      const s = openStore({ mode: 'local', file })
      await s.prepare()
      await migrateToLatest(s.db, { lockFile: file })
      const c = await createContext(s.db, {
        body: 'lost-update target',
        kind: 'note',
        namespace: 'stress',
      })
      id = c.id
      await s.close()
    }
    const { results } = await runPhase('lost-update', file, 'meta', [id])
    const ok = results.reduce((s, r) => s + r.succeeded, 0)
    const failed = results.reduce((s, r) => s + r.failed, 0)
    if (failed > 0) allIssues.push(`lost-update: ${failed} op failures`)
    {
      const s = openStore({ mode: 'local', file })
      await s.prepare()
      const ctx = await getContext(s.db, id)
      const keys = Object.keys(ctx?.metadata ?? {}).length
      const hist = await num(
        s.db,
        sql`SELECT count(*) AS n FROM context_history WHERE context_id = ${id} AND event = 'update'`,
      )
      console.log(`  verify: metadataKeys=${keys} successfulUpdates=${ok} updateHistory=${hist}`)
      // Every successful setMetadata wrote a UNIQUE key — none may be lost.
      if (keys !== ok)
        allIssues.push(`lost-update: metadata keys ${keys} != successful updates ${ok}`)
      if (hist !== ok)
        allIssues.push(`lost-update: update history ${hist} != successful updates ${ok}`)
      await s.close()
    }
  }

  // ── Wiki contention: concurrent createPage/updatePage with shared [[titles]]. ──
  if (PHASE === 'all' || PHASE === 'wiki') {
    const file = join(home, 'wiki.db')
    await migrateFile(file)
    const { results } = await runPhase('wiki', file, 'wiki')
    const failed = results.reduce((s, r) => s + r.failed, 0)
    if (failed > 0) allIssues.push(`wiki: ${failed} op failures`)
    {
      const s = openStore({ mode: 'local', file })
      await s.prepare()
      const dupResolved = await num(
        s.db,
        sql`SELECT count(*) AS n FROM (
              SELECT from_id, type, to_id FROM links WHERE to_id IS NOT NULL
              GROUP BY from_id, type, to_id HAVING count(*) > 1)`,
      )
      const orphanLinks = await num(
        s.db,
        sql`SELECT count(*) AS n FROM links l LEFT JOIN contexts c ON c.id = l.from_id WHERE c.id IS NULL`,
      )
      const pages = await num(
        s.db,
        sql`SELECT count(*) AS n FROM contexts WHERE page_type IS NOT NULL`,
      )
      console.log(
        `  verify: pages=${pages} dupResolvedLinks=${dupResolved} orphanLinks=${orphanLinks}`,
      )
      if (dupResolved > 0) allIssues.push(`wiki: ${dupResolved} duplicate resolved links`)
      if (orphanLinks > 0) allIssues.push(`wiki: ${orphanLinks} orphan links`)
      await s.close()
    }
    allIssues.push(...(await verify(file)).map((i) => `wiki: ${i}`))
  }

  // ── Skill import: concurrent importSkill from a small shared name pool. ──
  if (PHASE === 'all' || PHASE === 'skill') {
    const file = join(home, 'skill.db')
    await migrateFile(file)
    const { results } = await runPhase('skill', file, 'skill')
    const failed = results.reduce((s, r) => s + r.failed, 0)
    if (failed > 0) allIssues.push(`skill: ${failed} op failures`)
    {
      const s = openStore({ mode: 'local', file })
      await s.prepare()
      const dupLiveSkills = await num(
        s.db,
        sql`SELECT count(*) AS n FROM (
              SELECT title FROM contexts WHERE kind = 'skill' AND deleted_at IS NULL
              GROUP BY title, namespace HAVING count(*) > 1)`,
      )
      const liveSkills = await num(
        s.db,
        sql`SELECT count(*) AS n FROM contexts WHERE kind = 'skill' AND deleted_at IS NULL`,
      )
      console.log(`  verify: liveSkills=${liveSkills} dupLiveSkillNames=${dupLiveSkills}`)
      if (dupLiveSkills > 0) allIssues.push(`skill: ${dupLiveSkills} duplicate live skill names`)
      await s.close()
    }
    allIssues.push(...(await verify(file)).map((i) => `skill: ${i}`))
  }

  rmSync(home, { recursive: true, force: true })

  console.log(`\n${'='.repeat(60)}`)
  if (allIssues.length === 0) {
    console.log('STRESS RESULT: PASS — no op failures, all invariants hold.')
    process.exit(0)
  } else {
    console.log(`STRESS RESULT: FAIL — ${allIssues.length} issue(s):`)
    for (const i of allIssues) console.log(`  - ${i}`)
    process.exit(1)
  }
}

main()
