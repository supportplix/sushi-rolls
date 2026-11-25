import { z } from 'npm:zod@3.25.76'
import { createClient } from 'npm:@supabase/supabase-js@2.80.0'

export const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Device-Token, apikey',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
  Vary: 'Origin'
} as const

export const MAX_EVENTS = 500
export const MAX_COMMANDS = 50
export const MAX_BODY_BYTES = 1_048_576
export const RATE_LIMIT = 120
export const RATE_WINDOW_SECONDS = 60

// The fixed-window store is isolate-local. A single LX15 normally uses one
// isolate; a distributed quota requires a separately approved durable store.
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
    readonly retryAfter?: number
  ) {
    super(message ?? code)
    this.name = 'HttpError'
  }
}

export const json = (body: unknown, status = 200, extraHeaders: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      ...cors,
      ...extraHeaders,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  })

const uuid = z.string().uuid()
const trimmed = (min: number, max: number) => z.string().trim().min(min).max(max)
const sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'Expected lowercase SHA-256 hex')
const eventId = uuid.refine((value) => value === value.toLowerCase(), 'Event id must be lowercase UUID')

function containsForbiddenKey(value: unknown): boolean {
  const pending: unknown[] = [value]
  const seen = new WeakSet<object>()
  while (pending.length > 0) {
    const current = pending.pop()
    if (!current || typeof current !== 'object') continue
    if (seen.has(current)) continue
    seen.add(current)
    for (const [key, child] of Object.entries(current)) {
      if (/template|fingerprint|biometric/i.test(key)) return true
      pending.push(child)
    }
  }
  return false
}

const safeResult = z.record(z.unknown()).refine(
  (value) => !containsForbiddenKey(value),
  'Biometric payloads are forbidden'
)

const eventSchema = z.object({
  event_id: eventId,
  device_user_id: trimmed(1, 64),
  occurred_at: z.string().datetime({ offset: true }),
  device_timestamp: trimmed(1, 64),
  timezone: trimmed(1, 64).refine((value) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0)
      return true
    } catch {
      return false
    }
  }, 'Invalid IANA timezone'),
  verify_mode: z.number().int().min(0).max(255),
  raw_state: z.number().int().min(0).max(255),
  work_code: z.number().int().min(-2147483648).max(2147483647).nullable().optional(),
  payload_hash: sha256
}).strict()

const schemas = {
  heartbeat: z.object({
    action: z.literal('heartbeat'),
    device_time: z.string().datetime({ offset: true }).optional(),
    clock_drift_seconds: z.number().int().min(-86400).max(86400).optional(),
    bridge_version: trimmed(1, 64).optional()
  }).strict(),
  push_events: z.object({
    action: z.literal('push_events'),
    events: z.array(eventSchema).min(1).max(MAX_EVENTS)
  }).strict(),
  pull_commands: z.object({
    action: z.literal('pull_commands'),
    limit: z.number().int().min(1).max(MAX_COMMANDS).default(MAX_COMMANDS)
  }).strict(),
  complete_command: z.object({
    action: z.literal('complete_command'),
    command_id: uuid,
    idempotency_key: trimmed(1, 160),
    result: safeResult.optional()
  }).strict(),
  fail_command: z.object({
    action: z.literal('fail_command'),
    command_id: uuid,
    idempotency_key: trimmed(1, 160),
    error: trimmed(1, 2000)
  }).strict()
} as const

export type DeviceAction = keyof typeof schemas
export type DeviceRequest = z.infer<(typeof schemas)[DeviceAction]>

export function parseDeviceRequest(value: unknown): DeviceRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'INVALID_PAYLOAD')
  }
  const action = (value as Record<string, unknown>).action
  if (typeof action !== 'string' || !Object.hasOwn(schemas, action)) {
    throw new HttpError(400, 'UNKNOWN_ACTION')
  }
  const parsed = schemas[action as DeviceAction].safeParse(value)
  if (!parsed.success) throw new HttpError(400, 'INVALID_PAYLOAD')
  return parsed.data as DeviceRequest
}

export function readBearerToken(headers: Headers): string {
  // Only a random device credential is accepted; Supabase API keys/JWTs and
  // ambiguous combinations of credentials are rejected.
  const headerToken = headers.get('X-Device-Token')?.trim()
  const authorization = headers.get('Authorization')
  if (headerToken) {
    if (authorization) throw new HttpError(400, 'AMBIGUOUS_CREDENTIALS')
    if (headerToken.length < 32 || headerToken.length > 512) {
      throw new HttpError(401, 'INVALID_DEVICE_TOKEN')
    }
    return headerToken
  }
  const token = authorization?.match(/^Bearer ([^\s]+)$/i)?.[1]
  if (!token || token.length < 32 || token.length > 512 || token.includes('.')) {
    throw new HttpError(401, 'INVALID_DEVICE_TOKEN')
  }
  return token
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function constantTimeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a)
  const right = new TextEncoder().encode(b)
  let difference = left.length ^ right.length
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0)
  }
  return difference === 0
}

interface Device {
  id: string
  device_token_hash: string | null
  status: string
  timezone: string
}

type FilterValue = string | number
interface QueryResult {
  data: unknown
  error: { code?: string; message?: string } | null
}
export interface FilterBuilder {
  eq(column: string, value: FilterValue): FilterBuilder
  not(column: string, operator: string, value: string): FilterBuilder
  order(column: string, options: { ascending: boolean }): FilterBuilder
  select(columns: string): FilterBuilder
  limit(count: number): Promise<QueryResult>
  maybeSingle(): Promise<QueryResult>
}
export interface Database {
  from(table: string): {
    select(columns: string): FilterBuilder
    insert(values: unknown, options?: { onConflict: string; ignoreDuplicates: boolean }): {
      select(columns: string): FilterBuilder
    }
    update(values: Record<string, unknown>): FilterBuilder
  }
  rpc(name: string, args: Record<string, unknown>): Promise<QueryResult>
}

export interface RateLimitStore {
  get(deviceId: string, now: number): { count: number; resetAt: number }
}

export function createRestRateLimitStore(): RateLimitStore {
  const buckets = new Map<string, { count: number; resetAt: number }>()
  return {
    get(deviceId, now) {
      let current = buckets.get(deviceId)
      if (!current || current.resetAt <= now) {
        current = { count: 0, resetAt: now + RATE_WINDOW_SECONDS * 1000 }
        buckets.set(deviceId, current)
      }
      current.count += 1
      if (buckets.size > 2048) {
        for (const [key, bucket] of buckets) {
          if (bucket.resetAt <= now) buckets.delete(key)
        }
      }
      return current
    }
  }
}

export function rateLimit(store: RateLimitStore, deviceId: string, now = Date.now()): void {
  const { count, resetAt } = store.get(deviceId, now)
  if (count > RATE_LIMIT) {
    throw new HttpError(429, 'RATE_LIMITED', undefined, Math.max(1, Math.ceil((resetAt - now) / 1000)))
  }
}

export async function authenticate(db: Database, tokenHash: string): Promise<{ device: Device; tokenMatched: boolean }> {
  const result = await db.from('attendance_devices')
    .select('id, device_token_hash, status, timezone')
    .eq('device_token_hash', tokenHash)
    .maybeSingle()
  if (result.error) throw new HttpError(500, 'DATABASE_ERROR')
  const device = result.data as Device | null
  if (!device?.device_token_hash || !constantTimeEqual(tokenHash, device.device_token_hash) || device.status === 'disabled') {
    return { device: { id: '', device_token_hash: null, status: 'disabled', timezone: '' }, tokenMatched: false }
  }
  return { device, tokenMatched: true }
}

function responseData<T>(result: QueryResult): T {
  if (result.error) throw rpcError(result.error)
  return result.data as T
}

function rpcError(error: { code?: string; message?: string } | null): HttpError {
  const code = error?.code ?? ''
  const message = error?.message ?? ''
  if (code === '42501' || code.startsWith('28') || message.includes('PERMISSION_DENIED')) {
    return new HttpError(403, 'PERMISSION_DENIED')
  }
  if (code === 'P0002' || code === 'PGRST116') return new HttpError(404, 'NOT_FOUND')
  if (code === 'P0004') return new HttpError(409, 'COMMAND_STATE_CONFLICT')
  if (code === '23505') return new HttpError(409, 'EVENT_OR_COMMAND_CONFLICT')
  if (code === '23514' || code === '22023' || code === '22P02') return new HttpError(400, 'INVALID_PAYLOAD')
  if (code === '40001' || code === '40P01') return new HttpError(503, 'TEMPORARY_CONFLICT', undefined, 2)
  return new HttpError(500, 'DATABASE_ERROR')
}

async function heartbeat(db: Database, deviceId: string, request: Extract<DeviceRequest, { action: 'heartbeat' }>) {
  let drift = request.clock_drift_seconds ?? null
  if (drift === null && request.device_time) {
    drift = Math.max(-86400, Math.min(86400, Math.round((Date.parse(request.device_time) - Date.now()) / 1000)))
  }
  const seenAt = new Date().toISOString()
  const data = responseData<{ id: string; timezone: string } | null>(await db.from('attendance_devices')
    .update({ last_seen_at: seenAt, clock_drift_seconds: drift, status: 'online', updated_at: seenAt })
    .eq('id', deviceId)
    .select('id, timezone')
    .maybeSingle())
  if (!data) throw new HttpError(404, 'DEVICE_NOT_FOUND')
  // The approved schema has no bridge-version column. Echo it without storing.
  return { ok: true, last_seen_at: seenAt, clock_drift_seconds: drift, bridge_version: request.bridge_version ?? null, timezone: data.timezone }
}

interface EventRow {
  event_id: string
  resolution_status: string
  resolved_kind: string | null
  attendance_id: string | null
  replayed: boolean
}

async function applyPendingEvents(db: Database, deviceId: string): Promise<EventRow[]> {
  const pending = responseData<Array<{ id: string; occurred_at: string }>>(await db.from('attendance_events')
    .select('id, occurred_at')
    .eq('device_id', deviceId)
    .eq('resolution_status', 'pending')
    .order('occurred_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(MAX_EVENTS))
  if (!Array.isArray(pending)) throw new HttpError(500, 'INVALID_DATABASE_RESULT')
  pending.sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at) || a.id.localeCompare(b.id))
  const results: EventRow[] = []
  for (const event of pending) {
    const result = responseData<EventRow>(await db.rpc('apply_attendance_event', { p_event_id: event.id }))
    if (!result || result.event_id !== event.id) throw new HttpError(500, 'INVALID_RPC_RESULT')
    results.push(result)
  }
  return results
}

async function pushEvents(
  db: Database,
  deviceId: string,
  request: Extract<DeviceRequest, { action: 'push_events' }>
) {
  const events = [...request.events].sort((a, b) =>
    Date.parse(a.occurred_at) - Date.parse(b.occurred_at) || a.event_id.localeCompare(b.event_id)
  )
  const seenHashes = new Set<string>()
  const seenIds = new Set<string>()
  for (const event of events) {
    if (seenHashes.has(event.payload_hash) || seenIds.has(event.event_id)) {
      throw new HttpError(400, 'DUPLICATE_EVENT_IN_BATCH')
    }
    seenHashes.add(event.payload_hash)
    seenIds.add(event.event_id)
  }
  const rows = events.map((event) => ({
    id: event.event_id,
    device_id: deviceId,
    device_user_id: event.device_user_id,
    occurred_at: event.occurred_at,
    device_timestamp: event.device_timestamp,
    timezone: event.timezone,
    verify_mode: event.verify_mode,
    raw_state: event.raw_state,
    work_code: event.work_code ?? null,
    payload_hash: event.payload_hash,
    resolution_status: 'pending'
  }))
  const inserted = responseData<Array<{ id: string }>>(await db.from('attendance_events')
    .insert(rows, { onConflict: 'device_id,payload_hash', ignoreDuplicates: true })
    .select('id')
    .limit(MAX_EVENTS))
  if (!Array.isArray(inserted)) throw new HttpError(500, 'INVALID_DATABASE_RESULT')

  // A failed previous call may have committed the raw insert but not its RPC.
  // Re-reading pending rows heals that state, oldest first, without replaying
  // resolved events. Drain the backlog before acknowledging the outbox; if it
  // exceeds five batches, return 503 so the bridge retains and retries its data.
  const results: EventRow[] = []
  for (let batch = 0; batch < 5; batch += 1) {
    const applied = await applyPendingEvents(db, deviceId)
    results.push(...applied)
    if (applied.length < MAX_EVENTS) break
    if (batch === 4) throw new HttpError(503, 'PENDING_EVENTS_REMAIN', undefined, 2)
  }
  responseData<unknown>(await db.from('attendance_devices')
    .update({ last_sync_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', deviceId)
    .select('id')
    .maybeSingle())
  return {
    ok: true,
    inserted: inserted.length,
    duplicates: events.length - inserted.length,
    events: results
  }
}

interface CommandRow {
  id: string
  type: string
  employee_id: string | null
  payload: Record<string, unknown>
  idempotency_key: string
  attempts: number
}

async function pullCommands(db: Database, deviceId: string, request: Extract<DeviceRequest, { action: 'pull_commands' }>) {
  const commands = responseData<CommandRow[]>(await db.rpc('zkteco_claim_commands', {
    p_device_id: deviceId,
    p_limit: request.limit
  }))
  if (!Array.isArray(commands)) throw new HttpError(500, 'INVALID_DATABASE_RESULT')
  return {
    ok: true,
    commands: commands.map(({ id, type, payload, idempotency_key }) => ({ id, type, payload, idempotency_key }))
  }
}

interface CommandResult {
  ok: boolean
  command_id: string
  status: string
  replayed: boolean
}

async function finishCommand(
  db: Database,
  deviceId: string,
  request: Extract<DeviceRequest, { action: 'complete_command' | 'fail_command' }>
) {
  const completed = request.action === 'complete_command'
  const result = responseData<CommandResult>(await db.rpc('zkteco_finish_command', {
    p_command_id: request.command_id,
    p_device_id: deviceId,
    p_idempotency_key: request.idempotency_key,
    p_status: completed ? 'completed' : 'failed',
    p_error: completed ? null : request.error
  }))
  if (!result || result.command_id !== request.command_id || result.status !== (completed ? 'completed' : 'failed')) {
    throw new HttpError(500, 'INVALID_RPC_RESULT')
  }
  // The optional non-biometric result is deliberately not persisted or logged.
  return result
}

function serviceClient(): Database | null {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const secret = Deno.env.get('SUPABASE_SECRET_KEYS') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !secret) return null
  let serviceKey = secret
  if (secret.trim().startsWith('{')) {
    try {
      const keys = JSON.parse(secret) as Record<string, unknown>
      serviceKey = typeof keys.default === 'string' ? keys.default : ''
    } catch {
      return null
    }
  }
  if (!serviceKey) return null
  return createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  }) as unknown as Database
}

async function readJsonBody(request: Request): Promise<unknown> {
  const declaredLength = Number(request.headers.get('Content-Length') ?? 0)
  if (declaredLength > MAX_BODY_BYTES) throw new HttpError(413, 'PAYLOAD_TOO_LARGE')
  if (!request.body) throw new HttpError(400, 'INVALID_JSON')
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BODY_BYTES) throw new HttpError(413, 'PAYLOAD_TOO_LARGE')
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new HttpError(400, 'INVALID_JSON')
  }
}

export interface HandlerOptions {
  db?: Database
  rateStore?: RateLimitStore
  now?: () => number
}

export function createHandler(options: HandlerOptions = {}) {
  const store = options.rateStore ?? createRestRateLimitStore()
  const now = options.now ?? Date.now
  return async (request: Request): Promise<Response> => {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
    if (request.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED' }, 405, { Allow: 'POST, OPTIONS' })
    try {
      const token = readBearerToken(request.headers)
      const tokenHash = await hashToken(token)
      const db = options.db ?? serviceClient()
      if (!db) return json({ error: 'SERVER_NOT_CONFIGURED' }, 500)
      const auth = await authenticate(db, tokenHash)
      if (!auth.tokenMatched) return json({ error: 'INVALID_DEVICE_TOKEN' }, 401)
      rateLimit(store, auth.device.id, now())
      const parsed = parseDeviceRequest(await readJsonBody(request))
      switch (parsed.action) {
        case 'heartbeat':
          return json(await heartbeat(db, auth.device.id, parsed))
        case 'push_events':
          return json(await pushEvents(db, auth.device.id, parsed))
        case 'pull_commands':
          return json(await pullCommands(db, auth.device.id, parsed))
        case 'complete_command':
        case 'fail_command':
          return json(await finishCommand(db, auth.device.id, parsed))
      }
    } catch (error) {
      if (error instanceof HttpError) {
        return json({ error: error.code }, error.status, error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {})
      }
      // Never log request bodies, bearer tokens, command payloads, or DB errors.
      console.error('device-sync internal error', error instanceof Error ? error.name : 'UnknownError')
      return json({ error: 'INTERNAL_ERROR' }, 500)
    }
  }
}

const handler = createHandler()

if (import.meta.main) {
  // Deployment requires [functions.device-sync] verify_jwt = false: the bearer
  // credential is a random device token, not a Supabase JWT.
  Deno.serve(handler)
}

export default handler
