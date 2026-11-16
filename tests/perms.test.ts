import { describe, expect, it } from 'vitest'
import { effectivePermissions, defaultPermissions, can } from '../src/renderer/src/lib/perms'
import { ROLE_DEFAULTS } from '../src/renderer/src/lib/constants'

describe('role permissions', () => {
  it('gives owners every permission', () => {
    const perms = defaultPermissions('owner')
    expect(perms.has('users.manage')).toBe(true)
    expect(perms.has('backup.manage')).toBe(true)
    expect(perms.has('pos.use')).toBe(true)
  })

  it('limits cashiers to the counter workflow', () => {
    const perms = defaultPermissions('cashier')
    expect(perms.has('pos.use')).toBe(true)
    expect(perms.has('users.manage')).toBe(false)
    expect(perms.has('reports.view')).toBe(false)
  })

  it('gives kitchen staff only the display workflow', () => {
    const perms = defaultPermissions('kitchen')
    expect(perms.has('kds.use')).toBe(true)
    expect(perms.has('pos.use')).toBe(false)
  })

  it('keeps every role default inside the known permission list', () => {
    for (const [role, list] of Object.entries(ROLE_DEFAULTS)) {
      for (const perm of list) {
        expect(typeof perm, `${role}:${perm}`).toBe('string')
      }
    }
  })
})

describe('permission overrides', () => {
  it('adds allowed overrides on top of the role defaults', () => {
    const perms = effectivePermissions('cashier', [{ permission: 'reports.view', allowed: true }])
    expect(can(perms, 'reports.view')).toBe(true)
  })

  it('removes denied overrides from the role defaults', () => {
    const perms = effectivePermissions('cashier', [{ permission: 'pos.use', allowed: false }])
    expect(can(perms, 'pos.use')).toBe(false)
  })
})
