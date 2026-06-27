import { api, qs } from './client'

/** One target file as `bctx export` would write it (canonical managed block, no I/O). */
export interface PreviewFile {
  path: string
  content: string
}

export type ExportTarget = 'agents' | 'claude' | 'cursor'

export interface PreviewParams {
  targets?: ExportTarget[]
  namespace?: string
}

/** Read-only preview of the AGENTS.md / CLAUDE.md / .cursor exports. */
export const exportApi = {
  preview: (p: PreviewParams = {}) =>
    api.get<PreviewFile[]>(
      `/export/preview${qs({ targets: p.targets?.join(','), namespace: p.namespace })}`,
    ),
}
