/**
 * Remote / online stress harness against a real libSQL (Turso) primary.
 *
 *   BCTX_RURL=libsql://… BCTX_RTOKEN=… \
 *     node_modules/.bin/tsx scripts/stress/remote.mts --workers 6 --ops 15 --replicas 3 --seed 8
 *
 * Scenarios: concurrent CRUD across independent remote clients, and replica
 * write-through + sync convergence. All work happens in an isolated namespace
 * that is deleted on completion, so the shared test DB stays clean.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@libsql/client'
import { sql } from 'kysely'
import { kyselyFor } from '../../src/core/db'
import { migrateToLatest } from '../../src/core/migrate'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const WORKER = join(HERE, 'worker.mts')
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx')

const URL = process.env.BCTX_RURL ?? ''
const TOKEN = process.env.BCTX_RTOKEN ?? ''
if (!URL || !TOKEN) {
  console.error('Set BCTX_RURL and BCTX_RTOKEN.')
  process.exit(2)
}

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}
const WORKERS = Number(arg('workers', '6'))
const OPS = Number(arg('ops', '15'))
const REPLICAS = Number(arg('replicas', '3'))
const SEED = Number(arg('seed', '8'))
const NS = `rstress-${process.pid}-${Date.now()}`

interface WorkerResult {
  workerId: number
  succeeded: number
  failed: number
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

function readResults(dir: string, n: number, codes: number[]): WorkerResult[] {
  const out: WorkerResult[] = []
  for (let w = 0; w < n; w++) {
    try {
      out.push(JSON.parse(readFileSync(join(dir, `w${w}.json`), 'utf8')))
    } catch {
      out.push({
        workerId: w,
        succeeded: 0,
        failed: OPS,
        errors: { NO_RESULT: 1 },
        errorSamples: [`exit ${codes[w]}`],
        created: [],
      })
    }
  }
  return out
}

function openRemote() {
  const client = createClient({ url: URL, authToken: TOKEN })
  const db = kyselyFor(client)
  return {
    db,
    close: async () => {
      await db.destroy()
      client.close()
    },
  }
}

async function num(
  db: ReturnType<typeof openRemote>['db'],
  q: ReturnType<typeof sql>,
): Promise<number> {
  const r = (await q.execute(db)) as { rows: Array<{ n: number | bigint }> }
  return Number(r.rows[0]?.n ?? 0)
}

async function main() {
  const home = mkdtempSync(join(tmpdir(), 'bctx-rstress-'))
  const issues: string[] = []
  console.log(`Remote stress against ${URL}\nnamespace: ${NS}`)

  // Migrate the primary once (workers will see it current and skip).
  {
    const r = openRemote()
    const t0 = Date.now()
    await migrateToLatest(r.db)
    console.log(`migrate primary ok (${Date.now() - t0}ms)`)
    await r.close()
  }

  // ── R1/R3: concurrent CRUD across independent remote clients. ──
  {
    const dir = mkdtempSync(join(tmpdir(), 'bctx-rres-'))
    const t0 = Date.now()
    const codes = await Promise.all(
      Array.from({ length: WORKERS }, (_, w) =>
        spawnWorker({
          BCTX_STRESS_MODE: 'remote',
          BCTX_STRESS_URL: URL,
          BCTX_STRESS_TOKEN: TOKEN,
          BCTX_STRESS_DB: '',
          BCTX_STRESS_WORKER: String(w),
          BCTX_STRESS_OPS: String(OPS),
          BCTX_STRESS_PHASE: 'own',
          BCTX_STRESS_RESULT: join(dir, `w${w}.json`),
          BCTX_STRESS_NS: NS,
        }),
      ),
    )
    const results = readResults(dir, WORKERS, codes)
    rmSync(dir, { recursive: true, force: true })
    const ok = results.reduce((s, r) => s + r.succeeded, 0)
    const failed = results.reduce((s, r) => s + r.failed, 0)
    const errs: Record<string, number> = {}
    for (const r of results)
      for (const [k, v] of Object.entries(r.errors)) errs[k] = (errs[k] ?? 0) + v
    console.log(
      `\n[remote-crud] ${WORKERS} clients × ${OPS} ops in ${Date.now() - t0}ms — ok=${ok} fail=${failed}`,
    )
    if (failed > 0) {
      console.log('  errors:', JSON.stringify(errs))
      console.log('  e.g.:', results.find((r) => r.errorSamples.length)?.errorSamples[0])
      issues.push(`remote-crud: ${failed} op failures`)
    }
    // Verify on the primary (scoped to the run namespace).
    const r = openRemote()
    const total = await num(r.db, sql`SELECT count(*) AS n FROM contexts WHERE namespace = ${NS}`)
    const dups = await num(
      r.db,
      sql`SELECT count(*) AS n FROM (SELECT id FROM contexts WHERE namespace = ${NS} GROUP BY id HAVING count(*) > 1)`,
    )
    const orphanTags = await num(
      r.db,
      sql`SELECT count(*) AS n FROM context_tags ct JOIN contexts c ON c.id = ct.context_id
          WHERE c.namespace = ${NS} AND NOT EXISTS (SELECT 1 FROM contexts x WHERE x.id = ct.context_id)`,
    )
    const fts = await num(
      r.db,
      sql`SELECT count(*) AS n FROM contexts c JOIN contexts_fts f ON f.rowid = c.rowid
          WHERE c.namespace = ${NS} AND contexts_fts MATCH 'pnpm'`,
    )
    console.log(
      `  verify(primary): total=${total} dupIds=${dups} orphanTags=${orphanTags} ftsMatch(pnpm)=${fts}`,
    )
    if (dups > 0) issues.push(`remote-crud: ${dups} duplicate ids`)
    if (orphanTags > 0) issues.push(`remote-crud: ${orphanTags} orphan tags`)
    await r.close()
  }

  // ── R2: replica write-through + sync convergence. ──
  {
    const dir = mkdtempSync(join(tmpdir(), 'bctx-rres2-'))
    const replicaFiles = Array.from({ length: REPLICAS }, (_, w) => join(home, `replica-${w}.db`))
    const t0 = Date.now()
    const codes = await Promise.all(
      Array.from({ length: REPLICAS }, (_, w) =>
        spawnWorker({
          BCTX_STRESS_MODE: 'replica',
          BCTX_STRESS_URL: URL,
          BCTX_STRESS_TOKEN: TOKEN,
          BCTX_STRESS_DB: replicaFiles[w],
          BCTX_STRESS_WORKER: String(w),
          BCTX_STRESS_OPS: String(SEED),
          BCTX_STRESS_PHASE: 'seed',
          BCTX_STRESS_RESULT: join(dir, `w${w}.json`),
          BCTX_STRESS_NS: NS,
        }),
      ),
    )
    const results = readResults(dir, REPLICAS, codes)
    rmSync(dir, { recursive: true, force: true })
    const seeded = results.reduce((s, r) => s + r.succeeded, 0)
    const failed = results.reduce((s, r) => s + r.failed, 0)
    console.log(
      `\n[replica-converge] ${REPLICAS} replicas × ${SEED} writes in ${Date.now() - t0}ms — ok=${seeded} fail=${failed}`,
    )
    if (failed > 0) {
      console.log('  e.g.:', results.find((r) => r.errorSamples.length)?.errorSamples[0])
      issues.push(`replica-converge: ${failed} write failures`)
    }

    // Primary must hold every write-through.
    const r = openRemote()
    const onPrimary = await num(
      r.db,
      sql`SELECT count(*) AS n FROM contexts WHERE namespace = ${NS} AND title LIKE 'seed-%'`,
    )
    await r.close()

    // A fresh replica must bootstrap to the same set.
    const freshFile = join(home, 'fresh.db')
    const fresh = createClient({ url: `file:${freshFile}`, syncUrl: URL, authToken: TOKEN })
    await fresh.sync()
    const fdb = kyselyFor(fresh)
    const onFresh = await num(
      fdb,
      sql`SELECT count(*) AS n FROM contexts WHERE namespace = ${NS} AND title LIKE 'seed-%'`,
    )
    await fdb.destroy()
    fresh.close()

    console.log(`  converge: seeded=${seeded} onPrimary=${onPrimary} onFreshReplica=${onFresh}`)
    if (onPrimary !== seeded)
      issues.push(`replica-converge: primary has ${onPrimary}, expected ${seeded}`)
    if (onFresh !== seeded)
      issues.push(`replica-converge: fresh replica has ${onFresh}, expected ${seeded}`)
  }

  // ── Cleanup the run namespace on the primary. ──
  {
    const r = openRemote()
    await sql`DELETE FROM context_history WHERE context_id IN (SELECT id FROM contexts WHERE namespace = ${NS})`.execute(
      r.db,
    )
    await sql`DELETE FROM contexts WHERE namespace = ${NS}`.execute(r.db)
    const left = await num(r.db, sql`SELECT count(*) AS n FROM contexts WHERE namespace = ${NS}`)
    console.log(`\ncleanup: ${left} rows left in ${NS}`)
    await r.close()
  }
  rmSync(home, { recursive: true, force: true })

  console.log(`\n${'='.repeat(60)}`)
  if (issues.length === 0) {
    console.log('REMOTE STRESS RESULT: PASS — concurrent CRUD + replica convergence clean.')
    process.exit(0)
  } else {
    console.log(`REMOTE STRESS RESULT: FAIL — ${issues.length} issue(s):`)
    for (const i of issues) console.log(`  - ${i}`)
    process.exit(1)
  }
}

main()
