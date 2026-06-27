import type { Context as HonoContext } from 'hono'
import type { z } from 'zod'

/**
 * Shared helpers for the Studio JSON routes. Keep route modules thin: parse +
 * validate here, call `core/` in the handler, return JSON. No raw SQL anywhere
 * in this layer (the anti-drift rule — every surface goes through `core/`).
 */

/** A validated JSON body, or a ready-to-return 400 Response. */
export type Parsed<T> = { ok: true; data: T } | { ok: false; res: Response }

/** Parse + zod-validate a JSON request body. On failure returns a 400 to return as-is. */
export async function readJson<T>(c: HonoContext, schema: z.ZodType<T>): Promise<Parsed<T>> {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    return { ok: false, res: c.json({ error: 'invalid JSON body' }, 400) }
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    return {
      ok: false,
      res: c.json({ error: 'validation failed', issues: parsed.error.issues }, 400),
    }
  }
  return { ok: true, data: parsed.data }
}

/** Read a positive-integer query param, or `undefined` when absent/invalid. */
export function intQuery(c: HonoContext, key: string): number | undefined {
  const raw = c.req.query(key)
  if (raw === undefined) return undefined
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : undefined
}

/** Read a query param constrained to an allowed set, or `undefined`. */
export function enumQuery<T extends string>(
  c: HonoContext,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const raw = c.req.query(key)
  return raw !== undefined && (allowed as readonly string[]).includes(raw) ? (raw as T) : undefined
}

/** Read a non-empty trimmed string query param, or `undefined`. */
export function strQuery(c: HonoContext, key: string): string | undefined {
  const raw = c.req.query(key)?.trim()
  return raw ? raw : undefined
}
