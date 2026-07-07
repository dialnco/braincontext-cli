import { api } from './client'

/** Mirrors core/files.ts FileMeta (JSON over /api/files). */
export interface FileMeta {
  id: string
  objectKey: string
  filename: string
  mime: string
  size: number
  sha256: string | null
  agentSource: string | null
  createdAt: string
  deletedAt: string | null
}

/** Mirrors core/storeConfig.ts StorageStatus — never contains the secret. */
export interface StorageStatus {
  configured: boolean
  endpoint?: string
  region?: string
  bucket?: string
  prefix?: string
  accessKeyIdMasked?: string
}

export interface StorageConfigInput {
  endpoint: string
  region?: string
  bucket: string
  accessKeyId: string
  /** Omit to keep the stored secret (write-only). */
  secretAccessKey?: string
  prefix?: string
}

export const filesApi = {
  status: () => api.get<StorageStatus>('/files/status'),
  saveConfig: (cfg: StorageConfigInput) => api.put<StorageStatus>('/files/config', cfg),
  testConfig: () => api.post<{ ok: boolean }>('/files/config/test'),
  upload: (file: File): Promise<FileMeta> => {
    const form = new FormData()
    form.append('file', file)
    return api.upload<FileMeta>('/files', form)
  },
  list: () => api.get<FileMeta[]>('/files'),
  meta: (id: string) => api.get<FileMeta>(`/files/${encodeURIComponent(id)}`),
  references: (id: string) =>
    api.get<{ references: { id: string; title: string | null }[] }>(
      `/files/${encodeURIComponent(id)}/references`,
    ),
  remove: (id: string) => api.del<{ ok: boolean }>(`/files/${encodeURIComponent(id)}`),
}

/** Same-origin content URL: the server 302s to a short-lived presigned bucket URL. */
export function fileContentUrl(id: string, download = false): string {
  return `/api/files/${encodeURIComponent(id)}/content${download ? '?disposition=attachment' : ''}`
}
