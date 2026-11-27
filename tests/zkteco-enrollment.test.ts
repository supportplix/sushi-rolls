import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const health = vi.hoisted(() => vi.fn())
const enroll = vi.hoisted(() => vi.fn())
const checkEnrollment = vi.hoisted(() => vi.fn())

vi.mock('@/lib/ipc', () => ({
  api: { zkteco: { health, enroll, checkEnrollment } }
}))

import { checkLiveEnrollment, enrollFingerprintLive, startEnrollment } from '@/lib/zkteco'

function createDb(statuses: string[], errors: (string | null)[] = []) {
  const commandStatuses = new Map<string, string>()
  const events: string[] = []
  let commandIndex = 0

  const rpc = vi.fn(async (_name: string, args: Record<string, unknown>) => {
    const id = `command-${commandIndex}`
    events.push(`enqueue:${String(args.p_type)}`)
    commandStatuses.set(id, statuses[commandIndex])
    commandIndex += 1
    return { data: { id }, error: null }
  })

  const from = vi.fn(() => ({
    select: () => ({
      eq: (_column: string, id: string) => ({
        maybeSingle: async () => {
          events.push(`poll:${id}`)
          const index = Number(id.slice('command-'.length))
          return {
            data: { status: commandStatuses.get(id), last_error: errors[index] ?? null },
            error: null
          }
        }
      })
    })
  }))

  return { client: { from, rpc } as unknown as SupabaseClient, events, rpc }
}

describe('startEnrollment', () => {
  beforeEach(() => {
    health.mockReset()
    health.mockResolvedValue({ state: 'connected', message: null })
  })

  it('creates the device user before requesting fingerprint capture', async () => {
    const db = createDb(['completed', 'processing'])

    await expect(startEnrollment(db.client, 'employee-1')).resolves.toBe('command-1')

    expect(db.events).toEqual([
      'enqueue:create_user',
      'poll:command-0',
      'enqueue:start_enrollment'
    ])
  })

  it('does not request enrollment if device user creation fails', async () => {
    const db = createDb(['failed'], ['USB device is unavailable'])

    await expect(startEnrollment(db.client, 'employee-1')).rejects.toThrow('USB device is unavailable')
    expect(db.rpc).toHaveBeenCalledTimes(1)
  })

  it('does not enqueue commands when the local device is not connected', async () => {
    health.mockResolvedValue({ state: 'device-missing', message: 'DEVICE_NOT_CONNECTED' })
    const db = createDb([])

    await expect(startEnrollment(db.client, 'employee-1')).rejects.toThrow('DEVICE_NOT_CONNECTED')
    expect(db.rpc).not.toHaveBeenCalled()
  })
})

describe('enrollFingerprintLive', () => {
  beforeEach(() => {
    health.mockReset()
    enroll.mockReset()
    checkEnrollment.mockReset()
  })

  function createLiveDb(deviceUserId: string | null) {
    const calls: string[] = []
    const rpc = vi.fn(async (name: string, _args: Record<string, unknown>) => {
      calls.push(name)
      if (name === 'zkteco_reserve_device_user') {
        return { data: deviceUserId ? { device_user_id: deviceUserId, ok: true } : null, error: null }
      }
      return { data: null, error: null }
    })
    return {
      client: {
        from: vi.fn(() => { throw new Error('live enrollment must not poll command rows') }),
        rpc,
        auth: { getSession: async () => ({ data: { session: { access_token: 'admin-token' } } }) }
      } as unknown as SupabaseClient,
      calls,
      rpc
    }
  }

  it('reserves the device user id instead of enqueuing a create_user command', async () => {
    enroll.mockResolvedValue({ ok: true, commandId: 'watch-1' })
    const db = createLiveDb('1001')

    await expect(enrollFingerprintLive(db.client, 'employee-1', 'Ahmed')).resolves.toBe('watch-1')

    expect(db.calls).toEqual(['zkteco_reserve_device_user', 'zkteco_update_enrollment'])
    expect(db.rpc).toHaveBeenCalledWith('zkteco_reserve_device_user', { p_employee_id: 'employee-1' })
    expect(enroll).toHaveBeenCalledWith(expect.objectContaining({
      deviceUserId: '1001',
      name: 'Ahmed',
      watchOnly: true,
      accessToken: 'admin-token'
    }))
  })

  it('fails when no device user id could be reserved', async () => {
    const db = createLiveDb(null)

    await expect(enrollFingerprintLive(db.client, 'employee-1', 'Ahmed')).rejects.toThrow('DEVICE_MAPPING_MISSING')
    expect(enroll).not.toHaveBeenCalled()
  })

  it('does not start the watch when the terminal reports a failure', async () => {
    enroll.mockResolvedValue({ ok: false, error: 'DEVICE_BUSY' })
    const db = createLiveDb('1001')

    await expect(enrollFingerprintLive(db.client, 'employee-1', 'Ahmed')).rejects.toThrow('DEVICE_BUSY')
  })

  it('surfaces a missing schema as a deployable error', async () => {
    const db = createLiveDb('1001')
    db.rpc.mockImplementation(async (name: string): Promise<{ data: any; error: any }> => {
      if (name === 'zkteco_reserve_device_user') {
        return { data: null, error: { code: 'PGRST202', message: 'function missing' } }
      }
      return { data: null, error: null }
    })

    await expect(enrollFingerprintLive(db.client, 'employee-1', 'Ahmed')).rejects.toThrow('ZKTECO_SCHEMA_NOT_DEPLOYED')
  })
})

describe('checkLiveEnrollment', () => {
  beforeEach(() => {
    checkEnrollment.mockReset()
  })

  it('asks the bridge to probe the running watch enrollment', async () => {
    checkEnrollment.mockResolvedValue({ ok: true, status: 'awaiting_scan', count: 3, baseline: 3 })

    await expect(checkLiveEnrollment('watch-1')).resolves.toEqual({ ok: true, status: 'awaiting_scan', count: 3, baseline: 3 })
    expect(checkEnrollment).toHaveBeenCalledWith('watch-1')
  })

  it('reports a completed registration', async () => {
    checkEnrollment.mockResolvedValue({ ok: true, status: 'enrolled', count: 4, baseline: 3 })

    await expect(checkLiveEnrollment('watch-1')).resolves.toMatchObject({ ok: true, status: 'enrolled' })
  })

  it('propagates bridge errors', async () => {
    checkEnrollment.mockResolvedValue({ ok: false, error: 'NO_ACTIVE_ENROLLMENT' })

    await expect(checkLiveEnrollment('watch-1')).resolves.toMatchObject({ ok: false, error: 'NO_ACTIVE_ENROLLMENT' })
  })
})
