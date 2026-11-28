import { assertEquals, assertExists, assertThrows } from 'jsr:@std/assert@1.0.19'
import {
  constantTimeEqual,
  createHandler,
  createRestRateLimitStore,
  hashToken,
  HttpError,
  MAX_BODY_BYTES,
  MAX_COMMANDS,
  MAX_EVENTS,
  parseDeviceRequest,
  RATE_LIMIT,
  readBearerToken,
  type Database,
  type DeviceRequest,
  type FilterBuilder
} from './index.ts'

const DEVICE_ID = '30000000-0000-4000-8000-000000000001'
const OTHER_DEVICE_ID = '30000000-0000-4000-8000-000000000002'
const EMPLOYEE_ID = '20000000-0000-4000-8000-000000000001'
const COMMAND_ONE = '60000000-0000-4000-8000-000000000001'
const COMMAND_TWO = '60000000-0000-4000-8000-000000000002'
const COMMAND_OTHER = '60000000-0000-4000-8000-000000000003'
const VALID_TOKEN = 'zkteco-test-token-0123456789-abcdefghijklmnopqrstuvwxyz'
const VALID_HASH = await hashToken(VALID_TOKEN)
const OTHER_HASH = await hashToken('another-device-token-0123456789-abcdefghijklmnopqrstuvwxyz')

type Row = Record<string, unknown>
interface StoredEvent extends Row {
  id: string
  device_id: string
  device_user_id: string
  occurred_at: string
  payload_hash: string
  resolution_status: string
}
interface StoredCommand extends Row {
  id: string
  device_id: string
  employee_id: string | null
  type: string
  payload: Record<string, unknown>
  idempotency_key: string
  status: string
  attempts: number
  lease_expires_at?: string
  created_at: string
}
interface QueryResult {
  data: unknown
  error: { code?: string; message?: string } | null
}

function result(data: unknown, error: QueryResult['error'] = null): QueryResult {
  return { data, error }
}

interface FakeState {
  devices: Row[]
  events: StoredEvent[]
  commands: StoredCommand[]
  mappings: Row[]
  rpcCalls: Array<{ name: string; args: Record<string, unknown> }>
  failApplyOnce: string | null
}

class FakeQuery implements FilterBuilder {
  private filters = new Map<string, string | number>()
  private excluded = new Map<string, string[]>()
  private orders: Array<{ column: string; ascending: boolean }> = []
  private columns = '*'
  constructor(
    private readonly state: FakeState,
    private readonly table: string,
    private readonly operation: 'select' | 'insert' | 'update',
    private readonly input?: unknown,
    private readonly insertOptions?: { onConflict: string; ignoreDuplicates: boolean }
  ) {}

  select(columns: string): FilterBuilder {
    this.columns = columns
    return this
  }

  eq(column: string, value: string | number): FilterBuilder {
    this.filters.set(column, value)
    return this
  }

  not(column: string, _operator: string, value: string): FilterBuilder {
    this.excluded.set(column, value.replace(/[()]/g, '').split(',').map((entry) => entry.trim()))
    return this
  }

  order(column: string, options: { ascending: boolean }): FilterBuilder {
    this.orders.push({ column, ascending: options.ascending })
    return this
  }

  private rows(): Row[] {
    if (this.table === 'attendance_devices') return this.state.devices
    if (this.table === 'attendance_events') return this.state.events
    if (this.table === 'device_commands') return this.state.commands
    if (this.table === 'employee_devices') return this.state.mappings
    throw new Error(`Unexpected table ${this.table}`)
  }

  private matches(row: Row): boolean {
    return [...this.filters].every(([column, value]) => row[column] === value)
      && [...this.excluded].every(([column, values]) => !values.includes(String(row[column])))
  }

  private project(row: Row): Row {
    if (this.columns === '*') return { ...row }
    return Object.fromEntries(this.columns.split(',').map((column) => {
      const name = column.trim()
      return [name, row[name]]
    }))
  }

  private execute(limit = Number.POSITIVE_INFINITY): QueryResult {
    let rows = this.rows()
    if (this.operation === 'insert') {
      const input = (Array.isArray(this.input) ? this.input : [this.input]) as Row[]
      const added: Row[] = []
      const conflictColumns = this.insertOptions?.onConflict.split(',') ?? []
      for (const row of input) {
        if (this.insertOptions?.ignoreDuplicates && rows.some((existing) =>
          conflictColumns.every((column) => existing[column] === row[column])
        )) continue
        if (rows.some((existing) => existing.id === row.id)) {
          return result(null, { code: '23505' })
        }
        rows.push(row)
        added.push(row)
      }
      rows = added
    } else if (this.operation === 'update') {
      rows = rows.filter((row) => this.matches(row))
      for (const row of rows) Object.assign(row, this.input)
    } else {
      rows = rows.filter((row) => this.matches(row))
    }
    for (const order of [...this.orders].reverse()) {
      rows = [...rows].sort((left, right) => {
        const comparison = String(left[order.column] ?? '').localeCompare(String(right[order.column] ?? ''))
        return order.ascending ? comparison : -comparison
      })
    }
    return result(rows.slice(0, limit).map((row) => this.project(row)))
  }

  limit(count: number): Promise<QueryResult> {
    return Promise.resolve(this.execute(count))
  }

  maybeSingle(): Promise<QueryResult> {
    const executed = this.execute(1)
    return Promise.resolve(Array.isArray(executed.data)
      ? result(executed.data[0] ?? null, executed.error)
      : executed)
  }
}

function fakeDatabase(): { db: Database; state: FakeState } {
  const state: FakeState = {
    devices: [
      { id: DEVICE_ID, device_token_hash: VALID_HASH, status: 'offline', timezone: 'Africa/Cairo' },
      { id: OTHER_DEVICE_ID, device_token_hash: OTHER_HASH, status: 'offline', timezone: 'Africa/Cairo' }
    ],
    events: [],
    commands: [
      { id: COMMAND_ONE, device_id: DEVICE_ID, employee_id: EMPLOYEE_ID, type: 'start_enrollment', payload: {}, idempotency_key: 'one', status: 'pending', attempts: 0, created_at: '2026-11-24T03:00:00Z' },
      { id: COMMAND_TWO, device_id: DEVICE_ID, employee_id: EMPLOYEE_ID, type: 'create_user', payload: {}, idempotency_key: 'two', status: 'pending', attempts: 0, created_at: '2026-11-24T01:00:00Z' },
      { id: COMMAND_OTHER, device_id: OTHER_DEVICE_ID, employee_id: null, type: 'create_user', payload: {}, idempotency_key: 'other', status: 'pending', attempts: 0, created_at: '2026-11-24T00:00:00Z' }
    ],
    mappings: [{ employee_id: EMPLOYEE_ID, device_id: DEVICE_ID, enrollment_status: 'pending' }],
    rpcCalls: [],
    failApplyOnce: null
  }
  const db: Database = {
    from(table) {
      return {
        select: (columns) => new FakeQuery(state, table, 'select').select(columns),
        insert: (values, options) => ({
          select: (columns) => new FakeQuery(state, table, 'insert', values, options).select(columns)
        }),
        update: (values) => new FakeQuery(state, table, 'update', values)
      }
    },
    rpc(name, args): Promise<QueryResult> {
      state.rpcCalls.push({ name, args })
      if (name === 'zkteco_ingest_events') {
        // Mirrors the set-based RPC: skip rows whose (device_id, payload_hash)
        // already exists and report what was actually inserted.
        const incoming = (args.p_events ?? []) as Array<Record<string, unknown>>
        const ids: string[] = []
        for (const row of incoming) {
          const exists = state.events.some((entry) =>
            entry.device_id === args.p_device_id && entry.payload_hash === row.payload_hash
          )
          if (exists) continue
          state.events.push({
            ...row,
            id: String(row.id),
            device_id: String(args.p_device_id),
            resolution_status: 'pending'
          } as StoredEvent)
          ids.push(String(row.id))
        }
        return Promise.resolve(result({ inserted: ids.length, ids }))
      }
      if (name === 'apply_attendance_event') {
        const event = state.events.find((entry) => entry.id === args.p_event_id)
        if (!event) return Promise.resolve(result(null, { code: 'P0002' }))
        if (state.failApplyOnce === event.id) {
          state.failApplyOnce = null
          return Promise.resolve(result(null, { code: 'XX000' }))
        }
        const known = event.device_user_id === '1001'
        event.resolution_status = known ? 'resolved' : 'unresolved'
        return Promise.resolve(result({
          event_id: event.id,
          resolution_status: event.resolution_status,
          resolved_kind: known ? 'check_in' : null,
          attendance_id: known ? `attendance-${event.id}` : null,
          replayed: false
        }))
      }
      if (name === 'zkteco_claim_commands') {
        const limit = Number(args.p_limit ?? 50)
        const claimed = state.commands
          .filter((entry) => entry.device_id === args.p_device_id && (entry.status === 'pending'
            || (entry.status === 'processing' && String(entry.lease_expires_at ?? '') < new Date().toISOString())))
          .sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)) || left.id.localeCompare(right.id))
          .slice(0, limit)
        for (const command of claimed) {
          command.status = 'processing'
          command.attempts += 1
          command.lease_expires_at = new Date(Date.now() + 120_000).toISOString()
        }
        return Promise.resolve(result(claimed))
      }
      if (name === 'zkteco_finish_command') {
        const command = state.commands.find((entry) =>
          entry.id === args.p_command_id && entry.device_id === args.p_device_id
          && entry.idempotency_key === args.p_idempotency_key
        )
        if (!command) return Promise.resolve(result(null, { code: 'P0002' }))
        if (['completed', 'failed', 'cancelled'].includes(command.status)) {
          return Promise.resolve(command.status === args.p_status
            ? result({ ok: true, command_id: command.id, status: command.status, replayed: true })
            : result(null, { code: 'P0004' }))
        }
        command.status = String(args.p_status)
        command.attempts += 1
        command.last_error = args.p_status === 'failed' ? args.p_error : null
        command.processed_at = '2026-11-24T12:00:00Z'
        const mapping = state.mappings.find((entry) => entry.employee_id === command.employee_id && entry.device_id === command.device_id)
        if (mapping) {
          mapping.enrollment_status = args.p_status === 'completed' && command.type === 'start_enrollment'
            ? 'enrolled'
            : args.p_status === 'failed' ? 'failed' : 'pending'
        }
        return Promise.resolve(result({ ok: true, command_id: command.id, status: command.status, replayed: false }))
      }
      return Promise.resolve(result(null, { code: 'XX000' }))
    }
  }
  return { db, state }
}

function request(action: DeviceRequest, token = VALID_TOKEN): Request {
  return new Request('http://localhost/functions/v1/device-sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(action)
  })
}

function event(id: string, hash: string, user = '1001', occurredAt = '2026-11-24T07:00:00+02:00') {
  return {
    event_id: `50000000-0000-4000-8000-${id}`,
    device_user_id: user,
    occurred_at: occurredAt,
    device_timestamp: '2026-11-24 07:00:00',
    timezone: 'Africa/Cairo',
    verify_mode: 0,
    raw_state: 0,
    work_code: 0,
    payload_hash: hash.repeat(64)
  }
}

Deno.test('token hashing uses SHA-256 and comparison handles unequal lengths', async () => {
  assertEquals(await hashToken('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  assertEquals(VALID_HASH.length, 64)
  assertEquals(constantTimeEqual(VALID_HASH, VALID_HASH), true)
  assertEquals(constantTimeEqual(VALID_HASH, '0'.repeat(64)), false)
  assertEquals(constantTimeEqual('', ''), true)
  assertEquals(constantTimeEqual('', 'a'), false)
})

Deno.test('bearer parsing rejects missing, JWT-like and ambiguous credentials', () => {
  assertEquals(readBearerToken(new Headers({ Authorization: `Bearer ${VALID_TOKEN}` })), VALID_TOKEN)
  assertEquals(readBearerToken(new Headers({ 'X-Device-Token': VALID_TOKEN })), VALID_TOKEN)
  assertThrows(() => readBearerToken(new Headers()), HttpError, 'INVALID_DEVICE_TOKEN')
  assertThrows(() => readBearerToken(new Headers({ Authorization: 'Bearer aaa.bbb.ccc' })), HttpError, 'INVALID_DEVICE_TOKEN')
  assertThrows(() => readBearerToken(new Headers({ Authorization: `Bearer ${VALID_TOKEN}`, 'X-Device-Token': VALID_TOKEN })), HttpError, 'AMBIGUOUS_CREDENTIALS')
})

Deno.test('Zod accepts all five actions and rejects malformed, nested biometric and extra fields', () => {
  assertEquals(parseDeviceRequest({ action: 'heartbeat' }).action, 'heartbeat')
  assertEquals(parseDeviceRequest({ action: 'push_events', events: [event('000000000001', '1')] }).action, 'push_events')
  assertEquals(parseDeviceRequest({ action: 'pull_commands' }).action, 'pull_commands')
  assertEquals(parseDeviceRequest({ action: 'complete_command', command_id: COMMAND_ONE, idempotency_key: 'one' }).action, 'complete_command')
  assertEquals(parseDeviceRequest({ action: 'fail_command', command_id: COMMAND_ONE, idempotency_key: 'one', error: 'timeout' }).action, 'fail_command')
  assertThrows(() => parseDeviceRequest({ action: 'push_events', events: [{ ...event('000000000001', '1'), timezone: 'Not/AZone' }] }), HttpError, 'INVALID_PAYLOAD')
  assertThrows(() => parseDeviceRequest({ action: 'heartbeat', device_token: VALID_TOKEN }), HttpError, 'INVALID_PAYLOAD')
  assertThrows(() => parseDeviceRequest({ action: 'pull_commands', after: COMMAND_ONE }), HttpError, 'INVALID_PAYLOAD')
  assertThrows(() => parseDeviceRequest({ action: 'complete_command', command_id: COMMAND_ONE, idempotency_key: 'one', result: { nested: [{ fingerprint_template: 'forbidden' }] } }), HttpError, 'INVALID_PAYLOAD')
})

Deno.test('valid token heartbeat updates only the authenticated device', async () => {
  const { db, state } = fakeDatabase()
  const handler = createHandler({ db })
  const response = await handler(request({ action: 'heartbeat', clock_drift_seconds: -7, bridge_version: '1.0.0' }))
  assertEquals(response.status, 200)
  const body = await response.json()
  assertEquals(body.ok, true)
  assertEquals(body.clock_drift_seconds, -7)
  assertEquals(body.bridge_version, '1.0.0')
  assertEquals(state.devices[0].status, 'online')
  assertExists(state.devices[0].last_seen_at)
  assertEquals(state.devices[1].last_seen_at, undefined)
})

Deno.test('missing, invalid, revoked and disabled tokens return 401 without mutations', async () => {
  const { db, state } = fakeDatabase()
  const handler = createHandler({ db })
  const missing = await handler(new Request('http://localhost', { method: 'POST', body: '{}' }))
  const invalid = await handler(request({ action: 'heartbeat' }, 'wrong-token-that-is-at-least-thirty-two-characters'))
  state.devices[0].device_token_hash = null
  const revoked = await handler(request({ action: 'heartbeat' }))
  state.devices[0].device_token_hash = VALID_HASH
  state.devices[0].status = 'disabled'
  const disabled = await handler(request({ action: 'heartbeat' }))
  assertEquals([missing.status, invalid.status, revoked.status, disabled.status], [401, 401, 401, 401])
  assertEquals(state.devices[0].last_seen_at, undefined)
})

Deno.test('push conflicts are ignored, unknown users stay unresolved, and replay does not reapply', async () => {
  const { db, state } = fakeDatabase()
  const handler = createHandler({ db })
  const payload = { action: 'push_events' as const, events: [event('000000000001', '1'), event('000000000002', '2', '9999')] }
  const first = await handler(request(payload))
  assertEquals(first.status, 200)
  const firstBody = await first.json()
  assertEquals(firstBody.inserted, 2)
  assertEquals(firstBody.duplicates, 0)
  assertEquals(firstBody.events[1].resolution_status, 'unresolved')
  const replay = await handler(request(payload))
  assertEquals(replay.status, 200)
  const replayBody = await replay.json()
  assertEquals([replayBody.inserted, replayBody.duplicates, replayBody.events.length], [0, 2, 0])
  assertEquals(state.events.length, 2)
  assertEquals(state.rpcCalls.filter((call) => call.name === 'apply_attendance_event').length, 2)
})

Deno.test('push sorts actual instants rather than offset timestamp strings', async () => {
  const { db, state } = fakeDatabase()
  const handler = createHandler({ db })
  const response = await handler(request({
    action: 'push_events',
    events: [
      event('000000000001', '1', '1001', '2026-11-24T06:00:00-05:00'),
      event('000000000002', '2', '1001', '2026-11-24T08:00:00+03:00')
    ]
  }))
  assertEquals(response.status, 200)
  assertEquals(
    state.rpcCalls.filter((call) => call.name === 'apply_attendance_event').map((call) => call.args.p_event_id),
    [
      '50000000-0000-4000-8000-000000000002',
      '50000000-0000-4000-8000-000000000001'
    ]
  )
})

Deno.test('a raw insert left pending by an RPC failure is healed on retry', async () => {
  const { db, state } = fakeDatabase()
  const handler = createHandler({ db })
  const payload = { action: 'push_events' as const, events: [event('000000000001', '1')] }
  state.failApplyOnce = '50000000-0000-4000-8000-000000000001'
  const failed = await handler(request(payload))
  assertEquals(failed.status, 500)
  assertEquals(state.events[0].resolution_status, 'pending')
  const retry = await handler(request(payload))
  assertEquals(retry.status, 200)
  const body = await retry.json()
  assertEquals([body.inserted, body.duplicates, body.events.length], [0, 1, 1])
  assertEquals(state.events[0].resolution_status, 'resolved')
  assertEquals(state.rpcCalls.filter((call) => call.name === 'apply_attendance_event').length, 2)
})

Deno.test('oversized event and command batches return 400 without database writes', async () => {
  const { db, state } = fakeDatabase()
  const handler = createHandler({ db })
  const tooManyEvents = Array.from({ length: MAX_EVENTS + 1 }, (_, index) =>
    event(String(index).padStart(12, '0'), (index % 16).toString(16))
  )
  const push = await handler(request({ action: 'push_events', events: tooManyEvents }))
  const pull = await handler(request({ action: 'pull_commands', limit: MAX_COMMANDS + 1 }))
  assertEquals([push.status, pull.status], [400, 400])
  assertEquals(state.events.length, 0)
})

Deno.test('streamed bodies over the byte limit and malformed JSON are rejected', async () => {
  const { db } = fakeDatabase()
  const handler = createHandler({ db })
  const large = await handler(new Request('http://localhost', {
    method: 'POST',
    headers: { Authorization: `Bearer ${VALID_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'heartbeat', padding: 'x'.repeat(MAX_BODY_BYTES) })
  }))
  const malformed = await handler(new Request('http://localhost', {
    method: 'POST',
    headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    body: '{'
  }))
  assertEquals([large.status, malformed.status], [413, 400])
})

Deno.test('per-device request rate limiting returns 429 with Retry-After and resets', async () => {
  const { db } = fakeDatabase()
  let now = 1_800_000_000_000
  const handler = createHandler({ db, rateStore: createRestRateLimitStore(), now: () => now })
  for (let index = 0; index < RATE_LIMIT; index += 1) {
    assertEquals((await handler(request({ action: 'heartbeat' }))).status, 200)
  }
  const limited = await handler(request({ action: 'heartbeat' }))
  assertEquals(limited.status, 429)
  assertExists(limited.headers.get('Retry-After'))
  now += 60_001
  assertEquals((await handler(request({ action: 'heartbeat' }))).status, 200)
})

Deno.test('pull commands is device-scoped, oldest-first and limit-bounded', async () => {
  const { db } = fakeDatabase()
  const handler = createHandler({ db })
  const response = await handler(request({ action: 'pull_commands', limit: 1 }))
  assertEquals(response.status, 200)
  const body = await response.json()
  assertEquals(body.commands.length, 1)
  assertEquals(body.commands[0].id, COMMAND_TWO)
  assertEquals(body.commands[0].device_id, undefined)
})

Deno.test('complete is atomic/idempotent and cannot target another device or wrong key', async () => {
  const { db, state } = fakeDatabase()
  const handler = createHandler({ db })
  const complete = request({ action: 'complete_command', command_id: COMMAND_ONE, idempotency_key: 'one' })
  assertEquals((await handler(complete)).status, 200)
  const command = state.commands.find((entry) => entry.id === COMMAND_ONE)
  assertExists(command)
  assertEquals([command.status, command.attempts], ['completed', 1])
  assertEquals(state.mappings[0].enrollment_status, 'enrolled')
  const replay = await handler(request({ action: 'complete_command', command_id: COMMAND_ONE, idempotency_key: 'one' }))
  assertEquals((await replay.json()).replayed, true)
  assertEquals(command.attempts, 1)
  const foreign = await handler(request({ action: 'fail_command', command_id: COMMAND_OTHER, idempotency_key: 'other', error: 'timeout' }))
  const wrongKey = await handler(request({ action: 'fail_command', command_id: COMMAND_TWO, idempotency_key: 'wrong', error: 'timeout' }))
  const conflict = await handler(request({ action: 'fail_command', command_id: COMMAND_ONE, idempotency_key: 'one', error: 'timeout' }))
  assertEquals([foreign.status, wrongKey.status, conflict.status], [404, 404, 409])
  assertEquals(state.commands.find((entry) => entry.id === COMMAND_OTHER)?.status, 'pending')
  assertEquals(state.rpcCalls.filter((call) => call.name === 'zkteco_finish_command').length, 5)
})

Deno.test('fail is idempotent and updates enrollment through the same atomic RPC', async () => {
  const { db, state } = fakeDatabase()
  const handler = createHandler({ db })
  const payload: DeviceRequest = { action: 'fail_command', command_id: COMMAND_TWO, idempotency_key: 'two', error: 'device busy' }
  assertEquals((await handler(request(payload))).status, 200)
  const replay = await handler(request(payload))
  assertEquals((await replay.json()).replayed, true)
  const command = state.commands.find((entry) => entry.id === COMMAND_TWO)
  assertExists(command)
  assertEquals([command.status, command.attempts, command.last_error], ['failed', 1, 'device busy'])
  assertEquals(state.mappings[0].enrollment_status, 'failed')
})

Deno.test('preflight allows CORS without authentication and wrong methods return 405', async () => {
  const { db } = fakeDatabase()
  const handler = createHandler({ db })
  const preflight = await handler(new Request('http://localhost', { method: 'OPTIONS' }))
  const get = await handler(new Request('http://localhost', { method: 'GET' }))
  assertEquals([preflight.status, get.status], [204, 405])
  assertEquals(preflight.headers.get('Access-Control-Allow-Headers')?.includes('Authorization'), true)
  assertEquals(get.headers.get('Allow'), 'POST, OPTIONS')
})
