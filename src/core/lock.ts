import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM' // exists but not ours
  }
}

/**
 * Acquire an exclusive cross-process lock via an `O_EXCL` lockfile, run `fn`, then
 * release. Used to serialize operations that the SQLite layer can't (concurrent
 * first-run migration, registry read-modify-write, online bootstrap).
 *
 * A lock is stolen if its holder pid is dead or the file is older than `staleMs`,
 * so a crashed holder can never wedge the system permanently.
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  opts: { timeoutMs?: number; staleMs?: number } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 15000
  const staleMs = opts.staleMs ?? 30000
  mkdirSync(dirname(lockPath), { recursive: true })
  const deadline = Date.now() + timeoutMs

  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx') // O_CREAT | O_EXCL
      try {
        writeSync(fd, String(process.pid))
      } finally {
        closeSync(fd)
      }
      break // acquired
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      // Someone holds it — steal if stale, otherwise wait.
      let stale = false
      try {
        const st = statSync(lockPath)
        if (Date.now() - st.mtimeMs > staleMs) stale = true
        else {
          const pid = Number(readFileSync(lockPath, 'utf8').trim())
          if (pid && !pidAlive(pid)) stale = true
        }
      } catch {
        // file vanished between EEXIST and stat — retry the acquire immediately
        continue
      }
      if (stale) {
        try {
          rmSync(lockPath, { force: true })
        } catch {
          // lost the steal race; fall through to wait
        }
        continue
      }
      if (Date.now() > deadline) throw new Error(`Timed out acquiring lock: ${lockPath}`)
      await sleep(15 + Math.floor(Math.random() * 35))
    }
  }

  try {
    return await fn()
  } finally {
    try {
      rmSync(lockPath, { force: true })
    } catch {
      // best-effort release
    }
  }
}

/** Block the thread for `ms` (no async). Used by the synchronous registry RMW lock. */
function sleepSync(ms: number): void {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Synchronous sibling of {@link withFileLock} for fully-sync critical sections (the registry
 * read-modify-write, which must stay sync so callers aren't forced async). Same O_EXCL +
 * stale-steal protocol; `fn` runs sync under the lock.
 */
export function withFileLockSync<T>(
  lockPath: string,
  fn: () => T,
  opts: { timeoutMs?: number; staleMs?: number } = {},
): T {
  const timeoutMs = opts.timeoutMs ?? 15000
  const staleMs = opts.staleMs ?? 30000
  mkdirSync(dirname(lockPath), { recursive: true })
  const deadline = Date.now() + timeoutMs

  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx')
      try {
        writeSync(fd, String(process.pid))
      } finally {
        closeSync(fd)
      }
      break
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      let stale = false
      try {
        const st = statSync(lockPath)
        if (Date.now() - st.mtimeMs > staleMs) stale = true
        else {
          const pid = Number(readFileSync(lockPath, 'utf8').trim())
          if (pid && !pidAlive(pid)) stale = true
        }
      } catch {
        continue
      }
      if (stale) {
        try {
          rmSync(lockPath, { force: true })
        } catch {
          // lost the steal race; fall through to wait
        }
        continue
      }
      if (Date.now() > deadline) throw new Error(`Timed out acquiring lock: ${lockPath}`)
      sleepSync(15 + Math.floor(Math.random() * 35))
    }
  }

  try {
    return fn()
  } finally {
    try {
      rmSync(lockPath, { force: true })
    } catch {
      // best-effort release
    }
  }
}
