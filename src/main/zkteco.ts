import { app } from 'electron'
import { spawn } from 'child_process'
import { createConnection, Socket } from 'net'
import { join } from 'path'
import { existsSync, readFileSync } from 'fs'
import { z } from 'zod'
import type { ZkTecoServiceResult, ZkTecoStatus } from '@shared/ipc'

const PIPE_NAME = '\\\\.\\pipe\\SushiRolls.ZkTeco'
const idleStatus: ZkTecoStatus = {
  state: 'idle',
  deviceName: null,
  serialNumber: null,
  firmware: null,
  transport: null,
  comPort: null,
  lastSeenAt: null,
  lastSyncAt: null,
  pendingOutbox: 0,
  message: null
}

const statusSchema = z.object({
  state: z.enum(['idle', 'starting', 'connected', 'reconnecting', 'driver-missing', 'device-missing', 'busy', 'error']),
  deviceName: z.string().nullable(),
  serialNumber: z.string().nullable(),
  firmware: z.string().nullable(),
  transport: z.enum(['usb-std', 'virtual-com']).nullable(),
  comPort: z.number().int().nullable(),
  lastSeenAt: z.string().nullable(),
  lastSyncAt: z.string().nullable(),
  pendingOutbox: z.number().int().nonnegative(),
  message: z.string().nullable()
})

function bridgePath(): string {
  const dev = join(app.getAppPath(), 'zkteco-bridge', 'bin', 'ZkTecoBridge.exe')
  const packaged = join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'zkteco', 'ZkTecoBridge.exe')
  return app.isPackaged ? packaged : dev
}

function scriptPath(name: string): string {
  const dev = join(app.getAppPath(), 'zkteco-bridge', name)
  const packaged = join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'zkteco', name)
  return app.isPackaged ? packaged : dev
}

function readSupabaseConfig(): { url: string; key: string } | null {
  try {
    const raw = JSON.parse(readFileSync(join(app.getPath('userData'), 'config.json'), 'utf-8')) as { supabaseUrl?: string; supabaseAnonKey?: string }
    if (!raw.supabaseUrl || !raw.supabaseAnonKey) return null
    return { url: raw.supabaseUrl.replace(/\/$/, ''), key: raw.supabaseAnonKey }
  } catch {
    return null
  }
}

async function hasDeviceManagePermission(accessToken: string): Promise<boolean> {
  const config = readSupabaseConfig()
  if (!config || !accessToken) return false
  const response = await fetch(`${config.url}/rest/v1/rpc/has_perm`, {
    method: 'POST',
    headers: {
      apikey: config.key,
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ p: 'device.manage' })
  })
  return response.ok && await response.json() === true
}

export function parseZkTecoStatus(raw: unknown): ZkTecoStatus | null {
  const parsed = statusSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

export class ZkTecoBridgeManager {
  private child: ReturnType<typeof spawn> | null = null
  private socket: Socket | null = null
  private buffer = ''
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()
  private sequence = 0
  private reconnectTimer: NodeJS.Timeout | null = null
  private stopping = false
  private status: ZkTecoStatus = { ...idleStatus }

  constructor(private readonly sendStatus: (status: ZkTecoStatus) => void) {}

  getStatus(): ZkTecoStatus {
    return { ...this.status }
  }

  private setStatus(next: Partial<ZkTecoStatus>): void {
    this.status = { ...this.status, ...next }
    this.sendStatus(this.getStatus())
  }

  start(): void {
    if (this.child || this.stopping) return
    const executable = bridgePath()
    if (!existsSync(executable)) {
      this.setStatus({ state: 'driver-missing', message: 'ZKTeco bridge is not installed' })
      return
    }
    this.stopping = false
    this.setStatus({ state: 'starting', message: null })
    this.child = spawn(executable, ['--pipe'], { windowsHide: true, stdio: 'ignore' })
    this.child.on('error', () => this.setStatus({ state: 'error', message: 'Could not start ZKTeco bridge' }))
    this.child.on('exit', (code) => {
      this.child = null
      this.disconnectSocket()
      if (!this.stopping) {
        if (code === 2) this.setStatus({ state: 'busy', message: 'Another ZKTeco bridge is already running' })
        this.scheduleReconnect()
      }
    })
    void this.connectPipe()
  }

  stop(): void {
    this.stopping = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.disconnectSocket()
    this.child?.kill()
    this.child = null
    this.setStatus({ state: 'idle', message: null })
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopping) return
    this.setStatus({ state: 'reconnecting', message: 'Waiting for ZKTeco bridge' })
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.stopping) return
      if (this.child) void this.connectPipe()
      else this.start()
    }, 3000)
  }

  private disconnectSocket(): void {
    this.socket?.destroy()
    this.socket = null
    this.buffer = ''
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('ZKTeco bridge disconnected'))
    }
    this.pending.clear()
  }

  private connectPipe(): void {
    if (this.socket && !this.socket.destroyed) return
    const socket = createConnection(PIPE_NAME)
    this.socket = socket
    socket.setEncoding('utf-8')
    socket.on('connect', () => {
      this.setStatus({ state: 'connected', message: null })
      void this.request('get_status').catch(() => undefined)
    })
    socket.on('data', (chunk: string) => this.handleData(chunk))
    socket.on('error', () => {
      if (!this.stopping) this.setStatus({ state: 'device-missing', message: 'ZKTeco device is unavailable' })
    })
    socket.on('close', () => {
      if (this.socket === socket) this.socket = null
      if (!this.stopping && this.child) this.scheduleReconnect()
    })
  }

  private handleData(chunk: string): void {
    this.buffer += chunk
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line) this.handleLine(line)
      newline = this.buffer.indexOf('\n')
    }
  }

  private handleLine(line: string): void {
    try {
      const message = JSON.parse(line) as { id?: string; type?: string; status?: unknown; ok?: boolean; error?: string }
      if (message.type === 'status' && message.status) {
        const parsed = parseZkTecoStatus(message.status)
        if (parsed) this.setStatus(parsed)
        return
      }
      if (!message.id) return
      const pending = this.pending.get(message.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(message.id)
      if (message.ok === false) pending.reject(new Error(message.error ?? 'ZKTeco bridge request failed'))
      else pending.resolve(message)
    } catch {
      this.setStatus({ state: 'error', message: 'Invalid ZKTeco bridge response' })
    }
  }

  private request(type: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    const socket = this.socket
    if (!socket || !socket.writable) return Promise.reject(new Error('ZKTeco bridge is not connected'))
    const id = `${Date.now()}-${++this.sequence}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('ZKTeco bridge request timed out'))
      }, 10_000)
      this.pending.set(id, { resolve, reject, timer })
      socket.write(`${JSON.stringify({ id, type, ...payload })}\n`)
    })
  }

  async health(): Promise<ZkTecoStatus> {
    try {
      const response = await this.request('get_health') as { status?: unknown }
      if (response.status) {
        const parsed = parseZkTecoStatus(response.status)
        if (parsed) this.setStatus(parsed)
      }
    } catch (error) {
      this.setStatus({ state: 'error', message: error instanceof Error ? error.message : 'ZKTeco health check failed' })
    }
    return this.getStatus()
  }

  async authorize(accessToken: string): Promise<boolean> {
    return hasDeviceManagePermission(accessToken)
  }

  async configure(supabaseUrl: string, deviceToken: string, timezone: string): Promise<ZkTecoServiceResult> {
    try {
      await this.request('configure', { supabaseUrl, deviceToken, timezone })
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'ZKTeco configuration failed' }
    }
  }

  async service(action: 'install' | 'start' | 'stop' | 'remove' | 'agent-install' | 'agent-remove', accessToken: string): Promise<ZkTecoServiceResult> {
    try {
      if (!await hasDeviceManagePermission(accessToken)) return { ok: false, error: 'FORBIDDEN' }
      const agent = action.startsWith('agent-')
      const script = scriptPath(agent ? 'install-logon-agent.ps1' : 'install-service.ps1')
      if (!existsSync(script)) return { ok: false, error: 'SERVICE_SCRIPT_MISSING' }
      const scriptAction = agent ? (action === 'agent-install' ? 'install' : 'remove') : action
      const verb = agent ? '' : ' -Verb RunAs'
      const command = `$ErrorActionPreference='Stop'; $p=Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','${script.replace(/'/g, "''")}','-Action','${scriptAction}')${verb} -Wait -PassThru; exit $p.ExitCode`
      const encoded = Buffer.from(command, 'utf16le').toString('base64')
      const exitCode = await new Promise<number>((resolve, reject) => {
        const child = spawn('powershell.exe', ['-NoProfile', '-EncodedCommand', encoded], { windowsHide: true, stdio: 'ignore' })
        child.on('error', reject)
        child.on('exit', (code) => resolve(code ?? 1))
      })
      return exitCode === 0 ? { ok: true } : { ok: false, error: `SERVICE_EXIT_${exitCode}` }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'SERVICE_ACTION_FAILED' }
    }
  }
}
