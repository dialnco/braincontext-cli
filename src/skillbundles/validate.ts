const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/

export interface SkillIdentity {
  name: string
  description: string
  dirName: string
}

/**
 * Validate a skill bundle against the open Agent-Skills standard so exports work
 * everywhere: kebab-case `name` (1–64), `name` == folder name, description 1–1024.
 * Returns a list of human-readable errors (empty = valid).
 */
export function validateSkill({ name, description, dirName }: SkillIdentity): string[] {
  const errors: string[] = []

  if (name.length < 1 || name.length > 64) errors.push('name must be 1–64 characters')
  if (!KEBAB.test(name)) {
    errors.push(`name "${name}" must be kebab-case (lowercase a-z, 0-9, single hyphens)`)
  }
  if (name !== dirName) {
    errors.push(`name "${name}" must equal the folder name "${dirName}"`)
  }

  const d = description.trim()
  if (d.length < 1) errors.push('description is required')
  if (d.length > 1024) errors.push('description must be ≤ 1024 characters')

  return errors
}
