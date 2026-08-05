import { api, qs } from './client'

/**
 * Access-control client. Mirrors src/core/access + src/studio/routes/access.ts.
 *
 * A raw key is only ever present in the response that CREATES it (`IssuedSecret`);
 * nothing here can read one back afterwards.
 */

export type Capability =
  | 'read'
  | 'write'
  | 'delete'
  | 'files.read'
  | 'files.write'
  | 'config.read'
  | 'config.write'
  | 'users.manage'
  | 'project.manage'

export type Role = 'owner' | 'admin' | 'writer' | 'reader'

export const ROLE_OPTIONS: Role[] = ['owner', 'admin', 'writer', 'reader']

export interface Identity {
  handle: string
  displayName: string | null
  role: string
  capabilities: Capability[]
  readOnly: boolean
}

export interface AuthState {
  enabled: boolean
  authenticated: boolean
  identity: Identity | null
  /** Set when unauthenticated: why, in words the user can act on. */
  message?: string | null
  /** True when the identity came from this machine's stored key, not a browser login. */
  adopted?: boolean
}

export interface User {
  id: string
  handle: string
  displayName: string | null
  role: Role
  overrides: Partial<Record<Capability, boolean>>
  capabilities: Capability[]
  status: 'active' | 'disabled'
  createdAt: string
  updatedAt: string
}

export interface KeyRecord {
  id: string
  principalId: string
  label: string | null
  prefix: string
  createdAt: string
  expiresAt: string | null
  lastUsedAt: string | null
  revokedAt: string | null
  active: boolean
}

/** Returned exactly once, when a key is minted. */
export interface IssuedSecret {
  key: string
  joinCode: string | null
  warning: string
}

export interface AccessLogEntry {
  id: number
  at: string
  handle: string | null
  agentSource: string | null
  surface: string
  action: string
  decision: 'allow' | 'deny'
  detail: string | null
}

export const authApi = {
  me: () => api.get<AuthState>('/auth/me'),
  login: (key: string) => api.post<AuthState>('/auth/login', { key }),
  logout: () => api.post<{ ok: true }>('/auth/logout'),
}

export const accessApi = {
  users: () => api.get<{ users: User[] }>('/access/users').then((r) => r.users),
  createUser: (input: {
    handle: string
    role: Role
    displayName?: string | null
    capabilities?: Partial<Record<Capability, boolean>>
  }) => api.post<{ user: User } & IssuedSecret>('/access/users', input),
  updateUser: (
    handle: string,
    patch: {
      role?: Role
      displayName?: string | null
      capabilities?: Partial<Record<Capability, boolean>>
      status?: 'active' | 'disabled'
    },
  ) => api.patch<{ user: User }>(`/access/users/${encodeURIComponent(handle)}`, patch),
  deleteUser: (handle: string) =>
    api.del<{ removed: User }>(`/access/users/${encodeURIComponent(handle)}`),
  keys: (handle: string) =>
    api
      .get<{ keys: KeyRecord[] }>(`/access/users/${encodeURIComponent(handle)}/keys`)
      .then((r) => r.keys),
  issueKey: (handle: string, label?: string) =>
    api.post<{ record: KeyRecord } & IssuedSecret>(
      `/access/users/${encodeURIComponent(handle)}/keys`,
      { label: label ?? null },
    ),
  revokeKey: (id: string) =>
    api.del<{ record: KeyRecord }>(`/access/keys/${encodeURIComponent(id)}`),
  log: (opts: { limit?: number; user?: string; denyOnly?: boolean } = {}) =>
    api
      .get<{ entries: AccessLogEntry[] }>(
        `/access/log${qs({
          limit: opts.limit,
          user: opts.user,
          denyOnly: opts.denyOnly ? 'true' : undefined,
        })}`,
      )
      .then((r) => r.entries),
}
