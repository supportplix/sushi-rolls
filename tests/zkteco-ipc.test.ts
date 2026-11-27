import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getAppPath: () => process.cwd(),
    getPath: () => process.cwd(),
    isPackaged: false
  }
}))

import { parseZkTecoStatus, ZkTecoBridgeManager } from '../src/main/zkteco'

const connected = {
  state: 'connected',
  deviceName: 'Attendance Device',
  serialNumber: 'LX15-TEST',
  firmware: 'ZLM31-FX01-3.1.8',
  transport: 'usb-std',
  comPort: null,
  lastSeenAt: '2026-11-24T00:00:00.000Z',
  lastSyncAt: '2026-11-24T00:00:00.000Z',
  pendingOutbox: 0,
  message: null
}

describe('ZKTeco status contract', () => {
  it('accepts a valid direct-USB status', () => {
    expect(parseZkTecoStatus(connected)).toEqual(connected)
  })

  it('rejects malformed status payloads', () => {
    expect(parseZkTecoStatus({ ...connected, pendingOutbox: -1 })).toBeNull()
    expect(parseZkTecoStatus({ ...connected, transport: 'tcp' })).toBeNull()
    expect(parseZkTecoStatus(null)).toBeNull()
  })
})

describe('ZKTeco bridge manager', () => {
  it('starts idle without exposing device internals', () => {
    const manager = new ZkTecoBridgeManager(() => undefined)
    expect(manager.getStatus()).toEqual({
      state: 'idle',
      deviceName: null,
      serialNumber: null,
      firmware: null,
      transport: null,
      comPort: null,
      lastSeenAt: null,
      lastSyncAt: null,
      pendingOutbox: 0,
      message: null,
      enrollmentCommandId: null,
      enrollmentDeviceUserId: null,
      enrollmentStatus: null,
      enrollmentMessage: null,
      enrollmentUpdatedAt: null
    })
  })

  it('rejects service actions without an access token', async () => {
    const manager = new ZkTecoBridgeManager(() => undefined)
    await expect(manager.service('install', '')).resolves.toEqual({ ok: false, error: 'FORBIDDEN' })
  })

  it('rejects direct enrollment without an access token', async () => {
    const manager = new ZkTecoBridgeManager(() => undefined)
    await expect(manager.enroll({ deviceUserId: '1001', name: 'Test', accessToken: '' }))
      .resolves.toEqual({ ok: false, error: 'FORBIDDEN' })
  })

  it('reports a failed enrollment check when the bridge is not connected', async () => {
    const manager = new ZkTecoBridgeManager(() => undefined)
    await expect(manager.checkEnrollment('watch-1')).resolves.toMatchObject({ ok: false })
  })
})
