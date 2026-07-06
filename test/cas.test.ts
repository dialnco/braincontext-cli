import { describe, expect, it } from 'vitest'
import { createContext, getContext, RevConflictError, updateContext } from '../src/core/contexts'
import { createPage, pagePeek, updatePage } from '../src/core/wiki'
import { freshDb } from './_db'

describe('compare-and-swap (rev)', () => {
  it('exposes a rev that is stable until the content changes', async () => {
    const db = await freshDb()
    const c = await createContext(db, { body: 'hello' })
    const again = await getContext(db, c.id)
    expect(again?.rev).toBe(c.rev) // unchanged read → same rev
    const edited = await updateContext(db, c.id, { body: 'hello world' })
    expect(edited?.rev).not.toBe(c.rev) // body change → new rev
    await db.destroy()
  })

  it('rejects a stale ifRev with the current rev, and accepts a matching one', async () => {
    const db = await freshDb()
    const c = await createContext(db, { body: 'v1' })
    // A concurrent writer moves the row forward.
    await updateContext(db, c.id, { body: 'v2' })

    // Our write still carries the old rev → conflict carrying the live rev.
    let conflict: RevConflictError | null = null
    try {
      await updateContext(db, c.id, { body: 'v3', ifRev: c.rev })
    } catch (e) {
      conflict = e instanceof RevConflictError ? e : null
    }
    expect(conflict).toBeInstanceOf(RevConflictError)
    const live = await getContext(db, c.id)
    expect(conflict?.currentRev).toBe(live?.rev)
    expect(live?.body).toBe('v2') // the rejected write did not apply

    // Re-read, then write with the fresh rev → succeeds.
    const ok = await updateContext(db, c.id, { body: 'v3', ifRev: live?.rev })
    expect(ok?.body).toBe('v3')
    await db.destroy()
  })

  it('threads ifRev through wiki updatePage and surfaces rev on peek', async () => {
    const db = await freshDb()
    const page = await createPage(db, { title: 'Gateway', pageType: 'concept', body: 'a' })
    const peek = await pagePeek(db, page.id)
    expect(peek?.rev).toBe(page.rev)

    await updatePage(db, page.id, { body: 'b' }) // someone else edits
    await expect(updatePage(db, page.id, { body: 'c', ifRev: page.rev })).rejects.toBeInstanceOf(
      RevConflictError,
    )
    await db.destroy()
  })
})
