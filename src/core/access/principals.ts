import type { Kysely } from 'kysely'
import { ulid } from 'ulidx'
import { withWriteRetry } from '../tx'
import type { Database, PrincipalKeysTable, PrincipalStatus, PrincipalsTable, Role } from '../types'
import {
  CAPABILITIES,
  type Capability,
  type CapabilityOverrides,
  isRole,
  parseOverrides,
  resolveCapabilities,
  serializeOverrides,
} from './capabilities'
import { AccessError } from './errors'
import { generateKey } from './keys'

/**
 * A principal as the surfaces see it: role plus the RESOLVED capability list, so a
 * caller never has to merge overrides itself. The `capabilities` column's raw JSON
 * is kept as `overrides` for editing round-trips.
 */
export interface Principal {
  id: string
  handle: string
  displayName: string | null
  role: Role
  overrides: CapabilityOverrides
  capabilities: Capability[]
  status: PrincipalStatus
  createdAt: string
  createdBy: string | null
  updatedAt: string
}

/** A key as the surfaces see it. The hash and the secret are never in this shape. */
export interface KeyRecord {
  id: string
  principalId: string
  label: string | null
  prefix: string
  createdAt: string
  expiresAt: string | null
  lastUsedAt: string | null
  revokedAt: string | null
  createdBy: string | null
  /** Neither revoked nor past its expiry. */
  active: boolean
}

const HANDLE_RE = /^[a-z0-9][a-z0-9._-]*$/i
const HANDLE_MAX = 64

export function validateHandle(handle: string): string {
  const h = handle.trim()
  if (!HANDLE_RE.test(h) || h.length > HANDLE_MAX) {
    throw new AccessError(
      `Invalid handle: "${handle}" (letters, digits, '.', '-', '_'; max ${HANDLE_MAX}).`,
      'invalid_handle',
    )
  }
  return h
}

export function toPrincipal(row: PrincipalsTable): Principal {
  const overrides = parseOverrides(row.capabilities)
  const resolved = resolveCapabilities(row.role, overrides)
  return {
    id: row.id,
    handle: row.handle,
    displayName: row.display_name,
    role: row.role,
    overrides,
    capabilities: CAPABILITIES.filter((c) => resolved.has(c)),
    status: row.status,
    createdAt: row.created_at,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
  }
}

export function toKeyRecord(row: PrincipalKeysTable, now = Date.now()): KeyRecord {
  const expired = row.expires_at ? Date.parse(row.expires_at) <= now : false
  return {
    id: row.id,
    principalId: row.principal_id,
    label: row.label,
    prefix: row.prefix,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    createdBy: row.created_by,
    active: !row.revoked_at && !expired,
  }
}

// ── Reads ──────────────────────────────────────────────────────────────────────

export async function listPrincipals(db: Kysely<Database>): Promise<Principal[]> {
  const rows = await db.selectFrom('principals').selectAll().orderBy('handle').execute()
  return rows.map(toPrincipal)
}

export async function getPrincipalById(
  db: Kysely<Database>,
  id: string,
): Promise<Principal | null> {
  const row = await db.selectFrom('principals').selectAll().where('id', '=', id).executeTakeFirst()
  return row ? toPrincipal(row) : null
}

/** Handles are matched case-insensitively (the unique index is on `lower(handle)`). */
export async function getPrincipalByHandle(
  db: Kysely<Database>,
  handle: string,
): Promise<Principal | null> {
  const rows = await db.selectFrom('principals').selectAll().execute()
  const want = handle.trim().toLowerCase()
  const row = rows.find((r) => r.handle.toLowerCase() === want)
  return row ? toPrincipal(row) : null
}

async function requirePrincipal(db: Kysely<Database>, handle: string): Promise<Principal> {
  const p = await getPrincipalByHandle(db, handle)
  if (!p) throw new AccessError(`No such user: "${handle}".`, 'no_such_principal')
  return p
}

export async function countActiveOwners(db: Kysely<Database>): Promise<number> {
  const rows = await db
    .selectFrom('principals')
    .select('id')
    .where('role', '=', 'owner')
    .where('status', '=', 'active')
    .execute()
  return rows.length
}

// ── Policy ─────────────────────────────────────────────────────────────────────

/**
 * Owner/admin protection. Two rules, kept here so every surface gets them:
 *  1. the last ACTIVE owner can't be demoted, disabled, or deleted — otherwise the
 *     project locks itself out of its own user management;
 *  2. only an owner may modify or delete an owner or an admin, so an admin can't
 *     quietly remove their peers or their boss.
 * `actor` is null for the bootstrap path (`bctx access init`) and for recovery.
 */
async function assertMayModify(
  db: Kysely<Database>,
  actor: Principal | null,
  target: Principal,
  change: { role?: Role; status?: PrincipalStatus; deleting?: boolean },
): Promise<void> {
  if (actor && actor.role !== 'owner' && (target.role === 'owner' || target.role === 'admin')) {
    throw new AccessError(
      `Only an owner can modify the ${target.role} "${target.handle}".`,
      'owner_required',
    )
  }
  const losesOwner =
    target.role === 'owner' &&
    target.status === 'active' &&
    (change.deleting === true ||
      change.status === 'disabled' ||
      (change.role && change.role !== 'owner'))
  if (losesOwner && (await countActiveOwners(db)) <= 1) {
    throw new AccessError(
      `"${target.handle}" is the last active owner — promote another owner first.`,
      'last_owner',
    )
  }
}

// ── Writes ─────────────────────────────────────────────────────────────────────

export interface CreatePrincipalInput {
  handle: string
  role: Role
  displayName?: string | null
  overrides?: CapabilityOverrides
  createdBy?: string | null
}

export async function createPrincipal(
  db: Kysely<Database>,
  input: CreatePrincipalInput,
): Promise<Principal> {
  const handle = validateHandle(input.handle)
  if (!isRole(input.role)) throw new AccessError(`Invalid role: "${input.role}".`, 'invalid_role')
  if (await getPrincipalByHandle(db, handle)) {
    throw new AccessError(`User already exists: "${handle}".`, 'duplicate_handle')
  }
  const now = new Date().toISOString()
  const row: PrincipalsTable = {
    id: ulid(),
    handle,
    display_name: input.displayName ?? null,
    role: input.role,
    capabilities: serializeOverrides(input.overrides ?? {}),
    status: 'active',
    created_at: now,
    created_by: input.createdBy ?? null,
    updated_at: now,
  }
  await withWriteRetry(db, async (trx) => {
    await trx.insertInto('principals').values(row).execute()
  })
  return toPrincipal(row)
}

export interface UpdatePrincipalInput {
  role?: Role
  displayName?: string | null
  overrides?: CapabilityOverrides
  status?: PrincipalStatus
}

export async function updatePrincipal(
  db: Kysely<Database>,
  handle: string,
  patch: UpdatePrincipalInput,
  actor: Principal | null = null,
): Promise<Principal> {
  const target = await requirePrincipal(db, handle)
  if (patch.role !== undefined && !isRole(patch.role)) {
    throw new AccessError(`Invalid role: "${patch.role}".`, 'invalid_role')
  }
  await assertMayModify(db, actor, target, { role: patch.role, status: patch.status })

  const next = {
    role: patch.role ?? target.role,
    display_name: patch.displayName === undefined ? target.displayName : patch.displayName,
    capabilities: serializeOverrides(patch.overrides ?? target.overrides),
    status: patch.status ?? target.status,
    updated_at: new Date().toISOString(),
  }
  await withWriteRetry(db, async (trx) => {
    await trx.updateTable('principals').set(next).where('id', '=', target.id).execute()
  })
  const updated = await getPrincipalById(db, target.id)
  if (!updated) throw new AccessError(`User "${handle}" vanished mid-update.`, 'no_such_principal')
  return updated
}

export async function deletePrincipal(
  db: Kysely<Database>,
  handle: string,
  actor: Principal | null = null,
): Promise<Principal> {
  const target = await requirePrincipal(db, handle)
  await assertMayModify(db, actor, target, { deleting: true })
  // principal_keys cascades; access_log deliberately does not (the record of what
  // this identity did must outlive the identity).
  await withWriteRetry(db, async (trx) => {
    await trx.deleteFrom('principals').where('id', '=', target.id).execute()
  })
  return target
}

// ── Keys ───────────────────────────────────────────────────────────────────────

export interface IssueKeyInput {
  label?: string | null
  /** ISO 8601 instant. Must be in the future. */
  expiresAt?: string | null
  createdBy?: string | null
}

export interface IssuedKey {
  /** The full secret. Displayed once at issue time and never recoverable after. */
  key: string
  record: KeyRecord
}

export async function issueKey(
  db: Kysely<Database>,
  handle: string,
  input: IssueKeyInput = {},
): Promise<IssuedKey> {
  const principal = await requirePrincipal(db, handle)
  const expiresAt = normalizeExpiry(input.expiresAt)
  const generated = await generateKey()
  const now = new Date().toISOString()
  const row: PrincipalKeysTable = {
    id: ulid(),
    principal_id: principal.id,
    label: input.label ?? null,
    prefix: generated.prefix,
    secret_hash: generated.secretHash,
    created_at: now,
    expires_at: expiresAt,
    last_used_at: null,
    revoked_at: null,
    created_by: input.createdBy ?? null,
  }
  await withWriteRetry(db, async (trx) => {
    await trx.insertInto('principal_keys').values(row).execute()
  })
  return { key: generated.key, record: toKeyRecord(row) }
}

function normalizeExpiry(value: string | null | undefined): string | null {
  if (!value) return null
  const ms = Date.parse(value)
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid --expires: "${value}" (expected an ISO 8601 date).`)
  }
  if (ms <= Date.now()) throw new Error(`--expires must be in the future: "${value}".`)
  return new Date(ms).toISOString()
}

export async function listKeys(db: Kysely<Database>, principalId?: string): Promise<KeyRecord[]> {
  let q = db.selectFrom('principal_keys').selectAll()
  if (principalId) q = q.where('principal_id', '=', principalId)
  const rows = await q.orderBy('created_at', 'desc').execute()
  const now = Date.now()
  return rows.map((r) => toKeyRecord(r, now))
}

export async function revokeKey(db: Kysely<Database>, keyId: string): Promise<KeyRecord> {
  const row = await db
    .selectFrom('principal_keys')
    .selectAll()
    .where('id', '=', keyId)
    .executeTakeFirst()
  if (!row) throw new AccessError(`No such key: "${keyId}".`, 'no_such_key')
  if (row.revoked_at) return toKeyRecord(row)
  const revokedAt = new Date().toISOString()
  await withWriteRetry(db, async (trx) => {
    await trx
      .updateTable('principal_keys')
      .set({ revoked_at: revokedAt })
      .where('id', '=', keyId)
      .execute()
  })
  return toKeyRecord({ ...row, revoked_at: revokedAt })
}
