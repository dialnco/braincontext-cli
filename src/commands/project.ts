import { mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { Command } from 'commander'
import { type DbTarget, openStore } from '../core/db'
import { contextRowCount, seedDatabase } from '../core/dump'
import { withFileLock } from '../core/lock'
import { migrateToLatest } from '../core/migrate'
import {
  addProject,
  currentProjectName,
  defaultProjectFile,
  getProject,
  listProjects,
  type ProjectEntry,
  projectFilePath,
  projectToTarget,
  removeProject,
  resolveToken,
  setCurrent,
  setToken,
  updateProject,
  validateProjectName,
} from '../core/registry'
import { parsePositiveInt } from './_shared'

/** Open a target, ensure schema, run `fn`, always close. */
async function withTarget<T>(
  target: DbTarget,
  fn: (db: Awaited<ReturnType<typeof openStore>>['db']) => Promise<T>,
): Promise<T> {
  if (target.mode !== 'remote') mkdirSync(dirname(target.file), { recursive: true })
  const store = openStore(target)
  try {
    await store.prepare()
    await migrateToLatest(store.db, {
      lockFile: target.mode !== 'remote' ? target.file : undefined,
    })
    return await fn(store.db)
  } finally {
    await store.close()
  }
}

function requireProject(name: string): ProjectEntry {
  const entry = getProject(name)
  if (!entry) throw new Error(`No such project: "${name}". Run \`bctx project list\`.`)
  return entry
}

/** The token to use for an online operation: --auth-token > --auth-token-env > stored. */
function operationToken(name: string, opts: { authToken?: string; authTokenEnv?: string }): string {
  const token = opts.authToken ?? (opts.authTokenEnv ? process.env[opts.authTokenEnv] : undefined)
  const resolved = token ?? resolveToken(name)
  if (!resolved) {
    throw new Error(
      'No auth token. Pass --auth-token <t>, --auth-token-env <VAR>, or set BCTX_TOKEN_' +
        `${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}.`,
    )
  }
  return resolved
}

function describeTarget(t: DbTarget): string {
  if (t.mode === 'remote') return `remote ${t.url}`
  if (t.mode === 'replica') return `replica ${t.file} ⇄ ${t.syncUrl}`
  return `local ${t.file}`
}

/** Delete a local sqlite file and its WAL/SHM/journal sidecars. */
function removeDbFile(file: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(file + suffix, { force: true })
}

/** Run a remote operation, turning low-level connection failures into a clear message. */
async function reachRemote<T>(url: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new Error(`Could not reach the remote primary at ${url}: ${msg}`)
  }
}

export function projectCommand(): Command {
  const project = new Command('project').description(
    'Manage projects: multiple stores you can switch between, and take online so the\n' +
      'same context syncs across sessions, devices, and members (libSQL/Turso replicas).',
  )

  // ── create ────────────────────────────────────────────────────────────────
  project
    .command('create <name>')
    .description('Create a new local project store under ~/.braincontext/projects/.')
    .option('--from <db>', 'seed the new project from an existing SQLite store')
    .action(async (name: string, opts: { from?: string }) => {
      validateProjectName(name)
      if (getProject(name)) throw new Error(`Project already exists: "${name}".`)
      const file = defaultProjectFile(name)
      const target: DbTarget = {
        mode: 'local',
        file: projectFilePath({ mode: 'local', file, createdAt: '' }),
      }
      await withTarget(target, async (dest) => {
        if (opts.from) {
          await withTarget({ mode: 'local', file: opts.from }, async (src) => {
            if ((await contextRowCount(dest)) > 0)
              throw new Error('New project store is not empty.')
            await seedDatabase(src, dest)
          })
        }
      })
      addProject(name, { mode: 'local', file, createdAt: new Date().toISOString() })
      console.log(`Created project "${name}" → ${target.file}`)
      console.log(`Use it with:  bctx project use ${name}`)
    })

  // ── list ──────────────────────────────────────────────────────────────────
  project
    .command('list')
    .description('List projects (current is marked with *).')
    .option('--json', 'output JSON')
    .action((opts: { json?: boolean }) => {
      const rows = listProjects()
      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2))
        return
      }
      for (const { name, entry, current } of rows) {
        const where = describeTarget(projectToTarget(name, entry))
        console.log(`${current ? '*' : ' '} ${name.padEnd(20)} [${entry.mode}]  ${where}`)
      }
    })

  // ── use / current ───────────────────────────────────────────────────────────
  project
    .command('use <name>')
    .description('Set the current project.')
    .action((name: string) => {
      setCurrent(name)
      console.log(`Current project: ${name}`)
    })

  project
    .command('current')
    .description('Print the current project name.')
    .action(() => {
      console.log(currentProjectName())
    })

  // ── path ──────────────────────────────────────────────────────────────────
  project
    .command('path [name]')
    .description('Print a project’s resolved store path or URL (defaults to current).')
    .action((name: string | undefined) => {
      const n = name ?? currentProjectName()
      const t = projectToTarget(n, requireProject(n))
      console.log(t.mode === 'remote' ? t.url : t.file)
    })

  // ── rm ────────────────────────────────────────────────────────────────────
  project
    .command('rm <name>')
    .description('Remove a project from the registry (the "default" project cannot be removed).')
    .option('--keep-file', 'keep the local store file on disk')
    .action((name: string, opts: { keepFile?: boolean }) => {
      const entry = requireProject(name)
      const removed = removeProject(name)
      if (!opts.keepFile && removed.mode !== 'remote') removeDbFile(projectFilePath(entry))
      console.log(`Removed project "${name}"${opts.keepFile ? ' (kept file)' : ''}.`)
    })

  // ── migrate-online (device 1: push local up, become a replica) ──────────────
  project
    .command('migrate-online <name>')
    .description(
      'Take a local project online: seed a remote libSQL/Turso primary, then become an embedded replica.',
    )
    .requiredOption('--url <url>', 'remote libSQL primary URL (libsql://… or https://…)')
    .option('--auth-token <token>', 'auth token (stored in credentials.json, 0600)')
    .option('--auth-token-env <var>', 'read the auth token from this env var (not stored)')
    .option('--sync-interval <seconds>', 'background replica sync interval')
    .action(
      async (
        name: string,
        opts: { url: string; authToken?: string; authTokenEnv?: string; syncInterval?: string },
      ) => {
        const entry = requireProject(name)
        if (entry.mode !== 'local') {
          throw new Error(`Project "${name}" is already ${entry.mode}. Use a local project.`)
        }
        const token = operationToken(name, opts)
        const syncInterval = parsePositiveInt(opts.syncInterval, 'sync-interval')
        const localFile = projectFilePath(entry)

        // Serialize the whole bootstrap so two concurrent `migrate-online` runs can't
        // double-seed the remote or race the local-file swap.
        await withFileLock(`${localFile}.bootstrap.lock`, async () => {
          // 1. Prepare the remote primary, verify it is empty, and seed it from the local
          //    store. Nothing is persisted until this succeeds, so a failure leaves the
          //    project untouched (still local).
          await reachRemote(opts.url, () =>
            withTarget({ mode: 'remote', url: opts.url, authToken: token }, async (remote) => {
              if ((await contextRowCount(remote)) > 0) {
                throw new Error(
                  `Remote at ${opts.url} is not empty. Use \`bctx project link\` to attach to existing data.`,
                )
              }
              await withTarget({ mode: 'local', file: localFile }, async (local) => {
                const counts = await seedDatabase(local, remote)
                console.error(`Seeded remote: ${counts.contexts} contexts, ${counts.links} links.`)
              })
            }),
          )

          // 2. Persist config + token, flip to replica.
          if (opts.authToken) setToken(name, opts.authToken)
          updateProject(name, { mode: 'replica', syncUrl: opts.url, syncInterval })

          // 3. Re-bootstrap the local file as an embedded replica of the new primary.
          removeDbFile(localFile)
          await reachRemote(opts.url, async () => {
            const store = openStore(projectToTarget(name, requireProject(name)))
            try {
              await store.sync()
            } finally {
              await store.close()
            }
          })
        })
        console.log(`Project "${name}" is now online (replica ⇄ ${opts.url}).`)
      },
    )

  // ── link (device 2…: attach to an existing remote) ──────────────────────────
  project
    .command('link <name>')
    .description(
      'Register a project that points at an existing remote primary; bootstraps a local replica.',
    )
    .requiredOption('--url <url>', 'remote libSQL primary URL')
    .option('--auth-token <token>', 'auth token (stored in credentials.json, 0600)')
    .option('--auth-token-env <var>', 'read the auth token from this env var (not stored)')
    .option('--sync-interval <seconds>', 'background replica sync interval')
    .action(
      async (
        name: string,
        opts: { url: string; authToken?: string; authTokenEnv?: string; syncInterval?: string },
      ) => {
        if (getProject(name)) throw new Error(`Project already exists: "${name}".`)
        validateProjectName(name)
        const token = operationToken(name, opts)
        const syncInterval = parsePositiveInt(opts.syncInterval, 'sync-interval')
        const file = projectFilePath({
          mode: 'replica',
          file: defaultProjectFile(name),
          createdAt: '',
        })

        // Bootstrap the local replica from the primary FIRST, so a failed connection
        // leaves nothing half-registered. Only persist after a successful sync.
        mkdirSync(dirname(file), { recursive: true })
        await withFileLock(`${file}.bootstrap.lock`, () =>
          reachRemote(opts.url, async () => {
            const store = openStore({
              mode: 'replica',
              file,
              syncUrl: opts.url,
              authToken: token,
              syncInterval,
            })
            try {
              await store.sync()
            } finally {
              await store.close()
            }
          }),
        )

        if (opts.authToken) setToken(name, opts.authToken)
        addProject(name, {
          mode: 'replica',
          file: defaultProjectFile(name),
          syncUrl: opts.url,
          syncInterval,
          createdAt: new Date().toISOString(),
        })
        console.log(`Linked project "${name}" ⇄ ${opts.url}. Run \`bctx project use ${name}\`.`)
      },
    )

  // ── sync ──────────────────────────────────────────────────────────────────
  project
    .command('sync [name]')
    .description('Force a replica to pull the latest from its primary (defaults to current).')
    .action(async (name: string | undefined) => {
      const n = name ?? currentProjectName()
      const target = projectToTarget(n, requireProject(n))
      if (target.mode !== 'replica') {
        console.log(`Project "${n}" is ${target.mode}; nothing to sync.`)
        return
      }
      await reachRemote(target.syncUrl, async () => {
        const store = openStore(target)
        try {
          const rep = await store.client.sync()
          console.log(`Synced "${n}": ${rep?.frames_synced ?? 0} frame(s).`)
        } finally {
          await store.close()
        }
      })
    })

  // ── status ────────────────────────────────────────────────────────────────
  project
    .command('status [name]')
    .description('Show a project’s mode, location, and sync settings (defaults to current).')
    .option('--json', 'output JSON')
    .action((name: string | undefined, opts: { json?: boolean }) => {
      const n = name ?? currentProjectName()
      const entry = requireProject(n)
      const status = {
        name: n,
        mode: entry.mode,
        current: n === currentProjectName(),
        location: describeTarget(projectToTarget(n, entry)),
        syncUrl: entry.syncUrl ?? null,
        syncInterval: entry.syncInterval ?? null,
        token: resolveToken(n) ? 'set' : 'none',
      }
      if (opts.json) {
        console.log(JSON.stringify(status, null, 2))
        return
      }
      console.log(`project:   ${status.name}${status.current ? ' (current)' : ''}`)
      console.log(`mode:      ${status.mode}`)
      console.log(`location:  ${status.location}`)
      if (entry.syncUrl) console.log(`syncUrl:   ${entry.syncUrl}`)
      if (entry.syncInterval) console.log(`interval:  ${entry.syncInterval}s`)
      console.log(`token:     ${status.token}`)
    })

  // ── disconnect ──────────────────────────────────────────────────────────────
  project
    .command('disconnect <name>')
    .description(
      'Revert an online project to local (keeps the local file; drops the stored token).',
    )
    .action((name: string) => {
      const entry = requireProject(name)
      if (entry.mode === 'local') {
        console.log(`Project "${name}" is already local.`)
        return
      }
      updateProject(name, { mode: 'local', syncUrl: undefined, syncInterval: undefined })
      setToken(name, null)
      console.log(`Project "${name}" is now local (offline).`)
    })

  return project
}
