-- SUSHI ROLLS — ZKTeco database acceptance tests.
-- Run: supabase test db (base schema.sql then the ZKTeco migration).

begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
alter table public.user_permissions disable trigger trg_audit_perms;

insert into auth.users (id, email)
values
  ('10000000-0000-4000-8000-000000000001', 'zk-super@example.test'),
  ('10000000-0000-4000-8000-000000000002', 'zk-manager@example.test'),
  ('10000000-0000-4000-8000-000000000003', 'zk-denied@example.test'),
  ('10000000-0000-4000-8000-000000000004', 'zk-employee@example.test');

insert into public.profiles (id, username, full_name, role) values
  ('10000000-0000-4000-8000-000000000001', 'zk_super', 'ZK Super', 'super_admin'),
  ('10000000-0000-4000-8000-000000000002', 'zk_manager', 'ZK Manager', 'general_manager'),
  ('10000000-0000-4000-8000-000000000003', 'zk_denied', 'ZK Denied', 'super_admin'),
  ('10000000-0000-4000-8000-000000000004', 'zk_employee', 'ZK Employee', 'waiter');

insert into public.user_permissions (user_id, permission, allowed) values
  ('10000000-0000-4000-8000-000000000001', 'device.manage', true),
  ('10000000-0000-4000-8000-000000000002', 'device.manage', true),
  ('10000000-0000-4000-8000-000000000002', 'employees.manage', true),
  ('10000000-0000-4000-8000-000000000002', 'attendance.view', true),
  ('10000000-0000-4000-8000-000000000002', 'attendance.manage', true),
  ('10000000-0000-4000-8000-000000000003', 'device.manage', false),
  ('10000000-0000-4000-8000-000000000004', 'attendance.view', true);
alter table public.user_permissions enable trigger trg_audit_perms;

insert into public.employees (id, profile_id, full_name) values
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000004', 'ZK Test Employee'),
  ('20000000-0000-4000-8000-000000000002', null, 'ZK Orphan Employee'),
  ('20000000-0000-4000-8000-000000000003', null, 'ZK State Employee'),
  ('20000000-0000-4000-8000-000000000004', null, 'ZK Timezone Employee');

insert into public.attendance_devices (
  id, name, serial_number, usb_vid, usb_pid, status, background_mode,
  attendance_mode, timezone, device_token_hash
) values (
  '30000000-0000-4000-8000-000000000001', 'ZK Test LX15', 'TEST-LX15', '1B55', '0A01',
  'offline', 'app_only', 'alternating', 'Africa/Cairo', repeat('a', 64)
);

insert into public.employee_devices (
  id, employee_id, device_id, device_user_id, enrollment_status, enrolled_at
) values
  ('40000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
   '30000000-0000-4000-8000-000000000001', '1001', 'enrolled', now()),
  ('40000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002',
   '30000000-0000-4000-8000-000000000001', '1002', 'enrolled', now()),
  ('40000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000003',
   '30000000-0000-4000-8000-000000000001', '1003', 'enrolled', now()),
  ('40000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000004',
   '30000000-0000-4000-8000-000000000001', '1004', 'enrolled', now());

select has_table('public', 'attendance_devices', 'attendance_devices exists');
select has_table('public', 'employee_devices', 'employee_devices exists');
select has_table('public', 'attendance_events', 'attendance_events exists');
select has_table('public', 'device_commands', 'device_commands exists');
select has_column('public', 'attendance', 'source', 'attendance has source');
select has_column('public', 'attendance', 'device_id', 'attendance has device_id');
select has_column('public', 'attendance', 'check_in_event_id', 'attendance links check-in event');
select has_column('public', 'attendance', 'check_out_event_id', 'attendance links check-out event');
select has_column('public', 'attendance', 'updated_at', 'attendance has updated_at');
select has_index('public', 'attendance', 'attendance_one_open_per_employee_day', 'one open row per employee/day');
select is_definer('public', 'apply_attendance_event', ARRAY['uuid'], 'attendance RPC is privileged');
select is_definer('public', 'zkteco_finish_command', ARRAY['uuid','uuid','text','text','text'], 'command finish RPC is privileged');
select ok(
  'device.manage' = any(public.role_default_perms('super_admin')),
  'super admin receives device management by default'
);
select ok(
  not ('device.manage' = any(public.role_default_perms('owner'))),
  'owner does not receive super-admin-only device management by default'
);
select ok(
  'attendance.view' = any(public.role_default_perms('general_manager'))
    and 'attendance.manage' = any(public.role_default_perms('general_manager')),
  'general manager receives attendance view and management by default'
);
select ok(
  not ('attendance.view' = any(public.role_default_perms('cashier'))),
  'cashier does not receive attendance permissions by default'
);
select results_eq(
  $$select public._zkteco_device_event_kind(1, state) from generate_series(0, 5) as state$$,
  array['check_in', 'check_out', 'break', 'break', 'ot', 'ot'],
  'LX15 attendance states map to check-in, check-out, break, and OT'
);
select is(
  public._zkteco_device_event_kind(1, 99), null::text,
  'unsupported LX15 attendance state has no automatic mapping'
);

insert into public.attendance_events (
  id, device_id, device_user_id, occurred_at, device_timestamp, timezone,
  verify_mode, raw_state, payload_hash
) values
  ('50000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001',
   '1001', '2026-11-24 07:00:00+02', '2026-11-24 07:00:00', 'Africa/Cairo', 0, 0, repeat('1', 64)),
  ('50000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000001',
   '1001', '2026-11-24 15:00:00+02', '2026-11-24 15:00:00', 'Africa/Cairo', 0, 1, repeat('2', 64)),
  ('50000000-0000-4000-8000-000000000003', '30000000-0000-4000-8000-000000000001',
   '9999', '2026-11-24 09:00:00+02', '2026-11-24 09:00:00', 'Africa/Cairo', 0, 0, repeat('3', 64)),
  ('50000000-0000-4000-8000-000000000004', '30000000-0000-4000-8000-000000000001',
   '1003', '2026-11-25 07:00:00+02', '2026-11-25 07:00:00', 'Africa/Cairo', 0, 1, repeat('4', 64)),
  ('50000000-0000-4000-8000-000000000005', '30000000-0000-4000-8000-000000000001',
   '1003', '2026-11-25 08:00:00+02', '2026-11-25 08:00:00', 'Africa/Cairo', 0, 99, repeat('5', 64)),
  ('50000000-0000-4000-8000-000000000006', '30000000-0000-4000-8000-000000000001',
   '1003', '2026-11-25 06:30:00+02', '2026-11-25 06:30:00', 'Africa/Cairo', 0, 1, repeat('6', 64)),
  ('50000000-0000-4000-8000-000000000007', '30000000-0000-4000-8000-000000000001',
   '1003', '2026-11-25 07:00:00+02', '2026-11-25 07:00:00', 'Africa/Cairo', 0, 0, repeat('7', 64)),
  ('50000000-0000-4000-8000-000000000008', '30000000-0000-4000-8000-000000000001',
   '1003', '2026-11-25 09:00:00+02', '2026-11-25 09:00:00', 'Africa/Cairo', 0, 2, repeat('8', 64)),
  ('50000000-0000-4000-8000-000000000009', '30000000-0000-4000-8000-000000000001',
   '1003', '2026-11-25 10:00:00+02', '2026-11-25 10:00:00', 'Africa/Cairo', 0, 4, repeat('9', 64)),
  ('50000000-0000-4000-8000-000000000010', '30000000-0000-4000-8000-000000000001',
   '1004', '2026-11-24 23:30:00-05', '2026-11-24 23:30:00', 'America/New_York', 0, 0, repeat('a', 64)),
  ('50000000-0000-4000-8000-000000000011', '30000000-0000-4000-8000-000000000001',
   '9999', '2026-11-27 07:00:00+02', '2026-11-27 07:00:00', 'Africa/Cairo', 0, 0, repeat('b', 64));

select throws_ok(
  $$insert into public.attendance_events (device_id, device_user_id, occurred_at, device_timestamp,
      timezone, verify_mode, raw_state, payload_hash)
    values ('30000000-0000-4000-8000-000000000001', '1001', now(), 'duplicate',
      'Africa/Cairo', 0, 0, repeat('1', 64))$$,
  '23505', null, 'duplicate payload hash is rejected'
);
select throws_ok(
  $$update public.attendance_events set occurred_at = now()
      where id = '50000000-0000-4000-8000-000000000003'$$,
  '23514', null, 'raw event fields are immutable without admin correction'
);
select throws_ok(
  $$insert into public.attendance_events (device_id, device_user_id, occurred_at, device_timestamp,
      timezone, verify_mode, raw_state, payload_hash)
    values ('30000000-0000-4000-8000-000000000001', '1001', now(), 'bad-zone',
      'Not/AZone', 0, 0, repeat('c', 64))$$,
  '22023', null, 'invalid IANA timezone is rejected'
);
select throws_ok(
  $$insert into public.device_commands (device_id, employee_id, type, payload, idempotency_key, created_by)
    values ('30000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
      'create_user', '{"nested":{"fingerprint_template":"forbidden"}}', 'biometric-test',
      '10000000-0000-4000-8000-000000000001')$$,
  '23514', null, 'nested biometric command data is rejected'
);

set local role service_role;
select results_eq(
  $$select public.apply_attendance_event('50000000-0000-4000-8000-000000000001'::uuid)
      ->> 'resolution_status'$$,
  array['resolved'::text], 'first alternating event resolves check-in'
);
select results_eq(
  $$select resolution_status || ':' || resolved_kind from public.attendance_events
      where id = '50000000-0000-4000-8000-000000000001'$$,
  array['resolved:check_in'::text], 'check-in event links to resolved kind'
);
select results_eq(
  $$select count(*) from public.attendance
      where employee_id = '20000000-0000-4000-8000-000000000001'
        and work_date = date '2026-11-24' and check_out is null$$,
  array[1::bigint], 'alternating mode creates exactly one open daily row'
);
select results_eq(
  $$select source || ':' || device_id::text || ':' || check_in_event_id::text
      from public.attendance where check_in_event_id = '50000000-0000-4000-8000-000000000001'$$,
  array['device:30000000-0000-4000-8000-000000000001:50000000-0000-4000-8000-000000000001'::text],
  'daily row is attributed to device and raw event'
);
select results_eq(
  $$select public.apply_attendance_event('50000000-0000-4000-8000-000000000002'::uuid)
      ->> 'resolution_status'$$,
  array['resolved'::text], 'second alternating event resolves'
);
select results_eq(
  $$select resolution_status || ':' || resolved_kind from public.attendance_events
      where id = '50000000-0000-4000-8000-000000000002'$$,
  array['resolved:check_out'::text], 'second event closes as check-out'
);
select results_eq(
  $$select check_out_event_id::text from public.attendance
      where check_in_event_id = '50000000-0000-4000-8000-000000000001'$$,
  array['50000000-0000-4000-8000-000000000002'::text], 'check-out event id is linked'
);
select results_eq(
  $$select public.apply_attendance_event('50000000-0000-4000-8000-000000000001'::uuid)
      ->> 'replayed'$$,
  array['true'::text], 'replay reports the existing result'
);
select results_eq(
  $$select count(*) from public.attendance
      where employee_id = '20000000-0000-4000-8000-000000000001' and work_date = date '2026-11-24'$$,
  array[1::bigint], 'replay creates no second daily row'
);
select ok(
  public.apply_attendance_event('50000000-0000-4000-8000-000000000003'::uuid) ? 'attendance_id',
  'unknown-user RPC returns a JSON result'
);
select results_eq(
  $$select resolution_status || ':' || coalesce(employee_id::text, 'none') from public.attendance_events
      where id = '50000000-0000-4000-8000-000000000003'$$,
  array['unresolved:none'::text], 'unknown device user remains unresolved'
);
select throws_ok(
  $$update public.attendance_events set occurred_at = now()
      where id = '50000000-0000-4000-8000-000000000001'$$,
  '23514', null, 'resolved raw history is immutable'
);

update public.attendance_devices set attendance_mode = 'device_state'
where id = '30000000-0000-4000-8000-000000000001';
select results_eq(
  $$select public.apply_attendance_event('50000000-0000-4000-8000-000000000004'::uuid)
      ->> 'resolution_status'$$,
  array['ignored'::text], 'orphan check-out is ignored without inventing check-in'
);
select results_eq(
  $$select public.apply_attendance_event('50000000-0000-4000-8000-000000000005'::uuid)
      ->> 'resolution_status'$$,
  array['ignored'::text], 'unsupported device state is retained as ignored'
);
select ok(
  public.apply_attendance_event('50000000-0000-4000-8000-000000000007'::uuid) ? 'attendance_id',
  'device_state check-in returns a result'
);
select results_eq(
  $$select public.apply_attendance_event('50000000-0000-4000-8000-000000000006'::uuid)
      ->> 'resolution_status'$$,
  array['ignored'::text], 'out-of-order check-out cannot rewrite an open session'
);
select public.apply_attendance_event('50000000-0000-4000-8000-000000000008'::uuid);
select public.apply_attendance_event('50000000-0000-4000-8000-000000000009'::uuid);
select results_eq(
  $$select resolution_status || ':' || resolved_kind from public.attendance_events
      where id in ('50000000-0000-4000-8000-000000000008','50000000-0000-4000-8000-000000000009')
      order by occurred_at$$,
  array['resolved:break'::text, 'resolved:ot'::text], 'break and OT resolve without changing daily times'
);
select results_eq(
  $$select count(*) from public.attendance
      where employee_id = '20000000-0000-4000-8000-000000000003'
        and work_date = date '2026-11-25' and check_out is null$$,
  array[1::bigint], 'break/OT leave the single open session unchanged'
);
select ok(
  public.apply_attendance_event('50000000-0000-4000-8000-000000000010'::uuid) ? 'attendance_id',
  'timezone event returns a result'
);
select results_eq(
  $$select work_date::text from public.attendance
      where check_in_event_id = '50000000-0000-4000-8000-000000000010'$$,
  array['2026-11-24'::text], 'event instant converts to the correct local workday'
);
select throws_ok(
  $$insert into public.attendance (employee_id, check_in, work_date)
    values ('20000000-0000-4000-8000-000000000003', '2026-11-25 11:00:00+02', date '2026-11-25')$$,
  '23505', null, 'one-open-row index rejects a second open session'
);
select throws_ok(
  $$set constraints trg_zkteco_attendance_event_links immediate;
    insert into public.attendance (employee_id, check_in, work_date, source, device_id, check_in_event_id)
    values ('20000000-0000-4000-8000-000000000004', now(), date '2026-11-28', 'device',
      '30000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000011')$$,
  '23514', null, 'deferred event-link validation rejects a pending check-in link'
);

reset role;
set local role authenticated;
set local request.jwt.claim.sub = '10000000-0000-4000-8000-000000000002';
select results_eq(
  $$select count(*) from public.attendance_devices$$,
  array[1::bigint], 'device.manage can read device token metadata'
);
select results_eq(
  $$select count(*) from public.employee_devices$$,
  array[4::bigint], 'employees.manage can read employee mappings'
);
select results_eq(
  $$select count(*) from public.attendance_events where resolution_status = 'pending'$$,
  array[1::bigint], 'attendance.manage can read pending raw events'
);
select throws_ok(
  $$select public.apply_attendance_event('50000000-0000-4000-8000-000000000001'::uuid)$$,
  '42501', null, 'clients cannot invoke privileged attendance RPC'
);
select throws_ok(
  $$select public.zkteco_finish_command('60000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000001', 'test', 'completed')$$,
  '42501', null, 'clients cannot invoke service-only command completion'
);
select results_eq(
  $$select public.zkteco_resolve_event('50000000-0000-4000-8000-000000000003'::uuid,
      'retry', '20000000-0000-4000-8000-000000000002'::uuid) ->> 'resolution_status'$$,
  array['resolved'::text], 'attendance.manage can explicitly resolve an unknown user'
);
select results_eq(
  $$select employee_id::text from public.attendance_events
      where id = '50000000-0000-4000-8000-000000000003'$$,
  array['20000000-0000-4000-8000-000000000002'::text], 'resolution records the explicit employee mapping'
);

set local request.jwt.claim.sub = '10000000-0000-4000-8000-000000000004';
select is_empty(
  $$select * from public.attendance_devices$$,
  'ordinary employee cannot read device metadata'
);
select is_empty(
  $$select * from public.attendance_events where resolution_status not in ('resolved','ignored')$$,
  'attendance.view sees resolved/ignored events but not pending events'
);
select results_eq(
  $$select count(*) from public.employee_devices$$,
  array[4::bigint], 'attendance.view can read enrollment mappings'
);
select throws_ok(
  $$insert into public.device_commands (device_id, type, payload, idempotency_key, created_by)
    values ('30000000-0000-4000-8000-000000000001', 'create_user', '{}', 'employee-command',
      '10000000-0000-4000-8000-000000000004')$$,
  '42501', null, 'ordinary employee cannot insert commands'
);
select throws_ok(
  $$update public.attendance set note = 'unaudited' where employee_id = '20000000-0000-4000-8000-000000000001'$$,
  '42501', null, 'direct attendance writes are revoked from clients'
);

set local request.jwt.claim.sub = '10000000-0000-4000-8000-000000000003';
select throws_ok(
  $$select public.zkteco_upsert_device('{"name":"Denied device"}'::jsonb)$$,
  '42501', null, 'super-admin with explicit deny cannot manage devices'
);
select is_empty(
  $$select * from public.attendance_devices$$,
  'explicit deny also blocks device metadata reads'
);

reset role;
set local role anon;
select throws_ok(
  $$select * from public.attendance_events$$,
  '42501', null, 'anonymous clients cannot read raw events'
);
select throws_ok(
  $$insert into public.device_commands (device_id, type, payload, idempotency_key, created_by)
    values ('30000000-0000-4000-8000-000000000001', 'create_user', '{}', 'anon-command',
      '10000000-0000-4000-8000-000000000001')$$,
  '42501', null, 'anonymous clients cannot insert commands'
);

reset role;
set local role authenticated;
set local request.jwt.claim.sub = '10000000-0000-4000-8000-000000000002';
select results_eq(
  $$select public.zkteco_enroll_employee('20000000-0000-4000-8000-000000000004'::uuid,
      'start_enrollment', 'manager-enroll', null, '{}'::jsonb) ->> 'status'$$,
  array['pending'::text], 'employees.manage creates an enrollment command'
);
select results_eq(
  $$select public.zkteco_enroll_employee('20000000-0000-4000-8000-000000000004'::uuid,
      'start_enrollment', 'manager-enroll', null, '{}'::jsonb) ->> 'replayed'$$,
  array['true'::text], 'enrollment command idempotency key replays'
);
select results_eq(
  $$select payload ->> 'device_user_id' || ':' || (payload ->> 'privilege')::text
      from public.device_commands where idempotency_key = 'manager-enroll'$$,
  array['1004:0'::text], 'command carries stable device identity and validated privilege'
);
select throws_ok(
  $$select public.zkteco_enroll_employee('20000000-0000-4000-8000-000000000004'::uuid,
      'start_enrollment', 'different-key', null, '{}'::jsonb)$$,
  '23514', null, 'duplicate pending enrollment is blocked'
);

reset role;
set local role service_role;
select results_eq(
  $$select public.zkteco_finish_command(
      (select id from public.device_commands where idempotency_key = 'manager-enroll'),
      '30000000-0000-4000-8000-000000000001', 'manager-enroll', 'completed') ->> 'replayed'$$,
  array['false'::text], 'service role completes enrollment atomically'
);
select results_eq(
  $$select c.status || ':' || c.attempts::text || ':' || ed.enrollment_status
      from public.device_commands c join public.employee_devices ed on ed.employee_id = c.employee_id
      where c.idempotency_key = 'manager-enroll'$$,
  array['completed:1:enrolled'::text], 'command and enrollment mapping commit together'
);
select results_eq(
  $$select public.zkteco_finish_command(
      (select id from public.device_commands where idempotency_key = 'manager-enroll'),
      '30000000-0000-4000-8000-000000000001', 'manager-enroll', 'completed') ->> 'replayed'$$,
  array['true'::text], 'command completion replay does not increment attempts'
);
select throws_ok(
  $$select public.zkteco_finish_command(
      (select id from public.device_commands where idempotency_key = 'manager-enroll'),
      '30000000-0000-4000-8000-000000000001', 'manager-enroll', 'failed', 'late failure')$$,
  'P0004', null, 'conflicting terminal command transition is rejected'
);
select results_eq(
  $$select count(*) from public.audit_logs where action = 'zkteco.complete_command'$$,
  array[1::bigint], 'command completion is audited once'
);
select throws_ok(
  $$update public.device_commands set payload = payload || '{"name":"changed"}'::jsonb
      where idempotency_key = 'manager-enroll'$$,
  '23514', null, 'command payload is immutable'
);

update public.attendance_devices set attendance_mode = 'raw_only'
where id = '30000000-0000-4000-8000-000000000001';
insert into public.attendance_events (
  id, device_id, device_user_id, occurred_at, device_timestamp, timezone,
  verify_mode, raw_state, payload_hash
) values (
  '50000000-0000-4000-8000-000000000012', '30000000-0000-4000-8000-000000000001',
  '1001', '2026-11-26 07:00:00+02', '2026-11-26 07:00:00', 'Africa/Cairo', 0, 0, repeat('d', 64)
);
select results_eq(
  $$select public.apply_attendance_event('50000000-0000-4000-8000-000000000012'::uuid)
      ->> 'resolution_status'$$,
  array['ignored'::text], 'raw_only stores without changing daily attendance'
);
select results_eq(
  $$select count(*) from public.attendance where work_date = date '2026-11-26'$$,
  array[0::bigint], 'raw_only creates no daily attendance row'
);
select results_eq(
  $$select (check_in = '2026-11-24 07:00:00+02'::timestamptz)::text from public.attendance
      where check_in_event_id = '50000000-0000-4000-8000-000000000001'$$,
  array['true'::text], 'policy changes do not rewrite resolved history'
);

reset role;
set local role authenticated;
set local request.jwt.claim.sub = '10000000-0000-4000-8000-000000000002';
select results_eq(
  $$select public.zkteco_resolve_event('50000000-0000-4000-8000-000000000012'::uuid,
      'retry', null, null, 'verified punch') ->> 'resolution_status'$$,
  array['resolved'::text], 'admin can explicitly resolve a raw-only event'
);
select results_eq(
  $$select public.zkteco_correct_attendance(
      (select id from public.attendance where check_in_event_id = '50000000-0000-4000-8000-000000000012'),
      '2026-11-26 08:00:00+02', null, 'audited correction', date '2026-11-26') ->> 'ok'$$,
  array['true'::text], 'attendance.manage can correct times through the audited RPC'
);
select results_eq(
  $$select note || ':' || to_char(check_in at time zone 'Africa/Cairo', 'HH24:MI')
      from public.attendance where check_in_event_id = '50000000-0000-4000-8000-000000000012'$$,
  array['audited correction:08:00'::text], 'correction changes only the intended daily values'
);
select results_eq(
  $$select count(*) from public.audit_logs
      where action = 'zkteco.correct_attendance'
        and entity_id = (select id::text from public.attendance
          where check_in_event_id = '50000000-0000-4000-8000-000000000012')$$,
  array[1::bigint], 'manual attendance correction is audited'
);

reset role;
set local role service_role;
select throws_ok(
  $$update public.attendance set check_in = check_in + interval '1 minute'
      where check_in_event_id = '50000000-0000-4000-8000-000000000012'$$,
  '42501', null, 'even service-role direct DML requires the correction RPC'
);

reset role;
set local role authenticated;
set local request.jwt.claim.sub = '10000000-0000-4000-8000-000000000002';
select results_eq(
  $$select public.zkteco_upsert_device('{"id":"30000000-0000-4000-8000-000000000001","revoke_token":true}'::jsonb)
      ->> 'token_revoked'$$,
  array['true'::text], 'device.manage can explicitly revoke a token'
);
select results_eq(
  $$select (device_token_hash is null)::text from public.attendance_devices
      where id = '30000000-0000-4000-8000-000000000001'$$,
  array['true'::text], 'revocation clears the stored hash'
);
select results_eq(
  $$select (public.zkteco_upsert_device('{"id":"30000000-0000-4000-8000-000000000001"}'::jsonb,
      repeat('b', 64)) is null)::text$$,
  array['false'::text], 'token rotation requires a valid SHA-256 hash'
);
select throws_ok(
  $$select public.zkteco_upsert_device('{}'::jsonb, 'plaintext-token')$$,
  '23514', null, 'plaintext device tokens are never stored'
);
select is_empty(
  $$select 1 from public.audit_logs
      where action = 'zkteco.upsert_device' and details::text like '%plaintext-token%'$$,
  'device audit details never contain plaintext token material'
);

select results_eq(
  $$select public.zkteco_enroll_employee('20000000-0000-4000-8000-000000000001'::uuid,
      'delete_user', 'manager-delete-fail', null, '{}'::jsonb) ->> 'status'$$,
  array['pending'::text], 'employees.manage queues a durable device-user deletion'
);
reset role;
set local role service_role;
select results_eq(
  $$select public.zkteco_finish_command(
      (select id from public.device_commands where idempotency_key = 'manager-delete-fail'),
      '30000000-0000-4000-8000-000000000001', 'manager-delete-fail', 'failed', 'device busy') ->> 'status'$$,
  array['failed'::text], 'failed device-user deletion is recorded'
);
select results_eq(
  $$select enrollment_status || ':' || (disabled_at is not null)::text
      from public.employee_devices
      where employee_id = '20000000-0000-4000-8000-000000000001'$$,
  array['disabled:true'::text], 'failed disable or delete keeps attendance mapping disabled'
);

select * from finish();
rollback;
