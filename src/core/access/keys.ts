import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import type { Kysely } from 'kysely'
import type { Database, PrincipalKeysTable, PrincipalsTable } from '../types'

const scrypt = promisify(scryptCb) as (
  secret: string,
  salt: Buffer,
  keylen: number,
  opts: { N: number; r: number; p: number },
) => Promise<Buffer>

/** Marker so a leaked string is recognizable as a bctx key (and greppable in logs). */
export const KEY_SCHEME = 'bctxk'

/**
 * scrypt work factors. The secret is a 192-bit value WE generate, never a
 * human-chosen passphrase, so brute force is already infeasible and the KDF is
 * defense in depth (against a store whose keys were somehow seeded by hand).
 * These are the standard interactive parameters, ~60ms — a cost paid once per
 * CLI invocation, and once per session for Studio/MCP. They live inside the
 * stored hash string, so raising them later needs no migration.
 */
const N = 16384
const R = 8
const P = 1
const KEYLEN = 32
const SALT_BYTES = 16

/** 9 bytes → 12 base64url chars. Public half; only needs to be collision-free. */
const PREFIX_BYTES = 9
/** 24 bytes → 32 base64url chars (192 bits). */
const SECRET_BYTES = 24

export interface GeneratedKey {
  /** The full `bctxk.<prefix>.<secret>` string. Shown once, never stored. */
  key: string
  prefix: string
  secretHash: string
}

/** Mint a new key: the caller must persist `prefix`/`secretHash` and hand `key` over exactly once. */
export async function generateKey(): Promise<GeneratedKey> {
  const prefix = randomBytes(PREFIX_BYTES).toString('base64url')
  const secret = randomBytes(SECRET_BYTES).toString('base64url')
  return {
    key: `${KEY_SCHEME}.${prefix}.${secret}`,
    prefix,
    secretHash: await hashSecret(secret),
  }
}

/** PHC-style `scrypt$N$r$p$salt$hash` so the parameters travel with the digest. */
export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES)
  const hash = await scrypt(secret, salt, KEYLEN, { N, r: R, p: P })
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${hash.toString('base64url')}`
}

export async function verifySecret(secret: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const n = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false
  let expected: Buffer
  let actual: Buffer
  try {
    expected = Buffer.from(parts[5] as string, 'base64url')
    actual = await scrypt(secret, Buffer.from(parts[4] as string, 'base64url'), expected.length, {
      N: n,
      r,
      p,
    })
  } catch {
    return false // unusable parameters (e.g. maxmem) — treat as a non-match, never throw
  }
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

export interface ParsedKey {
  prefix: string
  secret: string
}

/** Split a `bctxk.<prefix>.<secret>` string, or null if it isn't one. */
export function parseKey(key: string): ParsedKey | null {
  const parts = key.trim().split('.')
  if (parts.length !== 3 || parts[0] !== KEY_SCHEME) return null
  const [, prefix, secret] = parts
  if (!prefix || !secret) return null
  return { prefix, secret }
}

/** Why a key did not authenticate. Surfaces decide how much of this to reveal. */
export type KeyFailure = 'malformed' | 'unknown' | 'revoked' | 'expired' | 'disabled'

export type VerifiedKey =
  | { ok: true; principal: PrincipalsTable; key: PrincipalKeysTable }
  | { ok: false; reason: KeyFailure }

/** Refresh `last_used_at` at most this often, so a read command doesn't become a
 *  write to the remote primary on every invocation. Hour granularity is all any
 *  "last seen" display needs. */
const LAST_USED_REFRESH_MS = 60 * 60 * 1000

/**
 * Authenticate a key against the store. One indexed lookup by the public prefix,
 * then a constant-time comparison of the scrypt digest.
 *
 * A wrong secret is reported as `unknown`, identical to a prefix that does not
 * exist: whether a given prefix is registered is not something an unauthenticated
 * caller should learn.
 */
export async function verifyKey(db: Kysely<Database>, key: string): Promise<VerifiedKey> {
  const parsed = parseKey(key)
  if (!parsed) return { ok: false, reason: 'malformed' }

  const row = await db
    .selectFrom('principal_keys')
    .selectAll()
    .where('prefix', '=', parsed.prefix)
    .executeTakeFirst()
  if (!row) return { ok: false, reason: 'unknown' }
  if (!(await verifySecret(parsed.secret, row.secret_hash))) return { ok: false, reason: 'unknown' }

  if (row.revoked_at) return { ok: false, reason: 'revoked' }
  const now = Date.now()
  if (row.expires_at && Date.parse(row.expires_at) <= now) return { ok: false, reason: 'expired' }

  const principal = await db
    .selectFrom('principals')
    .selectAll()
    .where('id', '=', row.principal_id)
    .executeTakeFirst()
  // The FK is ON DELETE CASCADE, so a missing principal means the row was written
  // out-of-band with foreign_keys off — refuse rather than authenticate a ghost.
  if (!principal) return { ok: false, reason: 'unknown' }
  if (principal.status !== 'active') return { ok: false, reason: 'disabled' }

  await touchKey(db, row, now)
  return { ok: true, principal, key: row }
}

async function touchKey(db: Kysely<Database>, row: PrincipalKeysTable, now: number): Promise<void> {
  const last = row.last_used_at ? Date.parse(row.last_used_at) : 0
  if (Number.isFinite(last) && now - last < LAST_USED_REFRESH_MS) return
  try {
    await db
      .updateTable('principal_keys')
      .set({ last_used_at: new Date(now).toISOString() })
      .where('id', '=', row.id)
      .execute()
  } catch {
    // Best effort. A read-only connection (a phase-2 read-only Turso token) must
    // still be able to authenticate — losing a "last seen" timestamp is not a
    // reason to lock a legitimate reader out.
  }
}
