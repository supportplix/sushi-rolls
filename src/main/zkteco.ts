import { app } from 'electron'
import { spawn, execFileSync } from 'child_process'
import { createConnection, Socket } from 'net'
import { join } from 'path'
import { existsSync, readFileSync, appendFileSync } from 'fs'
import { z } from 'zod'
import type { ZkTecoEnrollArgs, ZkTecoEnrollResult, ZkTecoServiceResult, ZkTecoStatus } from '@shared/ipc'

const PIPE_NAME = '\\\\.\\pipe\\SushiRolls.ZkTeco'

function diag(message: string): void {
  try {
    appendFileSync(join(app.getPath('userData'), 'zk-diag.log'), `${new Date().toISOString()} ${message}\n`)
  } catch {
    // diagnostics are best-effort
  }
}

type ServiceState = 'running' | 'pending' | 'stopped' | 'absent'

/**
 * The LX15 allows a single SDK handle. When the service exists we normally attach
 * to its pipe instead of spawning a competing bridge.
 */
function serviceState(): ServiceState {
  try {
    const output = execFileSync('sc.exe', ['query', 'SushiRolls.ZkTeco'], { encoding: 'utf8' })
    if (/STATE\s*:\s*4\s+RUNNING/.test(output)) return 'running'
    if (/STATE\s*:\s*[2356]\s+/.test(output)) return 'pending'
    return 'stopped'
  } catch {
    return 'absent'
  }
}
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
  message: null,
  enrollmentCommandId: null,
  enrollmentDeviceUserId: null,
  enrollmentStatus: null,
  enrollmentMessage: null,
  enrollmentUpdatedAt: null
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
  message: z.string().nullable(),
  enrollmentCommandId: z.string().nullable().optional(),
  enrollmentDeviceUserId: z.string().nullable().optional(),
  enrollmentStatus: z.enum(['starting', 'awaiting_scan', 'scanning', 'enrolled', 'failed', 'timed_out', 'completed', 'cancelled']).nullable().optional(),
  enrollmentMessage: z.string().nullable().optional(),
  enrollmentUpdatedAt: z.string().nullable().optional(),
  users: z.number().int().nullable().optional(),
  fingerprints: z.number().int().nullable().optional(),
  records: z.number().int().nullable().optional()
})
const serviceResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional()
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
  private pipeAttempts = 0
  private suppressExit = false
  private status: ZkTecoStatus = { ...idleStatus }

  constructor(private readonly sendStatus: (status: ZkTecoStatus) => void) {}

  getStatus(): ZkTecoStatus {
    return { ...this.status }
  }

  private setStatus(next: Partial<ZkTecoStatus>): void {
    this.status = { ...this.status, ...next }
    this.sendStatus(this.getStatus())
  }

  private probePipe(): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = createConnection(PIPE_NAME)
      let finished = false
      const finish = (ok: boolean): void => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        socket.destroy()
        resolve(ok)
      }
      const timer = setTimeout(() => finish(false), 1500)
      socket.on('connect', () => finish(true))
      socket.on('error', () => finish(false))
    })
  }

  async start(): Promise<void> {
    diag('start called')
    if (this.child || this.stopping) return
    const service = serviceState()
    if (service === 'running' || service === 'pending') {
      // A RUNNING service does not guarantee a live worker: if its pipe is
      // missing the service is a zombie and nobody is serving the device.
      // Probe first so we can recover instead of waiting forever.
      const pipeUp = service === 'running' ? await this.probePipe() : false
      if (pipeUp) {
        diag('service owns device; attaching to its pipe')
        this.setStatus({ state: 'starting', message: null })
        this.pipeAttempts = 0
        this.connectPipe()
        return
      }
      diag(`service ${service} without a pipe; waiting for it`)
      this.setStatus({ state: 'starting', message: null })
      this.connectPipe()
      return
    }
    this.spawnChild()
  }

  private spawnChild(): void {
    if (this.child || this.stopping) return
    const executable = bridgePath()
    if (!existsSync(executable)) {
      this.setStatus({ state: 'driver-missing', message: 'ZKTeco bridge is not installed' })
      return
    }
    this.setStatus({ state: 'starting', message: null })
    diag('spawning child bridge')
    this.pipeAttempts = 0
    const child = spawn(executable, ['--pipe'], { windowsHide: true, stdio: 'ignore' })
    this.child = child
    child.on('error', () => this.setStatus({ state: 'error', message: 'Could not start ZKTeco bridge' }))
    child.on('exit', (code) => {
      diag(`child exited code=${code}`)
      if (this.child === child) this.child = null
      this.disconnectSocket()
      if (this.suppressExit) {
        this.suppressExit = false
        return
      }
      if (this.stopping) return
      if (code === 2) {
        // The Windows service already owns the device. Attach to its pipe
        // instead of retrying to spawn another bridge forever.
        this.setStatus({ state: 'reconnecting', message: 'Waiting for ZKTeco bridge' })
        setTimeout(() => { if (!this.stopping) this.connectPipe() }, 400)
      } else this.scheduleReconnect()
    })
    void this.connectPipe()
  }

  /** Stops the app-owned bridge so a freshly started service can take the device. */
  private handOffToService(): void {
    if (!this.child) {
      this.setStatus({ state: 'starting', message: null })
      this.pipeAttempts = 0
      this.connectPipe()
      return
    }
    diag('handing device to the service')
    const child = this.child
    this.child = null
    this.suppressExit = true
    this.disconnectSocket()
    try {
      child.kill()
    } catch {
      this.suppressExit = false
    }
    this.pipeAttempts = 0
    this.setStatus({ state: 'starting', message: null })
    // The service retries a BUSY worker every 5 seconds. Give it one full
    // retry cycle before we try to attach to its pipe.
    setTimeout(() => { if (!this.stopping) this.connectPipe() }, 6000)
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
      if (this.child) {
        void this.connectPipe()
        return
      }
      const service = serviceState()
      if (service === 'running' || service === 'pending') {
        if (service === 'running' && this.pipeAttempts >= 3) {
          // The service reports RUNNING but never exposed its pipe (stale
          // worker). Try to take the device ourselves. If the service really
          // owns it, the child exits with code 2 and we re-attach.
          diag('service pipe unavailable; spawning fallback bridge')
          this.pipeAttempts = 0
          this.spawnChild()
        } else {
          void this.connectPipe()
        }
        return
      }
      this.start()
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
    diag(`connectPipe existing=${!!this.socket}`)
    if (this.socket && !this.socket.destroyed) return
    const socket = createConnection(PIPE_NAME)
    this.socket = socket
    socket.setEncoding('utf-8')
    socket.on('connect', () => {
      this.pipeAttempts = 0
      this.setStatus({ state: 'connected', message: null })
      void this.request('get_status').catch(() => undefined)
    })
    socket.on('data', (chunk: string) => this.handleData(chunk))
    socket.on('error', () => {
      this.pipeAttempts += 1
      if (!this.stopping) this.setStatus({ state: 'device-missing', message: 'ZKTeco device is unavailable' })
    })
    socket.on('close', () => {
      if (this.socket === socket) this.socket = null
      if (!this.stopping) this.scheduleReconnect()
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

  async enroll(args: ZkTecoEnrollArgs): Promise<ZkTecoEnrollResult> {
    if (!await hasDeviceManagePermission(args.accessToken)) return { ok: false, error: 'FORBIDDEN' }
    try {
      const response = await this.request(args.watchOnly ? 'watch_enrollment' : 'enroll', {
        deviceUserId: args.deviceUserId,
        name: args.name,
        timeoutSeconds: args.timeoutSeconds ?? 60
      }) as { ok?: boolean; commandId?: string; error?: string }
      if (response.ok === false) return { ok: false, error: response.error ?? 'ENROLL_FAILED' }
      return { ok: true, commandId: response.commandId ?? '' }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'ENROLL_FAILED' }
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
      // The installed path contains spaces. Pass the inner script as an encoded
      // command so PowerShell never splits it into separate arguments.
      const inner = `& '${script.replace(/'/g, "''")}' -Action '${scriptAction}'; exit $LASTEXITCODE`
      const innerEncoded = Buffer.from(inner, 'utf16le').toString('base64')
      const command = `$ErrorActionPreference='Stop'; $p=Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','${innerEncoded}')${verb} -Wait -PassThru; exit $p.ExitCode`
      const encoded = Buffer.from(command, 'utf16le').toString('base64')
      let stderr = ''
      const exitCode = await new Promise<number>((resolve, reject) => {
        const child = spawn('powershell.exe', ['-NoProfile', '-EncodedCommand', encoded], {
          windowsHide: true,
          stdio: ['ignore', 'ignore', 'pipe']
        })
        child.stderr?.setEncoding('utf8')
        child.stderr?.on('data', (chunk: string) => { stderr += chunk })
        child.on('error', reject)
        child.on('close', (code) => resolve(code ?? 1))
      })
      if (exitCode !== 0) return { ok: false, error: `SERVICE_EXIT_${exitCode}` }
      if (action === 'start' || action === 'install') {
        // The service now owns the device. Release the app bridge so the
        // service worker can acquire the device mutex and open its pipe.
        this.handOffToService()
      } else if (action === 'stop' || action === 'remove') {
        this.setStatus({ state: 'starting', message: null })
        this.start()
      }
      return { ok: true }
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Unknown service action failure'
      return { ok: false, error: `SERVICE_ACTION_FAILED: ${detail}` }
    }
  }
}
