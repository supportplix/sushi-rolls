import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/ipc', () => ({
  api: {
    zkteco: {
      configure: vi.fn(async () => ({ ok: true })),
      health: vi.fn(async () => ({ state: 'connected', message: null }))
    }
  }
}))

import {
  createDeviceToken,
  createOrRotateDevice,
  deleteEmployeeWithDevice,
  hashDeviceToken,
  listEmployeeDevices,
  startEnrollment,
  type AttendanceDevice
} from '../src/renderer/src/lib/zkteco'
import { api } from '../src/renderer/src/lib/ipc'

function fakeDb() {
  let commandNumber = 0
  const rpc = vi.fn(async (_name: string, _args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }> => ({
    data: { id: `command-${++commandNumber}` },
    error: null
  }))
  const from = vi.fn(() => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({ data: { status: 'completed', last_error: null }, error: null })
      })
    })
  }))
  return {
    rpc,
    from,
    auth: {
      getSession: vi.fn(async () => ({ data: { session: { access_token: 'admin-token' } } }))
    }
  }
}

function fakeDeleteDb(
  mapping: boolean,
  command: { status: string; last_error: string | null } | null,
  mappingError: { code: string } | null = null
) {
  const rpc = vi.fn(async () => ({ data: { id: 'command-1' }, error: null }))
  const deleteEmployee = vi.fn(async () => ({ error: null }))
  const from = vi.fn((table: string) => {
    if (table === 'employee_devices') {
      return {
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: mapping ? { id: 'mapping-1' } : null, error: mappingError }) })
        })
      }
    }
    if (table === 'device_commands') {
      return {
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: command, error: null }) })
        })
      }
    }
    if (table === 'employees') return { delete: () => ({ eq: deleteEmployee }) }
    throw new Error(`Unexpected table ${table}`)
  })
  return { rpc, from, deleteEmployee }
}

describe('ZKTeco renderer client', () => {
  it('creates unique 256-bit device tokens', () => {
    const first = createDeviceToken()
    const second = createDeviceToken()
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(second).toMatch(/^[0-9a-f]{64}$/)
    expect(first).not.toBe(second)
  })

  it('hashes tokens with SHA-256', async () => {
    expect(await hashDeviceToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('loads employee device mappings without using a nonexistent creation column', async () => {
    const order = vi.fn(async () => ({ data: [], error: null }))
    const db = { from: vi.fn(() => ({ select: () => ({ order }) })) }
    await expect(listEmployeeDevices(db as never)).resolves.toEqual([])
    expect(order).toHaveBeenCalledWith('id')
  })

  it('creates the device user before starting enrollment', async () => {
    const db = fakeDb()
    await startEnrollment(db as never, 'employee-1')
    expect(db.rpc.mock.calls.map((call) => call[1].p_type)).toEqual(['create_user', 'start_enrollment'])
  })

  it('stores only the token hash and configures the bridge with the plaintext token', async () => {
    const db = fakeDb()
    const existing = null
    await createOrRotateDevice(db as never, 'https://example.supabase.co', existing)
    const firstCall = db.rpc.mock.calls[0]
    if (!firstCall) throw new Error('RPC was not called')
    const args = firstCall[1]
    expect(args.p_token_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(args)).not.toContain('deviceToken')
    expect(api.zkteco.configure).toHaveBeenCalledWith(expect.objectContaining({
      supabaseUrl: 'https://example.supabase.co',
      timezone: 'Africa/Cairo',
      deviceToken: expect.stringMatching(/^[0-9a-f]{64}$/)
    }))
  })

  it('rotates an existing device without changing its identity fields', async () => {
    const db = fakeDb()
    const existing = {
      id: 'device-1',
      name: 'LX15',
      serial_number: 'SERIAL',
      usb_vid: '1B55',
      usb_pid: '0A01',
      status: 'online',
      background_mode: 'app_only',
      attendance_mode: 'alternating',
      timezone: 'Africa/Cairo',
      device_token_hash: 'old',
      last_seen_at: null,
      last_sync_at: null,
      clock_drift_seconds: null
    } satisfies AttendanceDevice
    await createOrRotateDevice(db as never, 'https://example.supabase.co', existing)
    const firstCall = db.rpc.mock.calls[0]
    if (!firstCall) throw new Error('RPC was not called')
    expect(firstCall[1].p_device).toEqual({ id: 'device-1' })
  })

  it('deletes the device user before deleting an enrolled employee', async () => {
    const db = fakeDeleteDb(true, { status: 'completed', last_error: null })
    await deleteEmployeeWithDevice(db as never, 'employee-1')
    expect(db.rpc).toHaveBeenCalledWith('zkteco_enroll_employee', expect.objectContaining({ p_type: 'delete_user' }))
    expect(db.deleteEmployee).toHaveBeenCalledWith('id', 'employee-1')
  })

  it('keeps the employee when device-user deletion fails', async () => {
    const db = fakeDeleteDb(true, { status: 'failed', last_error: 'device busy' })
    await expect(deleteEmployeeWithDevice(db as never, 'employee-1')).rejects.toThrow('device busy')
    expect(db.deleteEmployee).not.toHaveBeenCalled()
  })

  it('deletes employees that have no device mapping without queuing a command', async () => {
    const db = fakeDeleteDb(false, null)
    await deleteEmployeeWithDevice(db as never, 'employee-1')
    expect(db.rpc).not.toHaveBeenCalled()
    expect(db.deleteEmployee).toHaveBeenCalledWith('id', 'employee-1')
  })

  it('still deletes unenrolled employees when the ZKTeco schema is not deployed', async () => {
    const db = fakeDeleteDb(false, null, { code: 'PGRST205' })
    await deleteEmployeeWithDevice(db as never, 'employee-1')
    expect(db.rpc).not.toHaveBeenCalled()
    expect(db.deleteEmployee).toHaveBeenCalledWith('id', 'employee-1')
  })

  it('reports a clear error when the ZKTeco command RPC is missing', async () => {
    const db = fakeDb()
    db.rpc.mockResolvedValueOnce({ data: null, error: { code: 'PGRST202', message: 'function missing' } })
    await expect(startEnrollment(db as never, 'employee-1')).rejects.toThrow('ZKTECO_SCHEMA_NOT_DEPLOYED')
  })
})
