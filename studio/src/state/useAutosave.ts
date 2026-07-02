import { useCallback, useEffect, useRef, useState } from 'react'

export type SaveStatus = 'saved' | 'dirty' | 'saving'

export interface Autosave {
  status: SaveStatus
  /** Mark the buffer dirty with the latest value; schedules a debounced save. */
  schedule: (value: string) => void
  /** Persist immediately if dirty (call on blur / navigate / project switch). */
  flush: () => Promise<void>
  /** Race-free dirty probe (state lags a render; the ref does not). */
  isDirty: () => boolean
}

/**
 * Debounced autosave. Per the product decision, edits are NOT saved per keystroke:
 * `schedule` marks the buffer dirty and (re)arms a ~10s timer; `flush` forces an
 * immediate save and is wired to blur, route changes, project switches, and
 * `beforeunload` so no edit is lost. The latest scheduled value always wins.
 */
export function useAutosave(save: (value: string) => Promise<void>, delayMs = 10_000): Autosave {
  const [status, setStatus] = useState<SaveStatus>('saved')
  const pending = useRef<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inflight = useRef<Promise<void>>(Promise.resolve())
  const saveRef = useRef(save)
  saveRef.current = save

  const doSave = useCallback(async () => {
    if (pending.current === null) return
    const value = pending.current
    pending.current = null
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
    setStatus('saving')
    // Serialize saves: a flush during an in-flight save must not let an older PATCH land
    // after a newer one (out-of-order write → stale body persisted). Chain on the prior save.
    const run = inflight.current.then(() => saveRef.current(value))
    inflight.current = run.catch(() => undefined)
    try {
      await run
      // Only return to 'saved' if nothing new was scheduled while we were saving.
      setStatus(pending.current === null ? 'saved' : 'dirty')
    } catch {
      setStatus('dirty')
    }
  }, [])

  const schedule = useCallback(
    (value: string) => {
      pending.current = value
      setStatus('dirty')
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(doSave, delayMs)
    },
    [doSave, delayMs],
  )

  const flush = useCallback(async () => {
    await doSave()
  }, [doSave])

  const isDirty = useCallback(() => pending.current !== null, [])

  // Flush on tab close / refresh. A fire-and-forget fetch is not awaited by the browser
  // on unload, so ALSO trigger the native "unsaved changes" prompt whenever the buffer is
  // dirty — that turns a silent loss into a user choice (stay → the in-flight save or the
  // 10s timer persists it). Blur + navigate + project-switch flushes handle the common cases.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (pending.current !== null) {
        void doSave()
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [doSave])

  return { status, schedule, flush, isDirty }
}
