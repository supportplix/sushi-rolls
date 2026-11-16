import type { Role } from './types'
import { PERMISSIONS, ROLE_DEFAULTS } from './constants'

export const ALL_PERMISSIONS = PERMISSIONS.map((p) => p.key)

export function defaultPermissions(role: Role): Set<string> {
  return new Set(ROLE_DEFAULTS[role] ?? [])
}

export function effectivePermissions(
  role: Role,
  overrides: { permission: string; allowed: boolean }[]
): Set<string> {
  const set = defaultPermissions(role)
  for (const o of overrides) {
    if (o.allowed) set.add(o.permission)
    else set.delete(o.permission)
  }
  return set
}

export function can(perms: Set<string>, permission: string): boolean {
  return perms.has(permission)
}
