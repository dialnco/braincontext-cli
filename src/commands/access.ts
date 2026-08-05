import { userInfo } from 'node:os'
import { Command } from 'commander'
import type { Kysely } from 'kysely'
import { listAccessLog } from '../core/access/audit'
import {
  type CapabilityOverrides,
  formatCapabilities,
  isRole,
  parseCapabilitySpec,
} from '../core/access/capabilities'
import { AccessError } from '../core/access/errors'
import { encodeJoinCode, type JoinPayload, joinCodeWarning } from '../core/access/joincode'
import {
  createPrincipal,
  deletePrincipal,
  getPrincipalByHandle,
  issueKey,
  listKeys,
  listPrincipals,
  type Principal,
  revokeKey,
  updatePrincipal,
} from '../core/access/principals'
import { describeFailure, type SessionResult } from '../core/access/session'
import { isAccessEnabled, setAccessEnabled, setAccessMode } from '../core/access/settings'
import { accessStatus } from '../core/access/status'
import { withDb } from '../core/db'
import { resolveTarget } from '../core/paths'
import { getProject, resolveToken, setAccessKey } from '../core/registry'
import type { Database, Role } from '../core/types'
import { dbOptsFrom, parsePositiveInt } from './_shared'

/** The registry project this command is operating on, or null for a raw `--db` file. */
function projectNameFor(command: Command): string | null {
  return resolveTarget(dbOptsFrom(command)).project ?? null
}

/** A sensible default handle for the bootstrap owner: the OS username. */
function defaultHandle(): string {
  try {
    const name = userInfo().username?.replace(/[^a-zA-Z0-9._-]/g, '-')
    return name && /^[a-z0-9]/i.test(name) ? name : 'owner'
  } catch {
    return 'owner'
  }
}

/**
 * Persist a freshly issued key for the local machine and say where it went. Keys
 * for a raw `--db` target have no registry entry to live in, so the caller is told
 * to export `BCTX_KEY` instead.
 */
function storeOwnKey(project: string | null, key: string): void {
  if (project) {
    setAccessKey(project, key)
    console.log(`Saved to ~/.braincontext/credentials.json for project "${project}".`)
  } else {
    console.log('No registry project for this store — export it to use it:')
    console.log(`  export BCTX_KEY=${key}`)
  }
}

/** Build the one-paste join code for a member of `project`, with its disclosure. */
function joinCodeFor(
  project: string | null,
  handle: string,
  key: string,
): { code: string; warning: string } | null {
  if (!project) return null
  const entry = getProject(project)
  if (!entry) return null
  const payload: JoinPayload = {
    v: 1,
    n: project,
    u: entry.syncUrl,
    t: entry.syncUrl ? resolveToken(project) : undefined,
    k: key,
    h: handle,
  }
  return { code: encodeJoinCode(payload), warning: joinCodeWarning(payload) }
}

function printIssuedKey(opts: {
  handle: string
  key: string
  project: string | null
  joinCode: boolean
}): void {
  console.log('')
  if (opts.joinCode) {
    const join = joinCodeFor(opts.project, opts.handle, opts.key)
    if (join) {
      console.log(`Join code for "${opts.handle}" — send this one line:`)
      console.log('')
      console.log(`  ${join.code}`)
      console.log('')
      console.log('They run:  bctx project join <code>')
      console.log('')
      console.log(join.warning)
      console.log('')
      console.log(`Raw key (if they prefer BCTX_KEY): ${opts.key}`)
      return
    }
    console.log('(This store has no registry project, so there is no join code to hand out.)')
  }
  console.log(`Access key for "${opts.handle}" — shown once, store it now:`)
  console.log('')
  console.log(`  ${opts.key}`)
}

function parseOverrideOpt(spec: string | undefined): CapabilityOverrides | undefined {
  return spec ? parseCapabilitySpec(spec) : undefined
}

function requireRole(value: string): Role {
  if (!isRole(value)) {
    throw new AccessError(
      `Invalid role: "${value}" (owner, admin, writer, reader).`,
      'invalid_role',
    )
  }
  return value
}

function formatPrincipalLine(p: Principal): string {
  const flags = p.status === 'active' ? '' : ' [disabled]'
  const overrides = Object.entries(p.overrides)
    .map(([c, v]) => `${v ? '+' : '-'}${c}`)
    .join(',')
  return `${p.handle.padEnd(20)} ${p.role.padEnd(7)}${flags}${overrides ? `  (${overrides})` : ''}`
}

/** The session behind the current command, or null when unauthenticated/disabled. */
function actorOf(access: SessionResult): Principal | null {
  return access.enabled && access.ok ? access.session.principal : null
}

export function accessCommand(): Command {
  const access = new Command('access').description(
    'Users, keys, and the access log for a shared project.\n' +
      'Enforcement is advisory: it binds every bctx surface (CLI, Studio, MCP), but\n' +
      'anyone holding the raw libSQL token can still reach the database directly.',
  )

  // ── init ──────────────────────────────────────────────────────────────────
  access
    .command('init')
    .description('Become the owner of this project and switch access control on.')
    .option('--handle <name>', 'your handle (default: your OS username)')
    .option('--display-name <name>', 'human-readable name')
    .action(async (opts: { handle?: string; displayName?: string }, command: Command) => {
      const project = projectNameFor(command)
      const result = await withDb(dbOptsFrom(command), async (db) => {
        if (await isAccessEnabled(db)) {
          throw new AccessError(
            'Access control is already enabled here. Use `bctx access user add <handle>` to invite someone.',
            'already_enabled',
          )
        }
        const owner = await createPrincipal(db, {
          handle: opts.handle ?? defaultHandle(),
          role: 'owner',
          displayName: opts.displayName ?? null,
        })
        const issued = await issueKey(db, owner.handle, { label: 'owner', createdBy: owner.id })
        // Enable LAST: until this flips, the store is unguarded, so a failure above
        // leaves a project that still works rather than one nobody can open.
        await setAccessMode(db, 'advisory')
        await setAccessEnabled(db, true)
        return { owner, key: issued.key }
      })

      console.log(`Access control enabled. You are "${result.owner.handle}" (owner).`)
      printIssuedKey({ handle: result.owner.handle, key: result.key, project, joinCode: false })
      console.log('')
      storeOwnKey(project, result.key)
      console.log('')
      console.log('Next:  bctx access user add <handle> --role writer')
    })

  // ── status ────────────────────────────────────────────────────────────────
  access
    .command('status')
    .description('Show whether access control is on, and who you are on this project.')
    .option('--json', 'output JSON')
    .action(async (opts: { json?: boolean }, command: Command) => {
      const status = await withDb(dbOptsFrom(command), async (db, session) =>
        accessStatus(db, session.enabled && session.ok ? session.session : null),
      )
      if (opts.json) {
        console.log(JSON.stringify(status, null, 2))
        return
      }
      if (!status.enabled) {
        console.log('Access control: off (every client with the store can do anything).')
        console.log('Enable it with `bctx access init`.')
        return
      }
      console.log(`Access control: on (${status.mode})`)
      console.log(`Users: ${status.userCount}   Active keys: ${status.activeKeyCount}`)
      if (status.me) {
        console.log(`You: ${status.me.handle} (${status.me.role})`)
        console.log(`Capabilities: ${status.me.capabilities.join(', ')}`)
      } else {
        console.log('You: not authenticated on this project.')
      }
    })

  // ── disable ───────────────────────────────────────────────────────────────
  access
    .command('disable')
    .description('Turn access control off. Users and keys are kept, just not enforced.')
    .action(async (_opts, command: Command) => {
      await withDb(dbOptsFrom(command), async (db, session) => {
        const actor = actorOf(session)
        if (actor && actor.role !== 'owner') {
          throw new AccessError('Only an owner can disable access control.', 'owner_required')
        }
        if (!(await isAccessEnabled(db))) {
          console.log('Access control is already off.')
          return
        }
        await setAccessEnabled(db, false)
        console.log('Access control disabled. Anyone who can open this store can do anything.')
        console.log('Users and keys are preserved — `bctx access init` is not needed to re-enable.')
      })
    })

  // ── recover ───────────────────────────────────────────────────────────────
  access
    .command('recover')
    .description('Regain owner access to a store file you can open on disk (requires --db <file>).')
    .option('--handle <name>', 'handle to restore or create as owner (default: your OS username)')
    .action(async (opts: { handle?: string }, command: Command) => {
      const dbOpts = dbOptsFrom(command)
      // Filesystem ownership is the real boundary in the advisory model: if you can
      // open the file, you can already rewrite these tables with sqlite3. Restricting
      // recovery to a local path is what stops it from being a remote backdoor.
      if (!dbOpts.db) {
        throw new AccessError(
          'Recovery needs a local store file: `bctx access recover --db ~/.braincontext/projects/<name>.db`.',
          'db_path_required',
        )
      }
      const target = resolveTarget(dbOpts)
      if (target.mode !== 'local') {
        throw new AccessError(
          'Recovery only works against a local file, not a remote.',
          'local_only',
        )
      }

      const handle = opts.handle ?? defaultHandle()
      const result = await withDb(dbOpts, async (db) => {
        const existing = await getPrincipalByHandle(db, handle)
        const owner = existing
          ? await updatePrincipal(db, handle, { role: 'owner', status: 'active' })
          : await createPrincipal(db, { handle, role: 'owner' })
        const issued = await issueKey(db, owner.handle, { label: 'recovery', createdBy: owner.id })
        return { owner, key: issued.key, restored: Boolean(existing) }
      })

      console.log(
        `${result.restored ? 'Restored' : 'Created'} owner "${result.owner.handle}" on ${target.file}.`,
      )
      printIssuedKey({
        handle: result.owner.handle,
        key: result.key,
        project: null,
        joinCode: false,
      })
    })

  access.addCommand(userCommand())
  access.addCommand(keyCommand())

  // ── log ───────────────────────────────────────────────────────────────────
  access
    .command('log')
    .description('Show recent access decisions (newest first).')
    .option('--limit <n>', 'how many entries (default 50)')
    .option('--user <handle>', 'only this user')
    .option('--deny-only', 'only refused attempts')
    .option('--json', 'output JSON')
    .action(
      async (
        opts: { limit?: string; user?: string; denyOnly?: boolean; json?: boolean },
        command: Command,
      ) => {
        const rows = await withDb(dbOptsFrom(command), (db) =>
          listAccessLog(db, {
            limit: parsePositiveInt(opts.limit, 'limit') ?? 50,
            handle: opts.user,
            denyOnly: opts.denyOnly,
          }),
        )
        if (opts.json) {
          console.log(JSON.stringify(rows, null, 2))
          return
        }
        if (rows.length === 0) {
          console.log('No access log entries.')
          return
        }
        for (const r of rows) {
          const who = r.handle ?? '(unauthenticated)'
          const mark = r.decision === 'deny' ? 'DENY ' : 'allow'
          console.log(`${r.at}  ${mark}  ${who.padEnd(18)} ${r.surface.padEnd(6)} ${r.action}`)
        }
      },
    )

  return access
}

function userCommand(): Command {
  const user = new Command('user').description('Create and manage the people on this project.')

  user
    .command('add <handle>')
    .description('Create a user, issue their first key, and print a join code.')
    .requiredOption('--role <role>', 'owner | admin | writer | reader')
    .option('--display-name <name>', 'human-readable name')
    .option('--cap <spec>', 'capability overrides, e.g. "+delete,-files.write"')
    .option('--expires <iso>', 'expiry for the issued key (ISO 8601)')
    .option('--no-join-code', 'print only the raw key')
    .action(
      async (
        handle: string,
        opts: {
          role: string
          displayName?: string
          cap?: string
          expires?: string
          joinCode: boolean
        },
        command: Command,
      ) => {
        const project = projectNameFor(command)
        const result = await withDb(dbOptsFrom(command), async (db, session) => {
          const actor = actorOf(session)
          const role = requireRole(opts.role)
          if (actor && actor.role !== 'owner' && (role === 'owner' || role === 'admin')) {
            throw new AccessError(`Only an owner can create an ${role}.`, 'owner_required')
          }
          const principal = await createPrincipal(db, {
            handle,
            role,
            displayName: opts.displayName ?? null,
            overrides: parseOverrideOpt(opts.cap),
            createdBy: actor?.id ?? null,
          })
          const issued = await issueKey(db, principal.handle, {
            expiresAt: opts.expires ?? null,
            createdBy: actor?.id ?? null,
          })
          return { principal, key: issued.key }
        })

        console.log(`Created "${result.principal.handle}" (${result.principal.role}).`)
        console.log(`Capabilities: ${result.principal.capabilities.join(', ')}`)
        printIssuedKey({
          handle: result.principal.handle,
          key: result.key,
          project,
          joinCode: opts.joinCode,
        })
      },
    )

  user
    .command('ls')
    .description('List the users on this project.')
    .option('--json', 'output JSON')
    .action(async (opts: { json?: boolean }, command: Command) => {
      const people = await withDb(dbOptsFrom(command), (db) => listPrincipals(db))
      if (opts.json) {
        console.log(JSON.stringify(people, null, 2))
        return
      }
      if (people.length === 0) {
        console.log('No users yet. Run `bctx access init`.')
        return
      }
      for (const p of people) console.log(formatPrincipalLine(p))
    })

  user
    .command('show <handle>')
    .description('Show one user, their capabilities, and their keys.')
    .option('--json', 'output JSON')
    .action(async (handle: string, opts: { json?: boolean }, command: Command) => {
      const data = await withDb(dbOptsFrom(command), async (db) => {
        const principal = await requireUser(db, handle)
        return { principal, keys: await listKeys(db, principal.id) }
      })
      if (opts.json) {
        console.log(JSON.stringify(data, null, 2))
        return
      }
      const p = data.principal
      console.log(`${p.handle}${p.displayName ? ` (${p.displayName})` : ''}`)
      console.log(`Role:         ${p.role}`)
      console.log(`Status:       ${p.status}`)
      console.log(`Capabilities: ${formatCapabilities(new Set(p.capabilities))}`)
      console.log(`Created:      ${p.createdAt}`)
      console.log(`Keys:         ${data.keys.length}`)
      for (const k of data.keys) {
        const state = k.revokedAt ? 'revoked' : k.active ? 'active' : 'expired'
        const used = k.lastUsedAt ? `last used ${k.lastUsedAt}` : 'never used'
        console.log(
          `  ${k.id}  ${k.prefix}…  ${state.padEnd(7)} ${used}${k.label ? `  [${k.label}]` : ''}`,
        )
      }
    })

  user
    .command('update <handle>')
    .description("Change a user's role, capabilities, or status.")
    .option('--role <role>', 'owner | admin | writer | reader')
    .option('--display-name <name>', 'human-readable name')
    .option('--cap <spec>', 'replace capability overrides, e.g. "+delete,-files.write"')
    .option('--enable', 'reactivate a disabled user')
    .option('--disable', 'block the user without deleting them or their history')
    .action(
      async (
        handle: string,
        opts: {
          role?: string
          displayName?: string
          cap?: string
          enable?: boolean
          disable?: boolean
        },
        command: Command,
      ) => {
        if (opts.enable && opts.disable) throw new Error('Pass --enable or --disable, not both.')
        const updated = await withDb(dbOptsFrom(command), async (db, session) =>
          updatePrincipal(
            db,
            handle,
            {
              role: opts.role ? requireRole(opts.role) : undefined,
              displayName: opts.displayName,
              overrides: parseOverrideOpt(opts.cap),
              status: opts.disable ? 'disabled' : opts.enable ? 'active' : undefined,
            },
            actorOf(session),
          ),
        )
        console.log(`Updated ${formatPrincipalLine(updated)}`)
      },
    )

  user
    .command('rm <handle>')
    .description('Delete a user and all their keys. Their entries in the access log are kept.')
    .action(async (handle: string, _opts, command: Command) => {
      const removed = await withDb(dbOptsFrom(command), async (db, session) =>
        deletePrincipal(db, handle, actorOf(session)),
      )
      console.log(`Removed "${removed.handle}" (${removed.role}) and their keys.`)
    })

  return user
}

function keyCommand(): Command {
  const key = new Command('key').description('Issue, list, and revoke access keys.')

  key
    .command('issue <handle>')
    .description('Issue an additional key for a user (rotation, or a second device).')
    .option('--label <name>', 'what this key is for, e.g. "laptop"')
    .option('--expires <iso>', 'expiry (ISO 8601)')
    .option('--join-code', 'print a full join code instead of the raw key')
    .action(
      async (
        handle: string,
        opts: { label?: string; expires?: string; joinCode?: boolean },
        command: Command,
      ) => {
        const project = projectNameFor(command)
        const issued = await withDb(dbOptsFrom(command), async (db, session) => {
          const principal = await requireUser(db, handle)
          return issueKey(db, principal.handle, {
            label: opts.label ?? null,
            expiresAt: opts.expires ?? null,
            createdBy: actorOf(session)?.id ?? null,
          })
        })
        printIssuedKey({ handle, key: issued.key, project, joinCode: Boolean(opts.joinCode) })
      },
    )

  key
    .command('ls [handle]')
    .description('List keys (all users, or just one).')
    .option('--json', 'output JSON')
    .action(async (handle: string | undefined, opts: { json?: boolean }, command: Command) => {
      const rows = await withDb(dbOptsFrom(command), async (db) => {
        const principal = handle ? await requireUser(db, handle) : null
        const keys = await listKeys(db, principal?.id)
        const people = await listPrincipals(db)
        const byId = new Map(people.map((p) => [p.id, p.handle]))
        return keys.map((k) => ({ ...k, handle: byId.get(k.principalId) ?? '(deleted)' }))
      })
      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2))
        return
      }
      if (rows.length === 0) {
        console.log('No keys.')
        return
      }
      for (const k of rows) {
        const state = k.revokedAt ? 'revoked' : k.active ? 'active' : 'expired'
        console.log(
          `${k.id}  ${k.handle.padEnd(18)} ${k.prefix}…  ${state.padEnd(7)} ${k.label ?? ''}`,
        )
      }
    })

  key
    .command('revoke <keyId>')
    .description('Revoke a key immediately (takes effect on each client at its next sync).')
    .action(async (keyId: string, _opts, command: Command) => {
      const revoked = await withDb(dbOptsFrom(command), (db) => revokeKey(db, keyId))
      console.log(`Revoked key ${revoked.id} (${revoked.prefix}…).`)
    })

  return key
}

async function requireUser(db: Kysely<Database>, handle: string): Promise<Principal> {
  const p = await getPrincipalByHandle(db, handle)
  if (!p) throw new AccessError(`No such user: "${handle}".`, 'no_such_principal')
  return p
}

/**
 * `bctx whoami` — deliberately ungated, because the people who most need it are the
 * ones whose key stopped working. It reports WHY rather than refusing.
 */
export function whoamiCommand(): Command {
  return new Command('whoami')
    .description('Show which identity you are using on this project, and what it can do.')
    .option('--json', 'output JSON')
    .action(async (opts: { json?: boolean }, command: Command) => {
      const info = await withDb(dbOptsFrom(command), async (_db, session) => {
        if (!session.enabled) return { enabled: false as const }
        if (!session.ok)
          return { enabled: true as const, ok: false as const, reason: session.reason }
        const s = session.session
        return {
          enabled: true as const,
          ok: true as const,
          handle: s.principal.handle,
          displayName: s.principal.displayName,
          role: s.principal.role,
          capabilities: s.principal.capabilities,
          readOnly: s.readOnly,
        }
      })
      if (opts.json) {
        console.log(JSON.stringify(info, null, 2))
        return
      }
      if (!info.enabled) {
        console.log('Access control is off on this project — no identity is in use.')
        return
      }
      if (!info.ok) {
        console.log('Not authenticated.')
        console.log(describeFailure(info.reason))
        return
      }
      console.log(
        `${info.handle}${info.displayName ? ` (${info.displayName})` : ''} — ${info.role}`,
      )
      console.log(`Capabilities: ${info.capabilities.join(', ')}`)
      if (info.readOnly) console.log('This identity is read-only.')
    })
}
