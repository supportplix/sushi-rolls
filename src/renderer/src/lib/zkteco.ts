import type { SupabaseClient } from '@supabase/supabase-js'
import type { ZkTecoStatus } from '@shared/ipc'
import { api } from '@/lib/ipc'

export interface AttendanceDevice {
  id: string
  name: string
  serial_number: string | null
  usb_vid: string
  usb_pid: string
  status: string
  background_mode: 'app_only' | 'logon_agent' | 'windows_service'
  attendance_mode: 'alternating' | 'device_state' | 'raw_only'
  timezone: string
  device_token_hash: string | null
  last_seen_at: string | null
  last_sync_at: string | null
  clock_drift_seconds: number | null
}

export interface EmployeeDevice {
  id: string
  employee_id: string
  device_id: string
  device_user_id: string
  enrollment_status: 'pending' | 'awaiting_scan' | 'scanning' | 'enrolled' | 'failed' | 'disabled'
  enrolled_at: string | null
  last_synced_at: string | null
  disabled_at: string | null
}

export interface DeviceCommand {
  id: string
  employee_id: string | null
  type: string
  status: string
  attempts: number
  last_error: string | null
  created_at: string
  processed_at: string | null
}

function isMissingZktecoTable(error: unknown): boolean {
  return (error as { code?: string })?.code === 'PGRST205'
}

export async function listDevices(db: SupabaseClient): Promise<AttendanceDevice[]> {
  const { data, error } = await db.from('attendance_devices').select('*').order('created_at')
  if (error) throw error
  return (data ?? []) as AttendanceDevice[]
}

export async function listEmployeeDevices(db: SupabaseClient): Promise<EmployeeDevice[]> {
  const { data, error } = await db.from('employee_devices').select('*').order('id')
  if (error) throw error
  return (data ?? []) as EmployeeDevice[]
}

export async function listCommands(db: SupabaseClient): Promise<DeviceCommand[]> {
  const { data, error } = await db
    .from('device_commands')
    .select('id,employee_id,type,status,attempts,last_error,created_at,processed_at')
    .order('created_at', { ascending: false })
    .limit(200)
  if (error) throw error
  return (data ?? []) as DeviceCommand[]
}

export async function enqueueEmployeeCommand(
  db: SupabaseClient,
  employeeId: string,
  type: 'create_user' | 'update_user' | 'start_enrollment' | 'disable_user' | 'delete_user',
  idempotencyKey: string,
  deviceUserId?: string
): Promise<string> {
  const { data, error } = await db.rpc('zkteco_enroll_employee', {
    p_employee_id: employeeId,
    p_type: type,
    p_idempotency_key: idempotencyKey,
    p_device_user_id: deviceUserId ?? null,
    p_payload: {}
  })
  if (error) {
    if ((error as { code?: string }).code === 'PGRST202') throw new Error('ZKTECO_SCHEMA_NOT_DEPLOYED')
    throw error
  }
  const commandId = String(data?.id ?? '')
  if (!commandId) throw new Error('DEVICE_COMMAND_MISSING')
  return commandId
}

export async function startEnrollment(db: SupabaseClient, employeeId: string): Promise<string> {
  const deviceStatus = await api.zkteco.health()
  if (deviceStatus.state !== 'connected') {
    throw new Error(deviceStatus.message ?? 'DEVICE_NOT_CONNECTED')
  }

  const createKey = `create-${employeeId}-${Date.now()}`
  const createCommandId = await enqueueEmployeeCommand(db, employeeId, 'create_user', createKey)
  await waitForDeviceCommand(db, createCommandId, false)

  const enrollmentCommandId = await enqueueEmployeeCommand(
    db,
    employeeId,
    'start_enrollment',
    `enroll-${employeeId}-${Date.now()}`
  )
  return enrollmentCommandId
}

async function waitForDeviceCommand(
  db: SupabaseClient,
  commandId: string,
  waitForProcessing: boolean
): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const { data: command, error } = await db
      .from('device_commands')
      .select('status,last_error')
      .eq('id', commandId)
      .maybeSingle()
    if (error) throw error
    if (!command) throw new Error('DEVICE_COMMAND_NOT_FOUND')
    if (command.status === 'failed' || command.status === 'timed_out') {
      throw new Error(command.last_error ?? 'DEVICE_COMMAND_FAILED')
    }
    if (command.status === 'completed' || (waitForProcessing && command.status === 'processing')) return
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  throw new Error(waitForProcessing ? 'DEVICE_COMMAND_NOT_DISPATCHED' : 'DEVICE_COMMAND_TIMEOUT')
}

/**
 * Starts fingerprint enrollment directly on the connected LX15 and returns the
 * command id used to stream every step back to the UI through zkteco:status.
 */
export async function enrollFingerprintLive(
  db: SupabaseClient,
  employeeId: string,
  name: string,
  timeoutSeconds = 300
): Promise<string> {
  const { data: session } = await db.auth.getSession()
  const accessToken = session.session?.access_token
  if (!accessToken) throw new Error('NO_SESSION')

  let mapping = await db
    .from('employee_devices')
    .select('device_user_id')
    .eq('employee_id', employeeId)
    .maybeSingle()
  if (mapping.error) throw mapping.error

  if (!mapping.data?.device_user_id) {
    await enqueueEmployeeCommand(db, employeeId, 'create_user', `create-live-${employeeId}-${Date.now()}`)
    for (let attempt = 0; attempt < 40; attempt += 1) {
      mapping = await db
        .from('employee_devices')
        .select('device_user_id')
        .eq('employee_id', employeeId)
        .maybeSingle()
      if (mapping.error) throw mapping.error
      if (mapping.data?.device_user_id) break
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  const deviceUserId = mapping.data?.device_user_id
  if (!deviceUserId) throw new Error('DEVICE_MAPPING_MISSING')

  await db.rpc('zkteco_update_enrollment', { p_employee_id: employeeId, p_status: 'awaiting_scan' })
  const result = await api.zkteco.enroll({
    deviceUserId,
    name,
    timeoutSeconds,
    watchOnly: true,
    accessToken
  })
  if (!result.ok) throw new Error(result.error ?? 'ENROLL_FAILED')
  return result.commandId ?? ''
}

/** Streams bridge enrollment steps and persists the terminal state in Supabase. */
export function watchLiveEnrollment(
  db: SupabaseClient,
  employeeId: string,
  commandId: string,
  onUpdate: (status: ZkTecoStatus) => void
): () => void {
  let finished = false
  return api.zkteco.onStatus((status) => {
    if (status.enrollmentCommandId !== commandId) return
    onUpdate(status)
    const step = status.enrollmentStatus
    if (finished || !step) return
    const terminal = step === 'enrolled' || step === 'completed' || step === 'failed' || step === 'timed_out'
    if (!terminal) return
    finished = true
    void db.rpc('zkteco_update_enrollment', {
      p_employee_id: employeeId,
      p_status: step === 'enrolled' || step === 'completed' ? 'enrolled' : 'failed'
    })
  })
}

export async function deleteEmployeeWithDevice(db: SupabaseClient, employeeId: string): Promise<void> {
  const { data: mapping, error: mappingError } = await db
    .from('employee_devices')
    .select('id')
    .eq('employee_id', employeeId)
    .maybeSingle()
  if (mappingError && !isMissingZktecoTable(mappingError)) throw mappingError

  if (mapping) {
    const commandId = await enqueueEmployeeCommand(db, employeeId, 'delete_user', `delete-${employeeId}-${Date.now()}`)
    if (!commandId) throw new Error('DEVICE_DELETE_COMMAND_MISSING')
    let completed = false
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const { data: command, error } = await db
        .from('device_commands')
        .select('status,last_error')
        .eq('id', commandId)
        .maybeSingle()
      if (error) throw error
      if (command?.status === 'completed') {
        completed = true
        break
      }
      if (command?.status === 'failed') throw new Error(command.last_error ?? 'DEVICE_DELETE_FAILED')
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    if (!completed) throw new Error('DEVICE_DELETE_TIMEOUT')
  }

  const { error } = await db.from('employees').delete().eq('id', employeeId)
  if (error) throw error
}

export async function updateDevice(
  db: SupabaseClient,
  deviceId: string,
  patch: Partial<Pick<AttendanceDevice, 'name' | 'attendance_mode' | 'background_mode' | 'timezone'>>
): Promise<void> {
  const { error } = await db.rpc('zkteco_upsert_device', {
    p_device: { id: deviceId, ...patch },
    p_token_hash: null
  })
  if (error) throw error
}

export function createDeviceToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function hashDeviceToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function configureBridge(
  db: SupabaseClient,
  supabaseUrl: string,
  deviceToken: string,
  timezone: string
): Promise<void> {
  const { data } = await db.auth.getSession()
  const accessToken = data.session?.access_token
  if (!accessToken) throw new Error('NO_SESSION')
  const result = await api.zkteco.configure({ supabaseUrl, deviceToken, timezone, accessToken })
  if (!result.ok) throw new Error(result.error ?? 'BRIDGE_CONFIG_FAILED')
}

export async function createOrRotateDevice(
  db: SupabaseClient,
  supabaseUrl: string,
  existing: AttendanceDevice | null
): Promise<void> {
  const token = createDeviceToken()
  const tokenHash = await hashDeviceToken(token)
  const { error } = await db.rpc('zkteco_upsert_device', {
    p_device: existing
      ? { id: existing.id }
      : { name: 'ZKTeco LX15', usb_vid: '1B55', usb_pid: '0A01', timezone: 'Africa/Cairo' },
    p_token_hash: tokenHash
  })
  if (error) throw error
  try
  {
    await configureBridge(db, supabaseUrl, token, existing?.timezone ?? 'Africa/Cairo')
  }
  catch (configureError)
  {
    if (existing)
    {
      await db.rpc('zkteco_upsert_device', {
        p_device: { id: existing.id },
        p_token_hash: existing.device_token_hash
      })
    }
    throw configureError
  }
}

export async function revokeDeviceToken(db: SupabaseClient, deviceId: string): Promise<void> {
  const { error } = await db.rpc('zkteco_upsert_device', {
    p_device: { id: deviceId, revoke_token: true },
    p_token_hash: null
  })
  if (error) throw error
}
