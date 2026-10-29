import { spawn } from 'node:child_process'
import { Command } from 'commander'
import { z } from 'zod'
import { AccessDeniedError } from '../core/access/errors'
import type { AccessSession } from '../core/access/session'
import { withDb } from '../core/db'
import { INBOX_GUIDE } from '../core/inbox/errors'
import {
  claudeSettingsPath,
  exportSessionId,
  type HookEvent,
  type HookScope,
  installClaudeHooks,
  isFresh,
  readHookCache,
  writeHookCache,
} from '../core/inbox/hook'
import {
  formatList,
  formatSummary,
  formatThread,
  formatWait,
  UNTRUSTED_NOTICE,
} from '../core/inbox/render'
import {
  actorFromSession,
  DEFAULT_TAIL,
  getInboxSettings,
  getThread,
  INBOX_ACTIONS,
  INBOX_BOXES,
  type InboxAction,
  type InboxActor,
  type InboxStore,
  inboxSession,
  inboxSummary,
  listMembers,
  listThreads,
  markRead,
  replyThread,
  type StatusFilter,
  sendThread,
  setInboxSettings,
  transitionThread,
} from '../core/inbox/threads'
import { WAIT_EXIT, waitForMessages } from '../core/inbox/wait'
import type { DbOpts } from '../core/paths'
import { currentProjectName } from '../core/registry'
import { INBOX_KINDS, INBOX_STATUSES } from '../core/types'
import { isAgentEnv } from '../lib/agent'
import { resolveBody } from '../lib/stdin'
import { collect, dbOptsFrom, parsePositiveInt } from './_shared'

const STATUS_FILTERS = ['active', 'closed', 'any', ...INBOX_STATUSES] as const

const VISIBILITY_NOTE =
  'Inbox threads are visible to every member of the project (and to anyone holding the database token) — not for secrets.'

/** Run an inbox operation against the shared primary as the authenticated member. */
async function withInbox<T>(
  command: Command,
  fn: (store: InboxStore, actor: InboxActor, session: AccessSession) => Promise<T>,
  extra: Partial<DbOpts> = {},
): Promise<T> {
  return withDb({ ...dbOptsFrom(command), inbox: true, ...extra }, async (db, access, ctx) => {
    const session = inboxSession(access)
    const actor = actorFromSession(session, {
      surface: 'cli',
      session: process.env.BCTX_SESSION?.trim() || null,
      byAgent: isAgentEnv(),
    })
    return fn({ db, client: ctx.client }, actor, session)
  })
}

function print(json: boolean | undefined, value: unknown, text: string): void {
  console.log(json ? JSON.stringify(value, null, 2) : text)
}

/** The registry project this command targets, for hook cache keys. */
function projectOf(command: Command): string | null {
  const o = command.optsWithGlobals()
  if (o.db || process.env.BCTX_DB || o.global || o.local) return null
  return o.project ?? process.env.BCTX_PROJECT ?? currentProjectName()
}

export function inboxCommand(): Command {
  const inbox = new Command('inbox')
    .description(
      'Requests, questions, and tasks between members of a shared project (needs access control).',
    )
    .addHelpText(
      'after',
      `\nFull guide (kinds, live conversations, safety rules, hooks): ${INBOX_GUIDE}`,
    )

  inbox
    .command('ls', { isDefault: true })
    .description(
      'List inbox threads (default: yours — assigned to you, sent by you, the team pool).',
    )
    .option('--box <box>', `which threads: ${INBOX_BOXES.join(' | ')}`, 'mine')
    .option('--sent', 'shorthand for --box sent')
    .option('--all', 'shorthand for --box all (the whole project board)')
    .option('--team', 'shorthand for --box team (the unclaimed pool)')
    .option('--status <s>', `${STATUS_FILTERS.join(' | ')} (active = open or unread)`, 'active')
    .option('--kind <k>', INBOX_KINDS.join(' | '))
    .option('--from <handle>', 'only threads sent by this member')
    .option('--limit <n>', 'max threads (default 50)')
    .option('--json', 'output JSON')
    .action(async (opts, command: Command) => {
      const box = opts.sent ? 'sent' : opts.all ? 'all' : opts.team ? 'team' : opts.box
      const list = await withInbox(command, (store, actor) =>
        listThreads(store, actor, {
          box: z.enum(INBOX_BOXES as [string, ...string[]]).parse(box) as never,
          status: z.enum(STATUS_FILTERS).parse(opts.status) as StatusFilter,
          kind: opts.kind ? z.enum(INBOX_KINDS).parse(opts.kind) : undefined,
          from: opts.from,
          limit: parsePositiveInt(opts.limit, 'limit'),
        }),
      )
      print(opts.json, list, formatList(list, 'Inbox is empty.'))
    })

  inbox
    .command('send')
    .description(
      'Send a question, task, or heads-up to a member (@handle) or the team pool (@team).',
    )
    .argument('<to>', '@handle, or @team for the pool (first to claim takes it)')
    .argument('[body...]', 'message (or use --file / stdin)')
    .option('--title <t>', 'one-line title (default: first line of the body)')
    .option(
      '--kind <k>',
      `${INBOX_KINDS.join(' | ')} (ask = question, fyi = no action needed)`,
      'task',
    )
    .option('--urgent', 'flag as urgent')
    .option('--ref <id>', 'link a wiki page, context, or file by id (repeatable)', collect, [])
    .option('--file <path>', 'read the body from a file (- for stdin)')
    .option('--json', 'output JSON')
    .addHelpText('after', `\n${VISIBILITY_NOTE}`)
    .action(async (to: string, bodyArgs: string[], opts, command: Command) => {
      const body = await resolveBody(opts.file, bodyArgs)
      const view = await withInbox(command, (store, actor) =>
        sendThread(store, actor, {
          to,
          body,
          title: opts.title,
          kind: z.enum(INBOX_KINDS).parse(opts.kind),
          urgent: !!opts.urgent,
          refs: opts.ref,
        }),
      )
      const to_ = view.assignee ? `@${view.assignee.handle}` : '@team'
      print(
        opts.json,
        view,
        `Sent #${view.num} ${view.kind} → ${to_} (${view.status}).\nwait for a reply: bctx inbox wait --thread ${view.num} --since ${view.lastSeq}`,
      )
    })

  inbox
    .command('show')
    .description('Show a thread and its messages (marks it read).')
    .argument('<ref>', 'thread number (42 or #42) or id')
    .option('--since <seq>', 'only messages after this seq')
    .option(
      '--tail <n>',
      `only the newest n messages (default ${DEFAULT_TAIL}; 0 = the whole thread)`,
    )
    .option('--no-mark-read', 'leave it unread')
    .option('--json', 'output JSON')
    .action(async (ref: string, opts, command: Command) => {
      const tail = opts.tail !== undefined ? Number(opts.tail) : DEFAULT_TAIL
      if (!Number.isInteger(tail) || tail < 0) throw new Error(`Invalid --tail: "${opts.tail}".`)
      const view = await withInbox(command, (store, actor) =>
        getThread(store, actor, ref, {
          since: opts.since ? Number(opts.since) : undefined,
          markRead: opts.markRead !== false,
          tail,
        }),
      )
      print(opts.json, { notice: UNTRUSTED_NOTICE, ...view }, formatThread(view))
    })

  inbox
    .command('reply')
    .description('Reply in a thread.')
    .argument('<ref>', 'thread number or id')
    .argument('[body...]', 'message (or use --file / stdin)')
    .option('--file <path>', 'read the body from a file (- for stdin)')
    .option('--resolve', 'then resolve the thread (e.g. this reply answers the question)')
    .option('--claim', 'then claim the thread (you are taking it on)')
    .option(
      '--continue',
      'reset the agent-to-agent turn limit — only when your user explicitly said to keep going',
    )
    .option('--json', 'output JSON')
    .action(async (ref: string, bodyArgs: string[], opts, command: Command) => {
      const body = await resolveBody(opts.file, bodyArgs)
      const view = await withInbox(command, (store, actor) =>
        replyThread(store, actor, ref, body, {
          after: opts.resolve ? 'resolve' : opts.claim ? 'claim' : undefined,
          continue: !!opts.continue,
        }),
      )
      const closed = !['open', 'in_progress'].includes(view.status)
      print(
        opts.json,
        view,
        closed
          ? `Replied in #${view.num} — now ${view.status}. Conversation closed.`
          : `Replied in #${view.num} (${view.status.replace('_', ' ')}).\nwait for the answer: bctx inbox wait --thread ${view.num} --since ${view.lastSeq}`,
      )
    })

  const describe: Record<InboxAction, string> = {
    claim: 'Take a thread on (assigned to you, or from the team pool) — marks it in progress.',
    unclaim: 'Put a thread you claimed back to open.',
    resolve: 'Mark a thread solved (a question needs an answer: --note or an earlier reply).',
    decline: 'Decline a thread assigned to you (--note says why).',
    reopen: 'Reopen a resolved, declined, or cancelled thread.',
    cancel: 'Cancel a thread you sent.',
    reassign: 'Hand a thread to another member, or back to the pool with @team.',
  }
  for (const action of INBOX_ACTIONS) {
    const cmd = inbox
      .command(action)
      .description(describe[action])
      .argument('<ref>', 'thread number or id')
    if (action === 'reassign') cmd.argument('<to>', '@handle or @team')
    cmd.option('--note <text>', 'a note recorded on the thread (resolution, reason, answer)')
    if (action === 'claim' || action === 'unclaim') {
      cmd.option('--force', 'take over from another of your own sessions')
    }
    cmd.option('--json', 'output JSON')
    cmd.action(async (ref: string, ...rest: unknown[]) => {
      const command = rest[rest.length - 1] as Command
      const opts = command.opts()
      const to = action === 'reassign' ? (rest[0] as string) : undefined
      const view = await withInbox(command, (store, actor) =>
        transitionThread(store, actor, ref, action, { note: opts.note, to, force: !!opts.force }),
      )
      const assignee = view.assignee ? `@${view.assignee.handle}` : '@team'
      print(opts.json, view, `#${view.num} is now ${view.status.replace('_', ' ')} (${assignee}).`)
    })
  }

  inbox
    .command('read')
    .description('Mark a thread (or --all) as read.')
    .argument('[ref]', 'thread number or id')
    .option('--all', 'every unread thread')
    .action(async (ref: string | undefined, opts, command: Command) => {
      if (!ref && !opts.all) throw new Error('Pass a thread number, or --all.')
      const n = await withInbox(command, (store, actor) =>
        markRead(store, actor, opts.all ? 'all' : (ref as string)),
      )
      console.log(`Marked ${n} thread${n === 1 ? '' : 's'} read.`)
    })

  inbox
    .command('wait')
    .description(
      'Block until a new message for you arrives (run it in the background). Prints metadata only — read bodies with `show`. Exit 0 = messages, 2 = timeout, 3 = thread closed.',
    )
    .option('--thread <ref>', 'only this thread (a live conversation)')
    .option('--since <seq>', 'resume after this seq (default: now)')
    .option('--timeout <seconds>', 'give up after this long (default 300)')
    .option('--json', 'output JSON')
    .action(async (opts, command: Command) => {
      const result = await withInbox(command, (store, actor) =>
        waitForMessages(store, actor, {
          thread: opts.thread,
          since: opts.since !== undefined ? Number(opts.since) : undefined,
          timeoutMs: (parsePositiveInt(opts.timeout, 'timeout') ?? 300) * 1000,
        }),
      )
      print(opts.json, result, formatWait(result))
      process.exitCode = WAIT_EXIT[result.outcome]
    })

  inbox
    .command('members')
    .description('Who you can address: active members (handle and display name).')
    .option('--json', 'output JSON')
    .action(async (opts, command: Command) => {
      const members = await withInbox(command, (store) => listMembers(store.db))
      print(
        opts.json,
        members,
        members.length
          ? [
              ...members.map((m) => `@${m.handle}${m.displayName ? `  ${m.displayName}` : ''}`),
              '@team  (the pool — first to claim takes it)',
            ].join('\n')
          : 'No members.',
      )
    })

  inbox
    .command('settings')
    .description('Show (or, with config.write, change) the inbox limits.')
    .option('--rate-limit <n>', 'max inbox writes per member per 10 minutes')
    .option(
      '--agent-turns <n>',
      'max consecutive agent messages in a thread before a human must reply',
    )
    .option('--json', 'output JSON')
    .action(async (opts, command: Command) => {
      const settings = await withInbox(command, async (store, _actor, session) => {
        const patch = {
          rateLimit: opts.rateLimit !== undefined ? Number(opts.rateLimit) : undefined,
          agentTurns: opts.agentTurns !== undefined ? Number(opts.agentTurns) : undefined,
        }
        if (patch.rateLimit === undefined && patch.agentTurns === undefined) {
          return getInboxSettings(store.db)
        }
        if (!session.can('config.write')) {
          const { handle, role } = session.principal
          throw new AccessDeniedError(
            `Permission denied: "${handle}" (${role}) lacks the \`config.write\` capability.`,
            { capability: 'config.write' },
          )
        }
        return setInboxSettings(store.db, patch)
      })
      print(
        opts.json,
        settings,
        `rate limit:  ${settings.rateLimit} writes / member / 10 min\nagent turns: ${settings.agentTurns} consecutive agent messages per thread`,
      )
    })

  inbox
    .command('hook')
    .description(
      'For agent hooks: print a metadata-only inbox summary (never fails or blocks). `bctx inbox hook install --claude` adds it to Claude Code.',
    )
    .argument('[action]', '"install" to add the hooks to Claude Code settings')
    .option('--event <event>', 'session-start | prompt', 'prompt')
    .option('--claude', 'install: target Claude Code')
    .option(
      '--scope <scope>',
      'install: project (./.claude/settings.json) | user (~/.claude)',
      'project',
    )
    .option('--dry-run', 'install: show what would change')
    .option('--refresh', 'internal: refresh the cache from the primary')
    .action(async (action: string | undefined, opts, command: Command) => {
      if (action === 'install') {
        if (!opts.claude) throw new Error('Only Claude Code is supported for now: pass --claude.')
        const scope = z.enum(['project', 'user']).parse(opts.scope) as HookScope
        const file = claudeSettingsPath(scope)
        const project = command.optsWithGlobals().project as string | undefined
        const { added } = installClaudeHooks(file, { project, dryRun: !!opts.dryRun })
        if (!added.length) {
          console.log(`Inbox hooks already present in ${file}.`)
          return
        }
        console.log(`${opts.dryRun ? 'Would add' : 'Added'} to ${file}:`)
        for (const a of added) console.log(`  ${a}`)
        if (!opts.dryRun) {
          console.log(
            'New Claude Code sessions will now see a one-line inbox summary (counts only) at start and when new items arrive.',
          )
        }
        return
      }
      if (action) throw new Error(`Unknown hook action "${action}" (expected: install).`)
      await runHook(command, opts.refresh ? 'refresh' : (opts.event as HookEvent))
    })

  return inbox
}

/** Refresh the hook cache from the primary. Throws on any failure (callers swallow). */
async function refreshCache(command: Command): Promise<void> {
  const project = projectOf(command)
  const previous = readHookCache(project)
  const summary = await withInbox(
    command,
    async (store, actor) => ({ handle: actor.handle, summary: await inboxSummary(store, actor) }),
    { requires: 'inbox.read', action: 'inbox hook' },
  )
  writeHookCache(project, {
    at: new Date().toISOString(),
    project,
    handle: summary.handle,
    summary: summary.summary,
    notifiedSeq: previous?.notifiedSeq ?? 0,
  })
}

/**
 * The hook itself. Never throws, never prints errors, always exits 0: a broken
 * network or a project without an inbox must not get in the way of a prompt.
 */
async function runHook(command: Command, event: HookEvent | 'refresh'): Promise<void> {
  try {
    if (event === 'refresh') {
      await refreshCache(command).catch(() => undefined)
      return
    }
    const project = projectOf(command)
    if (event === 'session-start') exportSessionId(process.env.CLAUDE_ENV_FILE)
    let cache = readHookCache(project)
    if (!isFresh(cache)) {
      if (event === 'session-start') {
        // One synchronous attempt, bounded: the first answer of a session is worth ~2s.
        await Promise.race([
          refreshCache(command).catch(() => undefined),
          new Promise((r) => setTimeout(r, 2500)),
        ])
        cache = readHookCache(project)
      } else {
        const globals = project ? ['--project', project] : []
        spawn(process.execPath, [process.argv[1] ?? '', ...globals, 'inbox', 'hook', '--refresh'], {
          detached: true,
          stdio: 'ignore',
        }).unref()
      }
    }
    if (!cache) return
    const s = cache.summary
    if (event === 'session-start') {
      if (s.unread || s.assigned || s.team)
        console.log(formatSummary(s, { handle: cache.handle, project }))
      writeHookCache(project, { ...cache, notifiedSeq: Math.max(cache.notifiedSeq, s.maxSeq) })
      return
    }
    if (s.unread && s.maxSeq > cache.notifiedSeq) {
      console.log(formatSummary(s, { handle: cache.handle, project }))
      writeHookCache(project, { ...cache, notifiedSeq: s.maxSeq })
    }
  } catch {
    // silent by contract
  } finally {
    process.exit(0)
  }
}
