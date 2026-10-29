import { api } from './client'
import type { ProjectInfo, ProjectStatus } from './types'

/** Project registry surface for the in-UI switcher. `switch` reopens the store. */
export const projectsApi = {
  list: () => api.get<ProjectInfo[]>('/projects'),
  status: () => api.get<ProjectStatus>('/project'),
  switch: (name: string) => api.post<ProjectStatus>('/project/switch', { name }),
  /** `changed`: frames arrived from the primary (the auto-sync refreshes only then). */
  sync: () => api.post<ProjectStatus & { changed: boolean; syncedAt: string }>('/project/sync'),
}
