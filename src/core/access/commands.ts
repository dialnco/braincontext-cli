import type { Capability } from './capabilities'

/**
 * `null` = not gated. Either the command never opens a store (local registry
 * bookkeeping, disk scaffolding, bundled docs) or it is deliberately reachable
 * without a capability (`whoami`, `access status`, `project join`, and the
 * `access recover` escape hatch, which are how a locked-out member finds out why).
 */
export type CommandCapability = Capability | null

/**
 * Every CLI command's required capability, keyed by its full commander path.
 *
 * This is the single place the CLI's permission surface is described — reading it
 * top to bottom answers "what can a reader actually run?" without opening a
 * handler. `test/command-caps.test.ts` walks the real command tree and fails if an
 * entry is missing or extra, so a new command cannot ship ungated by accident.
 */
export const COMMAND_CAPABILITIES: Record<string, CommandCapability> = {
  // Orientation — open the store, change nothing.
  init: 'read',
  status: 'read',
  whoami: null,

  // Project topology lives in the local registry, not the store.
  'project create': null,
  'project list': null,
  'project use': null,
  'project current': null,
  'project path': null,
  'project rm': null,
  'project status': null,
  'project disconnect': null,
  // `link` and `join` bootstrap a replica: the member cannot hold a capability on
  // a store they have not synced yet, so the key is verified after the sync
  // instead (see commands/project.ts).
  'project link': null,
  'project join': null,
  'project sync': 'read',
  'project migrate-online': 'project.manage',

  // Per-store config (storage credentials).
  'config get': 'config.read',
  'config set': 'config.write',
  'config unset': 'config.write',

  // Files: blobs in the bucket, metadata in the store.
  'file ls': 'files.read',
  'file url': 'files.read',
  'file add': 'files.write',
  'file rm': 'files.write',
  // `test` writes and deletes a probe object in the bucket.
  'file test': 'files.write',

  // Access control itself. `status` is ungated on purpose: a member whose key was
  // revoked must still be able to see that access control is on and who to ask.
  'access status': null,
  'access recover': null,
  'access init': 'project.manage',
  'access disable': 'project.manage',
  'access log': 'users.manage',
  'access user add': 'users.manage',
  'access user ls': 'users.manage',
  'access user show': 'users.manage',
  'access user update': 'users.manage',
  'access user rm': 'users.manage',
  'access key issue': 'users.manage',
  'access key ls': 'users.manage',
  'access key revoke': 'users.manage',

  // Wiki — reads.
  'wiki get': 'read',
  'wiki show': 'read',
  'wiki backlinks': 'read',
  'wiki related': 'read',
  'wiki path': 'read',
  'wiki graph': 'read',
  'wiki search': 'read',
  'wiki log': 'read',
  'wiki lint': 'read',
  'wiki export': 'read',
  'wiki query': 'read',
  'wiki list-properties': 'read',
  'wiki index': 'read',
  'wiki table get': 'read',

  // Wiki — writes.
  'wiki new': 'write',
  'wiki update': 'write',
  'wiki patch-section': 'write',
  'wiki replace': 'write',
  'wiki link': 'write',
  'wiki unlink': 'write',
  'wiki ingest': 'write',
  'wiki import': 'write',
  'wiki set-prop': 'write',
  // Stamps `verifiedAt` and baselines source hashes — a mutation, not a report.
  'wiki verify': 'write',
  // Rebuilds derived state (page_properties, and with --links the graph).
  'wiki reindex': 'write',
  'wiki table set': 'write',
  'wiki table add-row': 'write',
  'wiki table rm-row': 'write',
  'wiki table add-col': 'write',
  'wiki table rm-col': 'write',
  'wiki table rename-col': 'write',
  'wiki datatable new': 'write',
  'wiki datatable extract': 'write',
  'wiki view new': 'write',
  'wiki rm': 'delete',

  // Individual context entries.
  get: 'read',
  list: 'read',
  search: 'read',
  export: 'read',
  add: 'write',
  update: 'write',
  import: 'write',
  rm: 'delete',

  // Skills. The bundled docs ship with the CLI; only `skill` touches the store.
  'skills list': null,
  'skills get': null,
  'skills path': null,
  'skill init': null,
  'skill list': 'read',
  'skill export': 'read',
  'skill add': 'write',

  // Long-running servers. They authenticate once at startup and gate each
  // tool/route themselves — see mcp/server.ts and studio/access.ts.
  mcp: null,
  studio: null,
}

/** Look up a command path. Unknown paths fail closed — see resolveCommandCapability. */
export function commandCapability(path: string): CommandCapability | undefined {
  return Object.hasOwn(COMMAND_CAPABILITIES, path) ? COMMAND_CAPABILITIES[path] : undefined
}

/**
 * The capability for a command path, defaulting to the most privileged one when
 * the path is unmapped.
 *
 * Fail-closed is the only safe default: a command added without a map entry must
 * not silently become world-writable. The exhaustiveness test is what keeps this
 * fallback from ever being hit in practice.
 */
export function resolveCommandCapability(path: string): CommandCapability {
  const known = commandCapability(path)
  return known === undefined ? 'project.manage' : known
}
