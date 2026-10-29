import { ROLES, type Role } from '../types'

/**
 * The permission vocabulary. Every gated surface (CLI command, Studio route, MCP
 * tool) maps to exactly one of these, so "what can this user do" is answerable
 * without reading any handler.
 */
export const CAPABILITIES = [
  /** Read contexts, wiki pages, links, tags, the graph, exports. */
  'read',
  /** Create and update contexts, wiki pages, links, tables, properties. */
  'write',
  /** Remove rows (soft or hard). Separate from `write` so a writer can be denied it. */
  'delete',
  /** Download file content / mint presigned URLs. */
  'files.read',
  /** Upload and remove files. */
  'files.write',
  /** View the per-store config (secrets stay masked regardless). */
  'config.read',
  /** Change the per-store config, including storage credentials. */
  'config.write',
  /** Manage principals and keys, and read the access log. */
  'users.manage',
  /** Go online, link, disconnect, enable/disable access control. */
  'project.manage',
  /** See inbox threads (requests, questions, tasks between members). */
  'inbox.read',
  /**
   * Send, reply to, claim, and close inbox threads. Not a knowledge write: a reader
   * holding it stays read-only for contexts and pages (see restrictForSession).
   */
  'inbox.write',
] as const

export type Capability = (typeof CAPABILITIES)[number]

const ALL = [...CAPABILITIES]

/**
 * Default capability set per role.
 *
 * `owner` and `admin` are identical here on purpose: they differ by POLICY, not by
 * capability — the last owner cannot be demoted or removed, and only an owner may
 * disable access control or delete an admin (see principals.ts).
 */
export const ROLE_CAPABILITIES: Record<Role, readonly Capability[]> = {
  owner: ALL,
  admin: ALL,
  writer: [
    'read',
    'write',
    'delete',
    'files.read',
    'files.write',
    'config.read',
    'inbox.read',
    'inbox.write',
  ],
  // A reader is still a member: it may ask and answer in the inbox.
  reader: ['read', 'files.read', 'config.read', 'inbox.read', 'inbox.write'],
}

/** Per-capability overrides layered over the role defaults. */
export type CapabilityOverrides = Partial<Record<Capability, boolean>>

export function isCapability(v: string): v is Capability {
  return (CAPABILITIES as readonly string[]).includes(v)
}

export function isRole(v: string): v is Role {
  return (ROLES as readonly string[]).includes(v)
}

/** The effective capabilities of a role once its overrides are applied. */
export function resolveCapabilities(
  role: Role,
  overrides: CapabilityOverrides = {},
): Set<Capability> {
  const set = new Set<Capability>(ROLE_CAPABILITIES[role])
  for (const [cap, allowed] of Object.entries(overrides)) {
    if (!isCapability(cap)) continue
    if (allowed) set.add(cap)
    else set.delete(cap)
  }
  return set
}

/** Read the stored `capabilities` JSON column, tolerating anything malformed. */
export function parseOverrides(raw: string | null): CapabilityOverrides {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: CapabilityOverrides = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (isCapability(k) && typeof v === 'boolean') out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

/**
 * Serialize overrides for storage; an empty set becomes NULL, not `{}`.
 *
 * `preserveFrom` is the row's previous raw JSON: any boolean entry under a key this
 * version does not recognize is carried over untouched. A capability added by a
 * NEWER bctx (say, a mute on a future capability) must survive an edit made from
 * this one — dropping it would silently re-grant what an admin had denied.
 */
export function serializeOverrides(
  overrides: CapabilityOverrides,
  preserveFrom?: string | null,
): string | null {
  const entries: [string, boolean][] = Object.entries(overrides).filter(
    (e): e is [string, boolean] => isCapability(e[0]) && typeof e[1] === 'boolean',
  )
  for (const [k, v] of Object.entries(parseRawOverrides(preserveFrom))) {
    if (!isCapability(k) && typeof v === 'boolean') entries.push([k, v])
  }
  return entries.length ? JSON.stringify(Object.fromEntries(entries)) : null
}

function parseRawOverrides(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/**
 * Parse the `--cap` CLI spec: a comma-separated list of capabilities, each
 * optionally signed. `+delete,-files.write` grants delete and denies files.write;
 * an unsigned name is a grant. Throws on an unknown capability rather than
 * silently ignoring it — a typo'd `--cap` must never look like it applied.
 */
export function parseCapabilitySpec(spec: string): CapabilityOverrides {
  const out: CapabilityOverrides = {}
  for (const raw of spec.split(',')) {
    const token = raw.trim()
    if (!token) continue
    const sign = token[0] === '+' || token[0] === '-' ? token[0] : null
    const name = sign ? token.slice(1).trim() : token
    if (!isCapability(name)) {
      throw new Error(`Unknown capability: "${name}". Known: ${CAPABILITIES.join(', ')}.`)
    }
    out[name] = sign !== '-'
  }
  return out
}

/** Render an effective capability set for display, in declaration order. */
export function formatCapabilities(caps: Set<Capability>): string {
  const list = CAPABILITIES.filter((c) => caps.has(c))
  return list.length ? list.join(', ') : '(none)'
}
