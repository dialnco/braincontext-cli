/**
 * Tiny typed fetch wrapper over the same-origin Studio JSON API. All requests are
 * relative to `/api` (the SPA is served by the same Hono server, and the dev server
 * proxies `/api` → :8420). Non-2xx responses throw an {@link ApiError} carrying the
 * server's JSON `error` message so callers can surface it.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  const data = text ? safeJson(text) : undefined
  if (!res.ok) {
    let message = `${method} ${path} failed (${res.status})`
    if (data && typeof data === 'object' && 'error' in data) {
      message = String((data as { error: unknown }).error)
    }
    throw new ApiError(res.status, message, data)
  }
  return data as T
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Build a query string from defined params (skips undefined/empty). */
export function qs(params: Record<string, string | number | undefined>): string {
  const pairs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
  return pairs.length ? `?${pairs.join('&')}` : ''
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  del: <T>(path: string, body?: unknown) => request<T>('DELETE', path, body),
}
