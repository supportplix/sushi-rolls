import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const health = vi.hoisted(() => vi.fn())

vi.mock('@/lib/ipc', () => ({
  api: { zkteco: { health } }
}))

import { startEnrollment } from '@/lib/zkteco'

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
