import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash, createHmac, randomBytes } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'

vi.mock('electron', () => ({
  app: {
    getAppPath: () => process.cwd(),
    getPath: () => process.cwd(),
    isPackaged: false
  }
}))

import { ZkTecoBridgeManager } from '../src/main/zkteco'

type Frame = {
  id: string
  type: string
  [key: string]: unknown
}

const envKeys = [
  'MAIN_VITE_SUPABASE_URL',
  'MAIN_VITE_SUPABASE_ANON_KEY',
  'VITE_SUPABASE_URL',
  'VITE_SUPABASE_ANON_KEY'
] as const

const savedEnv: Record<string, string | undefined> = {}
for (const key of envKeys) savedEnv[key] = process.env[key]

beforeEach(() => {
  for (const key of envKeys) delete process.env[key]
})

afterEach(() => {
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  vi.unstubAllGlobals()
})

/** Injects a fake pipe that answers each frame synchronously and records it. */
function attachFakeBridge(
  manager: ZkTecoBridgeManager,
  responder: (frame: Frame) => Record<string, unknown>
): Frame[] {
  const sent: Frame[] = []
  const socket = {
    writable: true,
    destroyed: false,
    write: (chunk: string) => {
      const frame = JSON.parse(chunk) as Frame
      sent.push(frame)
      const response = responder(frame)
      void (manager as unknown as { handleLine: (line: string) => void }).handleLine(JSON.stringify(response) + '\n')
      return true
    },
    destroy: () => undefined
  }
  ;(manager as unknown as { socket: typeof socket }).socket = socket
  return sent
}

function expectedProof(clientNonce: string, serverNonce: string, challenge: string): string {
  const key = createHash('sha256')
    .update(Buffer.concat([Buffer.from(clientNonce, 'base64'), Buffer.from(serverNonce, 'base64')]))
    .digest()
  return createHmac('sha256', key).update(Buffer.from(challenge, 'base64')).digest('base64')
}

describe('has_perm trust anchor (BE-01 review)', () => {
  it('uses the build-time VITE_* env fallback and sends the user token, not an anon-key shortcut', async () => {
    process.env.VITE_SUPABASE_URL = 'https://env.supabase.co/'
    process.env.VITE_SUPABASE_ANON_KEY = 'env-anon-key'
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => true }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(new ZkTecoBridgeManager(() => undefined).authorize('user-token')).resolves.toBe(true)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://env.supabase.co/rest/v1/rpc/has_perm')
    const headers = init.headers as Record<string, string>
    expect(headers.apikey).toBe('env-anon-key')
    expect(headers.Authorization).toBe('Bearer user-token')
    expect(JSON.parse(init.body as string)).toEqual({ p: 'device.manage' })
  })

  it('preserves the user-added MAIN_VITE_* override ahead of VITE_*', async () => {
    process.env.MAIN_VITE_SUPABASE_URL = 'https://main.supabase.co'
    process.env.MAIN_VITE_SUPABASE_ANON_KEY = 'main-anon-key'
    process.env.VITE_SUPABASE_URL = 'https://env.supabase.co'
    process.env.VITE_SUPABASE_ANON_KEY = 'env-anon-key'
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => true }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(new ZkTecoBridgeManager(() => undefined).authorize('user-token')).resolves.toBe(true)
    const [mainUrl, mainInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(mainUrl).toBe('https://main.supabase.co/rest/v1/rpc/has_perm')
    expect((mainInit.headers as Record<string, string>).apikey).toBe('main-anon-key')
  })

  it('fails closed for non-boolean, error, and unreachable has_perm responses', async () => {
    process.env.VITE_SUPABASE_URL = 'https://env.supabase.co'
    process.env.VITE_SUPABASE_ANON_KEY = 'env-anon-key'
    const manager = new ZkTecoBridgeManager(() => undefined)

    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => 'true' })))
    await expect(manager.authorize('user-token')).resolves.toBe(false)
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => true })))
    await expect(manager.authorize('user-token')).resolves.toBe(false)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    await expect(manager.authorize('user-token')).resolves.toBe(false)
  })

  it('does not attempt authorization without any Supabase configuration', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => true }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(new ZkTecoBridgeManager(() => undefined).authorize('user-token')).resolves.toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps VITE_* env access statically inlinable at build time (OPS-06)', () => {
    const source = readFileSync(join(process.cwd(), 'src/main/zkteco.ts'), 'utf8')
    expect(source).toContain('process.env.VITE_SUPABASE_URL')
    expect(source).toContain('process.env.VITE_SUPABASE_ANON_KEY')
    expect(source).not.toContain("process.env['VITE_SUPABASE_URL']")
    expect(source).not.toContain("process.env['VITE_SUPABASE_ANON_KEY']")
  })
})

describe('bridge configure proof (BE-01)', () => {
  it('obtains a fresh challenge and proves configure with an in-memory HMAC key', async () => {
    const manager = new ZkTecoBridgeManager(() => undefined)
    const challenge = randomBytes(32).toString('base64')
    const serverNonce = randomBytes(32).toString('base64')
    const sent = attachFakeBridge(manager, (frame) =>
      frame.type === 'auth_challenge'
        ? { id: frame.id, ok: true, challenge, serverNonce }
        : { id: frame.id, ok: true }
    )

    const deviceToken = 'x'.repeat(48)
    await expect(manager.configure('https://app.supabase.co', deviceToken, 'Africa/Cairo')).resolves.toEqual({ ok: true })

    const auth = sent.find((frame) => frame.type === 'auth_challenge')
    const configure = sent.find((frame) => frame.type === 'configure')
    expect(auth).toBeDefined()
    expect(configure).toBeDefined()
    expect(auth?.processPath).toBe(process.execPath)
    expect(auth?.clientNonce).toBeTruthy()
    expect(auth).not.toHaveProperty('deviceToken')
    expect(configure?.challenge).toBe(challenge)
    expect(configure?.proof).toBe(expectedProof(auth?.clientNonce as string, serverNonce, challenge))
    expect(configure?.deviceToken).toBe(deviceToken)
    expect(configure?.supabaseUrl).toBe('https://app.supabase.co')
  })

  it('never sends a configure frame when the bridge refuses to issue a challenge', async () => {
    const manager = new ZkTecoBridgeManager(() => undefined)
    const sent = attachFakeBridge(manager, (frame) =>
      frame.type === 'auth_challenge'
        ? { id: frame.id, ok: false, error: 'UNAUTHORIZED' }
        : { id: frame.id, ok: true }
    )

    await expect(manager.configure('https://app.supabase.co', 'x'.repeat(48), 'UTC'))
      .resolves.toEqual({ ok: false, error: 'UNAUTHORIZED' })
    expect(sent.some((frame) => frame.type === 'configure')).toBe(false)
  })

  it('uses a different challenge for each privileged command', async () => {
    // enroll/check_enrollment still pass through the has_perm gate in main.
    process.env.MAIN_VITE_SUPABASE_URL = 'https://main.supabase.co'
    process.env.MAIN_VITE_SUPABASE_ANON_KEY = 'main-anon-key'
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => true })))
    const manager = new ZkTecoBridgeManager(() => undefined)
    const challenges: string[] = []
    const sent = attachFakeBridge(manager, (frame) => {
      if (frame.type === 'auth_challenge') {
        const next = randomBytes(32).toString('base64')
        challenges.push(next)
        return { id: frame.id, ok: true, challenge: next, serverNonce: randomBytes(32).toString('base64') }
      }
      return { id: frame.id, ok: true, commandId: 'cmd-1', status: 'awaiting_scan' }
    })

    await expect(manager.enroll({ deviceUserId: '1001', name: 'Test', accessToken: 'admin-token' }))
      .resolves.toMatchObject({ ok: true, commandId: 'cmd-1' })
    await expect(manager.checkEnrollment('cmd-1')).resolves.toMatchObject({ ok: true, status: 'awaiting_scan' })

    expect(challenges).toHaveLength(2)
    expect(challenges[0]).not.toBe(challenges[1])
    const privileged = sent.filter((frame) => ['enroll', 'check_enrollment'].includes(frame.type))
    expect(privileged).toHaveLength(2)
    for (const frame of privileged) {
      expect(frame.challenge).toBeTruthy()
      expect(frame.proof).toBeTruthy()
    }
    expect(privileged[0].challenge).not.toBe(privileged[1].challenge)
  })
})
