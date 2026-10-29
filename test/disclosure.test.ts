import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { Kysely } from 'kysely'
import { describe, expect, it } from 'vitest'
import { createSessionResolver } from '../src/core/access/cache'
import { createPrincipal, issueKey } from '../src/core/access/principals'
import { resolveSession } from '../src/core/access/session'
import { setAccessEnabled } from '../src/core/access/settings'
import { searchContexts } from '../src/core/contexts'
import { formatSummary } from '../src/core/inbox/render'
import {
  actorFromSession,
  inboxSession,
  inboxSummary,
  replyThread,
  sendThread,
} from '../src/core/inbox/threads'
import { waitForMessages } from '../src/core/inbox/wait'
import type { Database } from '../src/core/types'
import { createPage, listPages, pagePeek } from '../src/core/wiki'
import { buildServer } from '../src/mcp/server'
import { getSkill, getSkillRefs, listSkills } from '../src/skills/index'
import { renderIndexMarkdown } from '../src/wiki/export'
import { freshDb, freshStore } from './_db'

async function connect(db: Kysely<Database>): Promise<Client> {
  const server = buildServer(db)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return client
}

function payload(result: any): any {
  return JSON.parse(result.content[0].text)
}

const LONG_BODY = [
  'Intro paragraph about the gateway service and its [[OAuth2]] integration.',
  '## Architecture',
  'arch details. '.repeat(40),
  '## Deployment',
  'deploy details. '.repeat(40),
].join('\n\n')

describe('disclosure ladder (core)', () => {
  it('pagePeek returns outline/excerpt/links/cost without the full body', async () => {
    const db = await freshDb()
    const oauth = await createPage(db, { title: 'OAuth2', pageType: 'concept', body: 'auth' })
    const page = await createPage(db, {
      title: 'Gateway',
      pageType: 'entity',
      body: LONG_BODY,
      tags: ['infra'],
    })
    const peek = await pagePeek(db, page.id)
    expect(peek).not.toBeNull()
    expect(peek!.outline).toEqual(['Architecture', 'Deployment'])
    expect(peek!.excerpt).toContain('[[OAuth2]]')
    expect(peek!.excerpt.length).toBeLessThan(LONG_BODY.length)
    expect(peek!.tokenEstimate).toBeGreaterThan(200)
    expect(peek!.tags).toEqual(['infra'])
    expect(peek!.links.some((l) => l.title === 'OAuth2' && !l.wanted)).toBe(true)
    expect(peek!.freshness.state).toBe('unverified')
    expect(peek).not.toHaveProperty('body')

    const back = await pagePeek(db, oauth.id)
    expect(back!.backlinks.some((l) => l.title === 'Gateway')).toBe(true)
    await db.destroy()
  })

  it('search results carry an FTS snippet with match markers', async () => {
    const db = await freshDb()
    await createPage(db, {
      title: 'Gateway',
      pageType: 'entity',
      body: 'the gateway terminates TLS and forwards to upstream services',
    })
    const hits = await searchContexts(db, 'terminates', { pageScope: 'wiki' })
    expect(hits.length).toBe(1)
    expect(hits[0]!.snippet).toContain('«terminates»')

    // The sanitized-fallback path (invalid FTS syntax) still yields snippets.
    const fallback = await searchContexts(db, 'terminates AND AND', { pageScope: 'wiki' })
    expect(fallback.length).toBe(1)
    expect(fallback[0]!.snippet).toContain('«terminates»')
    await db.destroy()
  })

  it('renderIndexMarkdown annotates every entry and the header with token costs', async () => {
    const db = await freshDb()
    await createPage(db, { title: 'Gateway', pageType: 'entity', body: LONG_BODY })
    await createPage(db, { title: 'OAuth2', pageType: 'concept', body: 'short' })
    const md = renderIndexMarkdown(await listPages(db))
    expect(md).toMatch(/^# Wiki index\n\n2 page\(s\) · ~\d/m)
    expect(md).toMatch(/\[Gateway\]\(gateway\.md\).*\(~\d+(\.\d+k)? tok\)/)
    expect(md).toMatch(/\[OAuth2\]\(oauth2\.md\).*\(~\d+ tok\)/)
    await db.destroy()
  })
})

describe('disclosure ladder (MCP)', () => {
  it('wiki_search returns compact hits — snippet + tokenEstimate, never bodies', async () => {
    const db = await freshDb()
    const client = await connect(db)
    await client.callTool({
      name: 'wiki_new',
      arguments: { title: 'Gateway', type: 'entity', body: LONG_BODY },
    })
    const hits = payload(
      await client.callTool({ name: 'wiki_search', arguments: { query: 'gateway' } }),
    )
    expect(hits.length).toBe(1)
    expect(hits[0]).not.toHaveProperty('body')
    expect(hits[0].tokenEstimate).toBeGreaterThan(0)
    expect(typeof hits[0].snippet).toBe('string')
    expect(hits[0].slug).toBe('gateway')
    await db.destroy()
  })

  it('wiki_get supports detail:"peek" and maxTokens truncation with a marker', async () => {
    const db = await freshDb()
    const client = await connect(db)
    await client.callTool({
      name: 'wiki_new',
      arguments: { title: 'Gateway', type: 'entity', body: LONG_BODY },
    })

    const peek = payload(
      await client.callTool({
        name: 'wiki_get',
        arguments: { ref: 'gateway', detail: 'peek' },
      }),
    )
    expect(peek.outline).toEqual(['Architecture', 'Deployment'])
    expect(peek).not.toHaveProperty('body')

    const full = payload(await client.callTool({ name: 'wiki_get', arguments: { ref: 'gateway' } }))
    expect(full.page.body).toBe(LONG_BODY)
    expect(full.tokenEstimate).toBeGreaterThan(0)
    expect(full.freshness.state).toBe('unverified')

    const truncated = payload(
      await client.callTool({
        name: 'wiki_get',
        arguments: { ref: 'gateway', maxTokens: 60 },
      }),
    )
    expect(truncated.page.body).toContain('[truncated at ~')
    expect(truncated.page.body.length).toBeLessThan(LONG_BODY.length)
    // tokenEstimate still reports the FULL body cost so the agent can budget a re-fetch.
    expect(truncated.tokenEstimate).toBe(full.tokenEstimate)
    await db.destroy()
  })

  it('wiki_verify marks a page verified and refuses sources', async () => {
    const db = await freshDb()
    const client = await connect(db)
    await client.callTool({
      name: 'wiki_new',
      arguments: { title: 'Gateway', type: 'entity', body: 'edge' },
    })
    const verified = payload(
      await client.callTool({
        name: 'wiki_verify',
        arguments: { ref: 'Gateway', agent: 'claude' },
      }),
    )
    expect(verified.freshness.state).toBe('verified')
    expect(verified.freshness.verifiedBy).toBe('claude')

    const ingest = payload(
      await client.callTool({
        name: 'wiki_ingest',
        arguments: { source: 'raw text', title: 'Raw' },
      }),
    )
    const failed = await client.callTool({
      name: 'wiki_verify',
      arguments: { ref: ingest.sourceId },
    })
    expect((failed as { isError?: boolean }).isError).toBe(true)
    await db.destroy()
  })
})

describe('disclosure ladder (inbox)', () => {
  const SECRET = 'body-text-that-must-stay-out-of-cheap-rungs'

  /** Two members, one thread with `replies` extra messages. */
  async function thread(replies: number) {
    const { db, client } = await freshStore()
    const keys: Record<string, string> = {}
    for (const handle of ['diego', 'susana']) {
      await createPrincipal(db, { handle, role: 'writer' })
      keys[handle] = (await issueKey(db, handle)).key
    }
    await setAccessEnabled(db, true)
    const as = async (h: string) =>
      actorFromSession(inboxSession(await resolveSession(db, keys[h])), {
        surface: 'cli',
        byAgent: false,
      })
    const store = { db, client }
    // An explicit title: listings show titles (they default to the body's first line).
    await sendThread(store, await as('diego'), {
      to: '@susana',
      title: 'Short title',
      body: `${SECRET} 0`,
    })
    for (let i = 1; i <= replies; i++) {
      await replyThread(store, await as(i % 2 ? 'susana' : 'diego'), '1', `${SECRET} ${i}`)
    }
    return { db, client, keys, store, as }
  }

  it('rung 0: the skill trigger mentions the inbox, so asking a teammate loads it', () => {
    const skill = listSkills().find((s) => s.name === 'braincontext')
    expect(skill?.description).toMatch(/inbox/i)
    expect(skill?.description).toMatch(/teammate|member/i)
  })

  it('rung 1: counts only — the hook summary carries no titles or bodies, and points at the guide', async () => {
    const { store, as } = await thread(2)
    const summary = await inboxSummary(store, await as('susana'))
    const text = formatSummary(summary, { handle: 'susana' })
    expect(JSON.stringify(summary)).not.toContain(SECRET)
    expect(text).not.toContain(SECRET)
    expect(text).toContain('bctx skills get braincontext --ref inbox')
  })

  it('rung 2: inbox_list and wait return metadata, never bodies', async () => {
    const { db, client, keys, store, as } = await thread(1)
    const session = createSessionResolver(db, keys.susana)
    const server = buildServer(
      db,
      { db, session },
      {
        inbox: { session: 'mcp-t', store: async () => ({ db, client }) },
      },
    )
    const [a, b] = InMemoryTransport.createLinkedPair()
    const mcp = new Client({ name: 'test', version: '0.0.0' })
    await Promise.all([server.connect(b), mcp.connect(a)])
    const listed = await mcp.callTool({ name: 'inbox_list', arguments: {} })
    expect(JSON.stringify(listed)).not.toContain(SECRET)
    const woke = await waitForMessages(store, await as('diego'), {
      since: 0,
      sleep: async () => undefined,
    })
    expect(woke.hits.length).toBeGreaterThan(0)
    expect(JSON.stringify(woke)).not.toContain(SECRET)
  })

  it('rung 3: inbox_get returns the newest 20 with omitted + token costs; tail:0 is everything', async () => {
    const { db, client, keys } = await thread(24) // 25 messages
    const session = createSessionResolver(db, keys.susana)
    const server = buildServer(
      db,
      { db, session },
      {
        inbox: { session: 'mcp-t', store: async () => ({ db, client }) },
      },
    )
    const [a, b] = InMemoryTransport.createLinkedPair()
    const mcp = new Client({ name: 'test', version: '0.0.0' })
    await Promise.all([server.connect(b), mcp.connect(a)])
    const tailed = payload(await mcp.callTool({ name: 'inbox_get', arguments: { ref: '1' } }))
    expect(tailed.messages.length).toBe(20)
    expect(tailed.omitted).toBe(5)
    expect(tailed.messages[0].body).toBe(`${SECRET} 5`) // newest 20, oldest first
    expect(tailed.messages.at(-1).body).toBe(`${SECRET} 24`)
    expect(tailed.tokenEstimate).toBeGreaterThan(0)
    expect(tailed.totalTokenEstimate).toBeGreaterThan(tailed.tokenEstimate)
    const all = payload(await mcp.callTool({ name: 'inbox_get', arguments: { ref: '1', tail: 0 } }))
    expect(all.messages.length).toBe(25)
    expect(all.omitted).toBe(0)
  })

  it('docs: --ref serves one reference, far smaller than --full', () => {
    const one = getSkillRefs('braincontext', ['inbox']) ?? ''
    const full = getSkill('braincontext', true) ?? ''
    expect(one).toContain('# reference: inbox.md')
    expect(one).not.toContain('# reference: access.md')
    expect(one.length * 3).toBeLessThan(full.length)
    expect(getSkillRefs('braincontext', ['inbox.md'])).toBe(one)
    expect(() => getSkillRefs('braincontext', ['nope'])).toThrow(/Available: access, inbox/)
  })
})
