import { describe, expect, it } from 'vitest'
import { effectivePermissions, defaultPermissions, can, ALL_PERMISSIONS } from '../src/renderer/src/lib/perms'
import {
  ROLE_DEFAULTS,
  PERMISSIONS,
  ESSENTIAL_PERMISSION_KEYS,
  SENSITIVE_PERMISSION_KEYS,
  assignableRoles,
  permissionTier
} from '../src/renderer/src/lib/constants'

describe('permission curation (presentation only)', () => {
  it('keeps all 31 keys and never loses a permission from the catalog', () => {
    expect(PERMISSIONS).toHaveLength(31)
    expect(ESSENTIAL_PERMISSION_KEYS.size).toBe(12)
    expect(SENSITIVE_PERMISSION_KEYS.size).toBe(6)
    for (const p of PERMISSIONS) {
      expect(['essential', 'operational', 'sensitive']).toContain(permissionTier(p.key))
    }
    expect(PERMISSIONS.filter((p) => ESSENTIAL_PERMISSION_KEYS.has(p.key))).toHaveLength(12)
    expect(PERMISSIONS.filter((p) => SENSITIVE_PERMISSION_KEYS.has(p.key))).toHaveLength(6)
  })

  it('filters assignable roles by caller rank', () => {
    const cashier = assignableRoles('cashier')
    expect(cashier).toContain('waiter')
    expect(cashier).not.toContain('super_admin')
    const owner = assignableRoles('owner')
    expect(owner).toContain('super_admin')
    expect(owner).toHaveLength(9)
  })
})

describe('role permissions', () => {
  it('gives owners operational and administrative permissions except device controls', () => {
    const perms = defaultPermissions('owner')
    expect(perms.has('users.manage')).toBe(true)
    expect(perms.has('backup.manage')).toBe(true)
    expect(perms.has('pos.use')).toBe(true)
    expect(perms.has('device.manage')).toBe(false)
  })

  it('grants ZKTeco permissions only to the intended role defaults', () => {
    const superAdmin = defaultPermissions('super_admin')
    expect(superAdmin.has('device.manage')).toBe(true)
    expect(superAdmin.has('attendance.view')).toBe(true)
    expect(superAdmin.has('attendance.manage')).toBe(true)

    const manager = defaultPermissions('general_manager')
    expect(manager.has('device.manage')).toBe(false)
    expect(manager.has('attendance.view')).toBe(true)
    expect(manager.has('attendance.manage')).toBe(true)

    const cashier = defaultPermissions('cashier')
    expect(cashier.has('attendance.view')).toBe(false)
    expect(cashier.has('attendance.manage')).toBe(false)
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
    expect(ALL_PERMISSIONS).toEqual(expect.arrayContaining(['device.manage', 'attendance.view', 'attendance.manage']))
    for (const [role, list] of Object.entries(ROLE_DEFAULTS)) {
      for (const perm of list) {
        expect(ALL_PERMISSIONS, `${role}:${perm}`).toContain(perm)
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
