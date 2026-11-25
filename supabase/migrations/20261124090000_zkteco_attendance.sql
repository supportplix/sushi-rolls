-- SUSHI ROLLS — ZKTeco LX15 attendance (approved design, 2026-11-24).
-- Run after schema.sql. Fingerprint templates are deliberately absent.
-- The Edge Function uses service_role; clients use permission-aware RPCs only.

create or replace function public.role_default_perms(p_role text)
returns text[]
language sql immutable
as $$
  select case p_role
    when 'super_admin' then array[
      'dashboard.view','pos.use','orders.view','orders.cancel','orders.refund','tables.manage',
      'kds.use','menu.view','menu.manage','inventory.view','inventory.manage','purchases.view',
      'purchases.manage','suppliers.view','suppliers.manage','customers.view','customers.manage',
      'expenses.view','expenses.manage','cash.manage','cash.review','employees.view',
      'employees.manage','attendance.view','attendance.manage','reports.view','users.manage',
      'settings.manage','device.manage','backup.manage','audit.view'
    ]
    when 'owner' then array[
      'dashboard.view','pos.use','orders.view','orders.cancel','orders.refund','tables.manage',
      'kds.use','menu.view','menu.manage','inventory.view','inventory.manage','purchases.view',
      'purchases.manage','suppliers.view','suppliers.manage','customers.view','customers.manage',
      'expenses.view','expenses.manage','cash.manage','cash.review','employees.view',
      'employees.manage','attendance.view','attendance.manage','reports.view','users.manage',
      'settings.manage','backup.manage','audit.view'
    ]
    when 'general_manager' then array[
      'dashboard.view','pos.use','orders.view','orders.cancel','orders.refund','tables.manage',
      'kds.use','menu.view','menu.manage','inventory.view','inventory.manage','purchases.view',
      'purchases.manage','suppliers.view','suppliers.manage','customers.view','customers.manage',
      'expenses.view','expenses.manage','cash.manage','cash.review','employees.view',
      'employees.manage','attendance.view','attendance.manage','reports.view','audit.view'
    ]
    when 'branch_manager' then array[
      'dashboard.view','pos.use','orders.view','orders.cancel','tables.manage','kds.use',
      'menu.view','menu.manage','inventory.view','inventory.manage','purchases.view',
      'purchases.manage','suppliers.view','suppliers.manage','customers.view','customers.manage',
      'cash.manage','cash.review','employees.view','attendance.view','reports.view'
    ]
    when 'cashier' then array[
      'pos.use','orders.view','tables.manage','menu.view','customers.view','customers.manage','cash.manage'
    ]
    when 'waiter' then array['pos.use','orders.view','tables.manage','menu.view']
    when 'kitchen' then array['kds.use','menu.view','inventory.view']
    when 'inventory_manager' then array[
      'orders.view','menu.view','inventory.view','inventory.manage','purchases.view',
      'purchases.manage','suppliers.view','suppliers.manage','reports.view'
    ]
    when 'accountant' then array[
      'dashboard.view','orders.view','menu.view','customers.view','expenses.view','expenses.manage',
      'cash.review','reports.view','audit.view','inventory.view','suppliers.view','purchases.view',
      'attendance.view'
    ]
    else array[]::text[]
  end;
$$;

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Tables and attendance additions
-- ---------------------------------------------------------------------------

create table if not exists public.attendance_devices (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 120),
  serial_number text unique check (serial_number is null or length(btrim(serial_number)) between 1 and 120),
  usb_vid text not null check (usb_vid ~ '^[0-9A-Fa-f]{4}$'),
  usb_pid text not null check (usb_pid ~ '^[0-9A-Fa-f]{4}$'),
  status text not null default 'offline'
    check (status in ('offline','connecting','online','error','disabled')),
  background_mode text not null default 'app_only'
    check (background_mode in ('app_only','logon_agent','windows_service')),
  attendance_mode text not null default 'alternating'
    check (attendance_mode in ('alternating','device_state','raw_only')),
  timezone text not null default 'Africa/Cairo',
  device_token_hash text check (device_token_hash is null or device_token_hash ~ '^[0-9a-f]{64}$'),
  last_seen_at timestamptz,
  last_sync_at timestamptz,
  clock_drift_seconds integer check (clock_drift_seconds between -86400 and 86400),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists attendance_devices_token_hash_idx
  on public.attendance_devices (device_token_hash)
  where device_token_hash is not null;

create table if not exists public.employee_devices (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  device_id uuid not null references public.attendance_devices(id) on delete restrict,
  device_user_id text not null check (length(btrim(device_user_id)) between 1 and 64),
  enrollment_status text not null default 'pending'
    check (enrollment_status in ('pending','awaiting_scan','scanning','enrolled','failed','disabled')),
  enrolled_at timestamptz,
  last_synced_at timestamptz,
  disabled_at timestamptz,
  unique (device_id, device_user_id),
  unique (device_id, employee_id),
  constraint employee_devices_enrollment_time_check check (
    (enrollment_status = 'enrolled' and enrolled_at is not null) or
    (enrollment_status <> 'enrolled' and enrolled_at is null)
  ),
  constraint employee_devices_disabled_time_check check (
    (disabled_at is null) = (enrollment_status <> 'disabled')
  )
);

create table if not exists public.attendance_events (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.attendance_devices(id) on delete restrict,
  employee_id uuid references public.employees(id) on delete set null,
  device_user_id text not null check (length(btrim(device_user_id)) between 1 and 64),
  occurred_at timestamptz not null,
  device_timestamp text not null check (length(device_timestamp) between 1 and 64),
  timezone text not null check (length(timezone) between 1 and 64),
  verify_mode integer not null check (verify_mode between 0 and 255),
  raw_state integer not null check (raw_state between 0 and 255),
  resolved_kind text check (resolved_kind in ('check_in','check_out','break','ot','ignored')),
  work_code integer check (work_code between -2147483648 and 2147483647),
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  resolution_status text not null default 'pending'
    check (resolution_status in ('pending','resolved','unresolved','failed','ignored')),
  created_at timestamptz not null default now(),
  unique (device_id, payload_hash),
  constraint attendance_events_resolution_kind_check check (
    (resolution_status = 'resolved' and resolved_kind in ('check_in','check_out','break','ot')) or
    (resolution_status = 'ignored' and resolved_kind = 'ignored') or
    (resolution_status not in ('resolved','ignored') and resolved_kind is null)
  )
);

create table if not exists public.device_commands (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.attendance_devices(id) on delete restrict,
  employee_id uuid references public.employees(id) on delete set null,
  type text not null check (type in (
    'create_user','update_user','start_enrollment','disable_user','delete_user'
  )),
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  idempotency_key text not null check (length(btrim(idempotency_key)) between 1 and 160),
  status text not null default 'pending'
    check (status in ('pending','processing','completed','failed','cancelled')),
  attempts integer not null default 0 check (attempts >= 0),
  lease_expires_at timestamptz,
  last_error text check (last_error is null or length(last_error) <= 2000),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (device_id, idempotency_key),
  constraint device_commands_terminal_time_check check (
    (status in ('completed','failed','cancelled') and processed_at is not null) or
    (status not in ('completed','failed','cancelled') and processed_at is null)
  )
);

alter table public.attendance
  add column if not exists source text not null default 'manual'
    check (source in ('manual','device')),
  add column if not exists device_id uuid references public.attendance_devices(id) on delete restrict,
  add column if not exists check_in_event_id uuid references public.attendance_events(id) on delete set null,
  add column if not exists check_out_event_id uuid references public.attendance_events(id) on delete set null,
  add column if not exists updated_at timestamptz not null default now();

-- Validate an existing installation before making the one-open-row rule mandatory.
do $$
begin
  if exists (
    select employee_id, work_date
    from public.attendance
    where check_out is null
    group by employee_id, work_date
    having count(*) > 1
  ) then
    raise exception 'ATTENDANCE_OPEN_DUPLICATES: close duplicate open rows before installing ZKTeco attendance';
  end if;
end;
$$;

create unique index if not exists attendance_one_open_per_employee_day
  on public.attendance (employee_id, work_date)
  where check_out is null;
create unique index if not exists attendance_check_in_event_idx
  on public.attendance (check_in_event_id) where check_in_event_id is not null;
create unique index if not exists attendance_check_out_event_idx
  on public.attendance (check_out_event_id) where check_out_event_id is not null;
create index if not exists attendance_device_day_idx on public.attendance (device_id, work_date);
create index if not exists attendance_events_employee_time_idx
  on public.attendance_events (employee_id, occurred_at desc);
create index if not exists attendance_events_unresolved_idx
  on public.attendance_events (device_id, created_at)
  where resolution_status in ('pending','unresolved','failed');
create index if not exists employee_devices_employee_idx on public.employee_devices (employee_id);
create index if not exists device_commands_pull_idx
  on public.device_commands (device_id, created_at)
  where status in ('pending','processing');

-- ---------------------------------------------------------------------------
-- Validation and audit helpers
-- ---------------------------------------------------------------------------

create or replace function public._zkteco_validate_timezone()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (select 1 from pg_catalog.pg_timezone_names t where t.name = new.timezone) then
    raise exception 'INVALID_TIMEZONE' using errcode = '22023';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_zkteco_device_timezone on public.attendance_devices;
create trigger trg_zkteco_device_timezone
before insert or update of timezone on public.attendance_devices
for each row execute function public._zkteco_validate_timezone();

drop trigger if exists trg_zkteco_event_timezone on public.attendance_events;
create trigger trg_zkteco_event_timezone
before insert or update of timezone on public.attendance_events
for each row execute function public._zkteco_validate_timezone();

create or replace function public._zkteco_touch_device()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_zkteco_device_updated on public.attendance_devices;
create trigger trg_zkteco_device_updated
before update on public.attendance_devices
for each row execute function public._zkteco_touch_device();

create or replace function public._zkteco_has_biometric_key(p_value jsonb)
returns boolean
language plpgsql
immutable strict
set search_path = ''
as $$
declare
  v_key text;
  v_item jsonb;
begin
  case jsonb_typeof(p_value)
    when 'object' then
      for v_key, v_item in select key, value from jsonb_each(p_value) loop
        if v_key ~* '(template|fingerprint|biometric)'
          or public._zkteco_has_biometric_key(v_item) then
          return true;
        end if;
      end loop;
    when 'array' then
      for v_item in select value from jsonb_array_elements(p_value) loop
        if public._zkteco_has_biometric_key(v_item) then
          return true;
        end if;
      end loop;
    else
      null;
  end case;
  return false;
end;
$$;

create or replace function public._zkteco_validate_command()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if jsonb_typeof(new.payload) is distinct from 'object'
    or public._zkteco_has_biometric_key(new.payload) then
    raise exception 'INVALID_DEVICE_COMMAND_PAYLOAD' using errcode = '23514';
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'pending' or new.attempts <> 0
      or new.processed_at is not null or new.last_error is not null then
      raise exception 'INVALID_NEW_COMMAND_STATE' using errcode = '23514';
    end if;
  else
    if new.id <> old.id or new.device_id <> old.device_id
      or new.employee_id is distinct from old.employee_id
      or new.type <> old.type or new.payload <> old.payload
      or new.idempotency_key <> old.idempotency_key
      or new.created_by <> old.created_by or new.created_at <> old.created_at then
      raise exception 'DEVICE_COMMAND_IMMUTABLE' using errcode = '23514';
    end if;
    if old.status in ('completed','failed','cancelled') then
      raise exception 'TERMINAL_COMMAND_IMMUTABLE' using errcode = '23514';
    end if;
    if new.status not in ('processing','completed','failed','cancelled') then
      raise exception 'INVALID_COMMAND_TRANSITION' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_zkteco_command_validation on public.device_commands;
create trigger trg_zkteco_command_validation
before insert or update on public.device_commands
for each row execute function public._zkteco_validate_command();

create or replace function public._zkteco_validate_attendance()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_correction boolean := false;
begin
  if new.check_in is null or (new.check_out is not null and new.check_out < new.check_in) then
    raise exception 'INVALID_ATTENDANCE_TIMES' using errcode = '23514';
  end if;
  if new.source not in ('manual','device') then
    raise exception 'INVALID_ATTENDANCE_SOURCE' using errcode = '23514';
  end if;
  if new.source = 'device' then
    if new.device_id is null or new.check_in_event_id is null then
      raise exception 'DEVICE_ATTENDANCE_REQUIRES_DEVICE_AND_EVENT' using errcode = '23514';
    end if;
    if new.check_in_event_id = new.check_out_event_id then
      raise exception 'ATTENDANCE_EVENTS_MUST_DIFFER' using errcode = '23514';
    end if;
  elsif new.device_id is not null or new.check_in_event_id is not null then
    raise exception 'MANUAL_ATTENDANCE_HAS_NO_DEVICE_CHECK_IN' using errcode = '23514';
  end if;

  if tg_op = 'UPDATE' then
    v_correction := coalesce(current_setting('zkteco.attendance_correction_id', true), '') = new.id::text
      and public.has_perm('attendance.manage');
    if new.id <> old.id or new.employee_id <> old.employee_id
      or new.source <> old.source or new.device_id is distinct from old.device_id then
      raise exception 'ATTENDANCE_IDENTITY_IMMUTABLE' using errcode = '23514';
    end if;
    if new.check_in_event_id is distinct from old.check_in_event_id then
      raise exception 'CHECK_IN_EVENT_IMMUTABLE' using errcode = '23514';
    end if;
    if new.check_out_event_id is distinct from old.check_out_event_id
      and (old.check_out_event_id is not null or new.check_out_event_id is null) then
      raise exception 'CHECK_OUT_EVENT_IMMUTABLE' using errcode = '23514';
    end if;
    if new.check_out is null and old.check_out is not null then
      raise exception 'CANNOT_REOPEN_ATTENDANCE' using errcode = '23514';
    end if;
    if not v_correction then
      if new.check_in is distinct from old.check_in or new.work_date is distinct from old.work_date
        or new.note is distinct from old.note then
        raise exception 'ATTENDANCE_CORRECTION_REQUIRED' using errcode = '42501';
      end if;
      if old.check_out is not null and new.check_out is distinct from old.check_out then
        raise exception 'CLOSED_ATTENDANCE_USE_CORRECTION_RPC' using errcode = '42501';
      end if;
      if new.check_out is not null and old.check_out is not null and new.check_out <= old.check_out then
        raise exception 'INVALID_CHECK_OUT_UPDATE' using errcode = '23514';
      end if;
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_zkteco_attendance_validation on public.attendance;
create trigger trg_zkteco_attendance_validation
before insert or update on public.attendance
for each row execute function public._zkteco_validate_attendance();

-- Event resolution happens after the daily row is linked in apply_attendance_event.
-- A deferred constraint validates the final, committed state without a circular
-- insert dependency while still rejecting invalid links at transaction commit.
create or replace function public._zkteco_validate_attendance_event_links()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.source = 'device' and not exists (
    select 1 from public.attendance_events e
    where e.id = new.check_in_event_id and e.device_id = new.device_id
      and e.employee_id = new.employee_id and e.resolution_status = 'resolved'
      and e.resolved_kind = 'check_in'
  ) then
    raise exception 'INVALID_CHECK_IN_EVENT' using errcode = '23514';
  end if;
  if new.check_out_event_id is not null and not exists (
    select 1 from public.attendance_events e
    where e.id = new.check_out_event_id
      and e.employee_id = new.employee_id and e.resolution_status = 'resolved'
      and e.resolved_kind = 'check_out'
      and (new.source = 'manual' or e.device_id = new.device_id)
  ) then
    raise exception 'INVALID_CHECK_OUT_EVENT' using errcode = '23514';
  end if;
  return null;
end;
$$;

drop trigger if exists trg_zkteco_attendance_event_links on public.attendance;
create constraint trigger trg_zkteco_attendance_event_links
after insert or update on public.attendance
deferrable initially deferred
for each row execute function public._zkteco_validate_attendance_event_links();

drop trigger if exists trg_audit_attendance on public.attendance;
create trigger trg_audit_attendance
after insert or update on public.attendance
for each row execute function public.audit_trigger();

create or replace function public._zkteco_validate_event()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_admin_correction boolean := false;
begin
  if tg_op = 'INSERT' then
    if new.resolution_status <> 'pending' or new.resolved_kind is not null
      or new.employee_id is not null then
      raise exception 'RAW_EVENT_MUST_START_PENDING' using errcode = '23514';
    end if;
  else
    if old.resolution_status = 'resolved' then
      raise exception 'RESOLVED_EVENT_IMMUTABLE' using errcode = '23514';
    end if;
    v_admin_correction := coalesce(current_setting('zkteco.event_correction_id', true), '') = old.id::text
      and public.has_perm('attendance.manage');
    if new.id <> old.id or new.device_id <> old.device_id
      or new.device_user_id <> old.device_user_id
      or new.device_timestamp <> old.device_timestamp or new.timezone <> old.timezone
      or new.verify_mode <> old.verify_mode or new.raw_state <> old.raw_state
      or new.work_code is distinct from old.work_code or new.payload_hash <> old.payload_hash
      or new.created_at <> old.created_at or new.occurred_at is distinct from old.occurred_at then
      if not v_admin_correction then
        raise exception 'RAW_EVENT_IMMUTABLE' using errcode = '23514';
      end if;
    end if;
    if old.resolution_status = 'ignored' and new.resolution_status <> 'ignored'
      and not v_admin_correction then
      raise exception 'IGNORED_EVENT_REQUIRES_ADMIN_RESOLUTION' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_zkteco_event_validation on public.attendance_events;
create trigger trg_zkteco_event_validation
before insert or update on public.attendance_events
for each row execute function public._zkteco_validate_event();

-- LX15 states: 0 check-in, 1 check-out, 2/3 break-out/in, 4/5 OT-in/out.
-- Only explicit state mappings become attendance; unsupported states are retained as ignored.
create or replace function public._zkteco_device_event_kind(p_verify integer, p_state integer)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_state text;
begin
  if p_verify not between 0 and 3 then
    return null;
  end if;
  v_state := lpad(to_hex(p_state), 2, '0');
  return case v_state
    when '00' then 'check_in'
    when '01' then 'check_out'
    when '02' then 'break'
    when '03' then 'break'
    when '04' then 'ot'
    when '05' then 'ot'
    else null
  end;
end;
$$;

create or replace function public._zkteco_policy_device_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select id from public.attendance_devices order by created_at, id limit 1;
$$;

create or replace function public._zkteco_finish_event(
  p_event_id uuid, p_status text, p_kind text, p_attendance_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event public.attendance_events%rowtype;
  v_audit_id bigint;
begin
  update public.attendance_events
  set resolution_status = p_status, resolved_kind = p_kind
  where id = p_event_id
  returning * into v_event;
  if not found then raise exception 'EVENT_NOT_FOUND' using errcode = 'P0002'; end if;
  insert into public.audit_logs (user_id, action, entity, entity_id, details)
  values (
    auth.uid(), 'zkteco.apply_attendance_event', 'attendance_events', p_event_id::text,
    jsonb_build_object('event_id', p_event_id, 'attendance_id', p_attendance_id,
      'resolution_status', p_status, 'resolved_kind', p_kind,
      'device_id', v_event.device_id, 'occurred_at', v_event.occurred_at)
  ) returning id into v_audit_id;
  return jsonb_build_object(
    'event_id', p_event_id, 'employee_id', v_event.employee_id,
    'resolution_status', p_status, 'resolved_kind', p_kind,
    'attendance_id', p_attendance_id, 'replayed', false, 'audit_id', v_audit_id
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Transactional attendance state machine
-- ---------------------------------------------------------------------------

create or replace function public.apply_attendance_event(p_event_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event public.attendance_events%rowtype;
  v_device public.attendance_devices%rowtype;
  v_employee_id uuid;
  v_work_date date;
  v_kind text;
  v_attendance_id uuid;
  v_open_id uuid;
  v_open_check_in timestamptz;
  v_latest_check_in timestamptz;
  v_manual_resolution boolean := false;
begin
  select * into v_event from public.attendance_events where id = p_event_id for update;
  if not found then raise exception 'EVENT_NOT_FOUND' using errcode = 'P0002'; end if;

  if v_event.resolution_status <> 'pending' then
    return jsonb_build_object(
      'event_id', v_event.id, 'employee_id', v_event.employee_id,
      'resolution_status', v_event.resolution_status, 'resolved_kind', v_event.resolved_kind,
      'attendance_id', case v_event.resolved_kind
        when 'check_in' then (select a.id from public.attendance a where a.check_in_event_id = v_event.id)
        when 'check_out' then (select a.id from public.attendance a where a.check_out_event_id = v_event.id)
        else null end,
      'replayed', true
    );
  end if;

  select * into v_device from public.attendance_devices where id = v_event.device_id for update;
  if not found then raise exception 'DEVICE_NOT_FOUND' using errcode = 'P0002'; end if;
  v_work_date := (v_event.occurred_at at time zone v_event.timezone)::date;

  if v_event.employee_id is null then
    select ed.employee_id into v_employee_id
    from public.employee_devices ed
    where ed.device_id = v_event.device_id and ed.device_user_id = v_event.device_user_id
      and ed.enrollment_status <> 'disabled';
  else
    v_employee_id := v_event.employee_id;
    if not exists (
      select 1 from public.employee_devices ed
      where ed.device_id = v_event.device_id and ed.employee_id = v_employee_id
        and ed.enrollment_status <> 'disabled'
    ) then
      v_employee_id := null;
    end if;
  end if;
  if v_employee_id is null then
    update public.attendance_events set employee_id = null where id = v_event.id;
    return public._zkteco_finish_event(v_event.id, 'unresolved', null, null);
  end if;

  update public.attendance_events set employee_id = v_employee_id where id = v_event.id;
  if v_device.attendance_mode = 'raw_only' then
    v_manual_resolution := coalesce(current_setting('zkteco.raw_resolution_event', true), '') = v_event.id::text;
    if not v_manual_resolution then
      return public._zkteco_finish_event(v_event.id, 'ignored', 'ignored', null);
    end if;
  end if;

  if v_device.attendance_mode = 'device_state' or v_manual_resolution then
    v_kind := public._zkteco_device_event_kind(v_event.verify_mode, v_event.raw_state);
    if v_kind is null then
      return public._zkteco_finish_event(v_event.id, 'ignored', 'ignored', null);
    end if;
  end if;

  -- Serialize the whole employee/workday, including the alternating decision.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    v_employee_id::text || ':' || v_work_date::text, 0
  ));

  if v_device.attendance_mode = 'alternating' and not v_manual_resolution then
    select a.id, a.check_in into v_open_id, v_open_check_in
    from public.attendance a
    where a.employee_id = v_employee_id and a.work_date = v_work_date and a.check_out is null
    order by a.check_in, a.id limit 1 for update of a;
    v_kind := case when v_open_id is null then 'check_in' else 'check_out' end;
  else
    select a.id, a.check_in into v_open_id, v_open_check_in
    from public.attendance a
    where a.employee_id = v_employee_id and a.work_date = v_work_date and a.check_out is null
    order by a.check_in, a.id limit 1 for update of a;
  end if;

  if v_kind = 'check_in' then
    if v_open_id is not null then
      return public._zkteco_finish_event(v_event.id, 'ignored', 'ignored', null);
    end if;
    select a.check_in into v_latest_check_in
    from public.attendance a
    where a.employee_id = v_employee_id and a.work_date = v_work_date
    order by a.check_in desc, a.id desc limit 1;
    if v_latest_check_in is not null and v_event.occurred_at <= v_latest_check_in then
      return public._zkteco_finish_event(v_event.id, 'ignored', 'ignored', null);
    end if;
    insert into public.attendance (
      employee_id, check_in, work_date, source, device_id, check_in_event_id
    ) values (
      v_employee_id, v_event.occurred_at, v_work_date, 'device', v_event.device_id, v_event.id
    ) returning id into v_attendance_id;
  elsif v_kind = 'check_out' then
    if v_open_id is null or v_event.occurred_at <= v_open_check_in then
      -- Never invent a check-in for an orphan or out-of-order check-out.
      return public._zkteco_finish_event(v_event.id, 'ignored', 'ignored', null);
    end if;
    update public.attendance
    set check_out = v_event.occurred_at, check_out_event_id = v_event.id
    where id = v_open_id
    returning id into v_attendance_id;
  else
    -- Break and OT remain resolved raw facts but do not alter v1 daily times.
    return public._zkteco_finish_event(v_event.id, 'resolved', v_kind, null);
  end if;

  return public._zkteco_finish_event(v_event.id, 'resolved', v_kind, v_attendance_id);
end;
$$;

comment on function public.apply_attendance_event(uuid) is
  'Privileged device-sync RPC: locks the event and employee/workday, resolves identity/policy, links one daily row, and replays without rewriting resolved history.';

-- ---------------------------------------------------------------------------
-- Admin RPCs: permission-aware, idempotent, and audited. Plaintext tokens and
-- biometric payloads are never accepted, returned, or included in audit details.
-- ---------------------------------------------------------------------------

create or replace function public.zkteco_upsert_device(
  p_device jsonb, p_token_hash text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_hash text := lower(coalesce(p_token_hash, ''));
  v_revoke boolean := false;
  v_allowed text[] := array[
    'id','name','serial_number','usb_vid','usb_pid','status','background_mode',
    'attendance_mode','timezone','revoke_token'
  ];
begin
  perform public.assert_perm('device.manage');
  if jsonb_typeof(p_device) is distinct from 'object' then
    raise exception 'INVALID_DEVICE' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_object_keys(p_device) k where k not in (select * from unnest(v_allowed))) then
    raise exception 'INVALID_DEVICE_FIELDS' using errcode = '22023';
  end if;
  if v_hash <> '' and v_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_TOKEN_HASH' using errcode = '23514';
  end if;
  if p_device ? 'revoke_token' then
    if jsonb_typeof(p_device -> 'revoke_token') is distinct from 'boolean' then
      raise exception 'INVALID_DEVICE_FIELDS' using errcode = '22023';
    end if;
    v_revoke := (p_device ->> 'revoke_token')::boolean;
  end if;
  if v_revoke and v_hash <> '' then
    raise exception 'TOKEN_ROTATION_AND_REVOCATION_CONFLICT' using errcode = '23514';
  end if;

  if p_device ? 'id' then
    v_id := (p_device ->> 'id')::uuid;
    update public.attendance_devices d set
      name = coalesce(p_device ->> 'name', d.name),
      serial_number = case when p_device ? 'serial_number'
        then nullif(btrim(p_device ->> 'serial_number'), '') else d.serial_number end,
      usb_vid = coalesce(p_device ->> 'usb_vid', d.usb_vid),
      usb_pid = coalesce(p_device ->> 'usb_pid', d.usb_pid),
      status = coalesce(p_device ->> 'status', d.status),
      background_mode = coalesce(p_device ->> 'background_mode', d.background_mode),
      attendance_mode = coalesce(p_device ->> 'attendance_mode', d.attendance_mode),
      timezone = coalesce(p_device ->> 'timezone', d.timezone),
      device_token_hash = case
        when v_revoke then null
        when v_hash <> '' then v_hash
        else d.device_token_hash end
    where d.id = v_id
    returning id into v_id;
    if v_id is null then raise exception 'DEVICE_NOT_FOUND' using errcode = 'P0002'; end if;
  else
    if p_device ? 'revoke_token' then
      raise exception 'NEW_DEVICE_CANNOT_REVOKE_TOKEN' using errcode = '23514';
    end if;
    insert into public.attendance_devices (
      name, serial_number, usb_vid, usb_pid, status, background_mode,
      attendance_mode, timezone, device_token_hash
    ) values (
      p_device ->> 'name', nullif(btrim(p_device ->> 'serial_number'), ''),
      coalesce(p_device ->> 'usb_vid', '1B55'), coalesce(p_device ->> 'usb_pid', '0A01'),
      coalesce(p_device ->> 'status', 'offline'),
      coalesce(p_device ->> 'background_mode', 'app_only'),
      coalesce(p_device ->> 'attendance_mode', 'alternating'),
      coalesce(p_device ->> 'timezone', 'Africa/Cairo'), nullif(v_hash, '')
    ) returning id into v_id;
  end if;

  insert into public.audit_logs (user_id, action, entity, entity_id, details)
  values (
    auth.uid(), 'zkteco.upsert_device', 'attendance_devices', v_id::text,
    jsonb_build_object('device_id', v_id, 'settings', p_device - 'revoke_token',
      'token_changed', v_hash <> '', 'token_revoked', v_revoke)
  );
  return jsonb_build_object('ok', true, 'id', v_id, 'token_changed', v_hash <> '', 'token_revoked', v_revoke);
end;
$$;

create or replace function public.zkteco_enroll_employee(
  p_employee_id uuid, p_type text, p_idempotency_key text,
  p_device_user_id text default null, p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device public.attendance_devices%rowtype;
  v_mapping_id uuid;
  v_user_id text;
  v_name text;
  v_privilege integer := 0;
  v_command_id uuid;
  v_existing public.device_commands%rowtype;
  v_key text := btrim(coalesce(p_idempotency_key, ''));
  v_next_user_id bigint;
begin
  perform public.assert_perm('employees.manage');
  if p_type is null or p_type not in ('create_user','update_user','start_enrollment','disable_user','delete_user') then
    raise exception 'INVALID_DEVICE_COMMAND' using errcode = '23514';
  end if;
  if length(v_key) not between 1 and 160 then
    raise exception 'INVALID_IDEMPOTENCY_KEY' using errcode = '23514';
  end if;
  if jsonb_typeof(p_payload) is distinct from 'object'
    or public._zkteco_has_biometric_key(p_payload)
    or exists (select 1 from jsonb_object_keys(p_payload) k where k <> 'privilege') then
    raise exception 'INVALID_DEVICE_COMMAND_PAYLOAD' using errcode = '23514';
  end if;
  if p_payload ? 'privilege' then
    if jsonb_typeof(p_payload -> 'privilege') is distinct from 'number' then
      raise exception 'INVALID_DEVICE_COMMAND_PAYLOAD' using errcode = '23514';
    end if;
    if (p_payload ->> 'privilege')::numeric <> trunc((p_payload ->> 'privilege')::numeric) then
      raise exception 'INVALID_DEVICE_COMMAND_PAYLOAD' using errcode = '23514';
    end if;
    v_privilege := (p_payload ->> 'privilege')::integer;
    if v_privilege not between 0 and 2 then
      raise exception 'INVALID_DEVICE_COMMAND_PAYLOAD' using errcode = '23514';
    end if;
  end if;

  select * into v_device from public.attendance_devices
  order by created_at, id limit 1 for update;
  if not found then raise exception 'DEVICE_NOT_CONFIGURED' using errcode = 'P0002'; end if;
  select full_name into v_name from public.employees where id = p_employee_id;
  if not found then raise exception 'EMPLOYEE_NOT_FOUND' using errcode = 'P0002'; end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    v_device.id::text || ':' || v_key, 0
  ));
  select * into v_existing from public.device_commands
  where device_id = v_device.id and idempotency_key = v_key;
  if found then
    if v_existing.employee_id is distinct from p_employee_id or v_existing.type <> p_type then
      raise exception 'IDEMPOTENCY_KEY_CONFLICT' using errcode = '23514';
    end if;
    return jsonb_build_object('ok', true, 'id', v_existing.id, 'status', v_existing.status,
      'device_user_id', v_existing.payload ->> 'device_user_id', 'replayed', true);
  end if;

  select id, device_user_id into v_mapping_id, v_user_id
  from public.employee_devices
  where employee_id = p_employee_id and device_id = v_device.id
  for update;
  if v_mapping_id is null then
    if p_type not in ('create_user','update_user') then
      raise exception 'DEVICE_MAPPING_NOT_FOUND' using errcode = 'P0002';
    end if;
    if coalesce(btrim(p_device_user_id), '') = '' then
      -- The device row lock serializes reservation of the next stable numeric ID.
      select coalesce(max(reserved_id), 1000) + 1 into v_next_user_id
      from (
        select device_user_id::bigint as reserved_id from public.employee_devices
        where device_id = v_device.id and device_user_id ~ '^[0-9]+$'
        union all
        select (payload ->> 'device_user_id')::bigint as reserved_id from public.device_commands
        where device_id = v_device.id and payload ->> 'device_user_id' ~ '^[0-9]+$'
      ) reserved;
      if v_next_user_id > 2147483647 then
        raise exception 'DEVICE_USER_ID_SPACE_EXHAUSTED' using errcode = '23514';
      end if;
      v_user_id := v_next_user_id::text;
    else
      v_user_id := btrim(p_device_user_id);
    end if;
    if length(v_user_id) not between 1 and 64 then
      raise exception 'INVALID_DEVICE_USER_ID' using errcode = '23514';
    end if;
    if exists (
      select 1 from public.device_commands c
      where c.device_id = v_device.id and c.payload ->> 'device_user_id' = v_user_id
        and c.employee_id is distinct from p_employee_id
    ) then
      raise exception 'DEVICE_USER_ID_ALREADY_RESERVED' using errcode = '23514';
    end if;
    insert into public.employee_devices (employee_id, device_id, device_user_id, enrollment_status)
    values (p_employee_id, v_device.id, v_user_id, 'pending')
    returning id into v_mapping_id;
  elsif coalesce(btrim(p_device_user_id), '') <> '' and btrim(p_device_user_id) <> v_user_id then
    raise exception 'DEVICE_USER_ID_IMMUTABLE' using errcode = '23514';
  end if;

  if exists (
    select 1 from public.device_commands
    where device_id = v_device.id and employee_id = p_employee_id
      and status in ('pending','processing') and type = p_type
  ) then
    raise exception 'DEVICE_COMMAND_ALREADY_PENDING' using errcode = '23514';
  end if;

  insert into public.device_commands (
    device_id, employee_id, type, payload, idempotency_key, created_by
  ) values (
    v_device.id, p_employee_id, p_type,
    jsonb_build_object('device_user_id', v_user_id, 'name', v_name, 'privilege', v_privilege),
    v_key, auth.uid()
  ) returning id into v_command_id;

  if p_type = 'create_user' then
    update public.employee_devices
    set enrollment_status = 'pending', enrolled_at = null, disabled_at = null
    where id = v_mapping_id;
  elsif p_type = 'start_enrollment' then
    update public.employee_devices
    set enrollment_status = 'awaiting_scan', enrolled_at = null, disabled_at = null
    where id = v_mapping_id;
  elsif p_type in ('disable_user','delete_user') then
    update public.employee_devices
    set enrollment_status = 'disabled', enrolled_at = null, disabled_at = now()
    where id = v_mapping_id;
  end if;

  insert into public.audit_logs (user_id, action, entity, entity_id, details)
  values (
    auth.uid(), 'zkteco.enroll_employee', 'device_commands', v_command_id::text,
    jsonb_build_object('command_id', v_command_id, 'type', p_type,
      'employee_id', p_employee_id, 'device_id', v_device.id,
      'device_user_id', v_user_id, 'idempotency_key', v_key)
  );
  return jsonb_build_object('ok', true, 'id', v_command_id, 'status', 'pending',
    'device_user_id', v_user_id, 'replayed', false);
end;
$$;

create or replace function public.zkteco_update_enrollment(
  p_employee_id uuid, p_status text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device_id uuid := public._zkteco_policy_device_id();
begin
  perform public.assert_perm('employees.manage');
  if p_status not in ('pending','awaiting_scan','scanning','enrolled','failed','disabled') then
    raise exception 'INVALID_ENROLLMENT_STATUS' using errcode = '23514';
  end if;
  update public.employee_devices
  set enrollment_status = p_status,
      enrolled_at = case when p_status = 'enrolled' then now() else null end,
      disabled_at = case when p_status = 'disabled' then now() else null end,
      last_synced_at = now()
  where employee_id = p_employee_id and device_id = v_device_id;
  if not found then raise exception 'DEVICE_MAPPING_NOT_FOUND' using errcode = 'P0002'; end if;
  insert into public.audit_logs (user_id, action, entity, entity_id, details)
  values (
    auth.uid(), 'zkteco.update_enrollment', 'employee_devices', p_employee_id::text,
    jsonb_build_object('employee_id', p_employee_id, 'status', p_status, 'device_id', v_device_id)
  );
  return jsonb_build_object('ok', true);
end;
$$;

-- The bridge calls this service-only RPC. Command terminal state and the related
-- enrollment mapping change in one transaction, so retries cannot half-complete.
create or replace function public.zkteco_finish_command(
  p_command_id uuid, p_device_id uuid, p_idempotency_key text,
  p_status text, p_error text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_command public.device_commands%rowtype;
  v_message text := nullif(btrim(coalesce(p_error, '')), '');
begin
  if p_status not in ('completed','failed') then
    raise exception 'INVALID_COMMAND_STATUS' using errcode = '23514';
  end if;
  if p_status = 'failed' and (v_message is null or length(v_message) > 2000) then
    raise exception 'INVALID_COMMAND_ERROR' using errcode = '23514';
  end if;
  if p_status = 'completed' and v_message is not null then
    raise exception 'COMPLETED_COMMAND_CANNOT_HAVE_ERROR' using errcode = '23514';
  end if;

  select * into v_command from public.device_commands
  where id = p_command_id and device_id = p_device_id
    and idempotency_key = p_idempotency_key
  for update;
  if not found then raise exception 'DEVICE_COMMAND_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_command.status in ('completed','failed','cancelled') then
    if v_command.status = p_status then
      return jsonb_build_object('ok', true, 'command_id', p_command_id,
        'status', v_command.status, 'replayed', true);
    end if;
    raise exception 'COMMAND_STATE_CONFLICT' using errcode = 'P0004';
  end if;

  update public.device_commands
  set status = p_status, attempts = attempts + 1,
      last_error = case when p_status = 'failed' then v_message else null end,
      processed_at = now()
  where id = p_command_id;

  if v_command.employee_id is not null then
    if p_status = 'completed' and v_command.type = 'start_enrollment' then
      update public.employee_devices
      set enrollment_status = 'enrolled', enrolled_at = now(), disabled_at = null,
          last_synced_at = now()
      where employee_id = v_command.employee_id and device_id = p_device_id;
    elsif p_status = 'completed' and v_command.type in ('disable_user','delete_user') then
      update public.employee_devices
      set enrollment_status = 'disabled', enrolled_at = null, disabled_at = now(),
          last_synced_at = now()
      where employee_id = v_command.employee_id and device_id = p_device_id;
    elsif p_status = 'failed' and v_command.type in ('disable_user','delete_user') then
      update public.employee_devices
      set enrollment_status = 'disabled', enrolled_at = null, disabled_at = now(),
          last_synced_at = now()
      where employee_id = v_command.employee_id and device_id = p_device_id;
    elsif p_status = 'failed' then
      update public.employee_devices
      set enrollment_status = 'failed', enrolled_at = null, disabled_at = null,
          last_synced_at = now()
      where employee_id = v_command.employee_id and device_id = p_device_id;
    else
      update public.employee_devices set last_synced_at = now()
      where employee_id = v_command.employee_id and device_id = p_device_id;
    end if;
  end if;

  insert into public.audit_logs (user_id, action, entity, entity_id, details)
  values (
    auth.uid(), case when p_status = 'completed' then 'zkteco.complete_command' else 'zkteco.fail_command' end,
    'device_commands', p_command_id::text,
    jsonb_build_object('command_id', p_command_id, 'device_id', p_device_id,
      'employee_id', v_command.employee_id, 'type', v_command.type, 'status', p_status)
  );
  return jsonb_build_object('ok', true, 'command_id', p_command_id,
    'status', p_status, 'replayed', false);
end;
$$;

create or replace function public.zkteco_claim_commands(p_device_id uuid, p_limit integer default 50)
returns setof public.device_commands
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_limit < 1 or p_limit > 50 then
    raise exception 'INVALID_COMMAND_LIMIT' using errcode = '22023';
  end if;
  return query
  with claimed as (
    select c.id
    from public.device_commands c
    where c.device_id = p_device_id
      and (c.status = 'pending' or (c.status = 'processing' and c.lease_expires_at < now()))
    order by c.created_at, c.id
    for update skip locked
    limit p_limit
  )
  update public.device_commands c
  set status = 'processing', attempts = c.attempts + 1, lease_expires_at = now() + interval '2 minutes'
  from claimed
  where c.id = claimed.id
  returning c.*;
end;
$$;

create or replace function public.zkteco_resolve_event(
  p_event_id uuid, p_action text, p_employee_id uuid default null,
  p_occurred_at timestamptz default null, p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event public.attendance_events%rowtype;
  v_employee_id uuid;
  v_result jsonb;
begin
  perform public.assert_perm('attendance.manage');
  if p_note is not null and length(p_note) > 2000 then
    raise exception 'INVALID_RESOLUTION_NOTE' using errcode = '23514';
  end if;
  select * into v_event from public.attendance_events where id = p_event_id for update;
  if not found then raise exception 'EVENT_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_event.resolution_status = 'resolved' then
    raise exception 'RESOLVED_EVENT_USE_ATTENDANCE_CORRECTION' using errcode = '23514';
  end if;
  if p_action not in ('ignore','retry') then
    raise exception 'INVALID_EVENT_ACTION' using errcode = '23514';
  end if;

  if p_action = 'ignore' then
    if p_employee_id is not null or p_occurred_at is not null then
      raise exception 'IGNORE_ACTION_CANNOT_CORRECT_EVENT' using errcode = '23514';
    end if;
    update public.attendance_events
    set resolution_status = 'ignored', resolved_kind = 'ignored'
    where id = p_event_id;
    insert into public.audit_logs (user_id, action, entity, entity_id, details)
    values (
      auth.uid(), 'zkteco.resolve_event', 'attendance_events', p_event_id::text,
      jsonb_build_object('event_id', p_event_id, 'action', 'ignore',
        'previous_status', v_event.resolution_status, 'note', p_note)
    );
    return jsonb_build_object('ok', true, 'event_id', p_event_id, 'resolution_status', 'ignored');
  end if;

  v_employee_id := coalesce(p_employee_id, v_event.employee_id);
  if v_employee_id is not null then
    if not exists (select 1 from public.employees where id = v_employee_id) then
      raise exception 'EMPLOYEE_NOT_FOUND' using errcode = 'P0002';
    end if;
    if not exists (
      select 1 from public.employee_devices
      where device_id = v_event.device_id and employee_id = v_employee_id
    ) then
      raise exception 'EMPLOYEE_DEVICE_MAPPING_REQUIRED' using errcode = '23514';
    end if;
  end if;

  perform set_config('zkteco.event_correction_id', p_event_id::text, true);
  perform set_config('zkteco.raw_resolution_event', p_event_id::text, true);
  update public.attendance_events
  set employee_id = v_employee_id,
      occurred_at = coalesce(p_occurred_at, occurred_at),
      resolution_status = 'pending', resolved_kind = null
  where id = p_event_id;
  v_result := public.apply_attendance_event(p_event_id);
  perform set_config('zkteco.event_correction_id', '', true);
  perform set_config('zkteco.raw_resolution_event', '', true);

  insert into public.audit_logs (user_id, action, entity, entity_id, details)
  values (
    auth.uid(), 'zkteco.resolve_event', 'attendance_events', p_event_id::text,
    jsonb_build_object('event_id', p_event_id, 'action', 'retry',
      'previous_status', v_event.resolution_status, 'employee_id', v_employee_id,
      'occurred_at', coalesce(p_occurred_at, v_event.occurred_at), 'note', p_note,
      'result', v_result)
  );
  return v_result;
end;
$$;

create or replace function public.zkteco_correct_attendance(
  p_attendance_id uuid, p_check_in timestamptz default null,
  p_check_out timestamptz default null, p_note text default null, p_work_date date default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.attendance%rowtype;
  v_check_in timestamptz;
  v_check_out timestamptz;
  v_work_date date;
  v_conflict uuid;
begin
  perform public.assert_perm('attendance.manage');
  if p_note is not null and length(p_note) > 2000 then
    raise exception 'INVALID_ATTENDANCE_NOTE' using errcode = '23514';
  end if;
  select * into v_row from public.attendance where id = p_attendance_id;
  if not found then raise exception 'ATTENDANCE_NOT_FOUND' using errcode = 'P0002'; end if;
  v_check_in := coalesce(p_check_in, v_row.check_in);
  v_check_out := coalesce(p_check_out, v_row.check_out);
  v_work_date := coalesce(p_work_date, v_row.work_date);
  if v_check_out is not null and v_check_out < v_check_in then
    raise exception 'INVALID_ATTENDANCE_TIMES' using errcode = '23514';
  end if;

  -- Match apply_attendance_event's advisory-lock-before-row-lock order.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    v_row.employee_id::text || ':' || v_row.work_date::text, 0
  ));
  if v_work_date <> v_row.work_date then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      v_row.employee_id::text || ':' || v_work_date::text, 0
    ));
  end if;
  select * into v_row from public.attendance where id = p_attendance_id for update;
  if not found then raise exception 'ATTENDANCE_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_check_out is null then
    select a.id into v_conflict from public.attendance a
    where a.employee_id = v_row.employee_id and a.work_date = v_work_date
      and a.id <> p_attendance_id and a.check_out is null;
    if v_conflict is not null then
      raise exception 'ATTENDANCE_WORKDAY_ALREADY_OPEN' using errcode = '23514';
    end if;
  end if;

  perform set_config('zkteco.attendance_correction_id', p_attendance_id::text, true);
  update public.attendance
  set check_in = v_check_in, check_out = v_check_out, work_date = v_work_date,
      note = case when p_note is null then note else p_note end
  where id = p_attendance_id;
  perform set_config('zkteco.attendance_correction_id', '', true);

  insert into public.audit_logs (user_id, action, entity, entity_id, details)
  values (
    auth.uid(), 'zkteco.correct_attendance', 'attendance', p_attendance_id::text,
    jsonb_build_object('before', to_jsonb(v_row), 'check_in', v_check_in,
      'check_out', v_check_out, 'work_date', v_work_date, 'note', p_note)
  );
  return jsonb_build_object('ok', true, 'id', p_attendance_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants and row-level security. Raw events/commands/mappings/settings have no
-- client write grants or write policies; only the audited RPCs can mutate them.
-- Attendance writes use existing/new audited RPCs, never direct table DML.
-- ---------------------------------------------------------------------------

alter table public.attendance_devices enable row level security;
alter table public.employee_devices enable row level security;
alter table public.attendance_events enable row level security;
alter table public.device_commands enable row level security;
alter table public.attendance enable row level security;

revoke all on table public.attendance_devices, public.employee_devices,
  public.attendance_events, public.device_commands from anon, authenticated;
revoke all on table public.attendance from anon;
revoke insert, update, delete on table public.attendance from authenticated;
grant select on table public.attendance_devices, public.employee_devices,
  public.attendance_events, public.device_commands, public.attendance to authenticated;
grant select, insert, update on table public.attendance_devices,
  public.attendance_events, public.device_commands, public.attendance to service_role;
grant select, insert, update, delete on table public.employee_devices to service_role;
grant select, insert on table public.audit_logs to service_role;

revoke all on function public._zkteco_validate_timezone() from public, anon, authenticated;
revoke all on function public._zkteco_touch_device() from public, anon, authenticated;
revoke all on function public._zkteco_has_biometric_key(jsonb) from public, anon, authenticated;
revoke all on function public._zkteco_validate_command() from public, anon, authenticated;
revoke all on function public._zkteco_validate_attendance() from public, anon, authenticated;
revoke all on function public._zkteco_validate_attendance_event_links() from public, anon, authenticated;
revoke all on function public._zkteco_validate_event() from public, anon, authenticated;
revoke all on function public._zkteco_device_event_kind(integer, integer) from public, anon, authenticated;
revoke all on function public._zkteco_policy_device_id() from public, anon, authenticated;
revoke all on function public._zkteco_finish_event(uuid, text, text, uuid) from public, anon, authenticated;
revoke all on function public.apply_attendance_event(uuid) from public, anon, authenticated;
revoke all on function public.zkteco_finish_command(uuid, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.zkteco_claim_commands(uuid, integer) from public, anon, authenticated;
grant execute on function public.apply_attendance_event(uuid) to service_role;
grant execute on function public.zkteco_finish_command(uuid, uuid, text, text, text) to service_role;
grant execute on function public.zkteco_claim_commands(uuid, integer) to service_role;

revoke all on function public.zkteco_upsert_device(jsonb, text) from public, anon;
revoke all on function public.zkteco_enroll_employee(uuid, text, text, text, jsonb) from public, anon;
revoke all on function public.zkteco_update_enrollment(uuid, text) from public, anon;
revoke all on function public.zkteco_resolve_event(uuid, text, uuid, timestamptz, text) from public, anon;
revoke all on function public.zkteco_correct_attendance(uuid, timestamptz, timestamptz, text, date) from public, anon;
grant execute on function public.zkteco_upsert_device(jsonb, text) to authenticated;
grant execute on function public.zkteco_enroll_employee(uuid, text, text, text, jsonb) to authenticated;
grant execute on function public.zkteco_update_enrollment(uuid, text) to authenticated;
grant execute on function public.zkteco_resolve_event(uuid, text, uuid, timestamptz, text) to authenticated;
grant execute on function public.zkteco_correct_attendance(uuid, timestamptz, timestamptz, text, date) to authenticated;

-- Remove policies from an earlier draft if this migration is reapplied.
drop policy if exists attendance_insert on public.attendance;
drop policy if exists attendance_update on public.attendance;
drop policy if exists attendance_devices_no_client_write on public.attendance_devices;
drop policy if exists employee_devices_no_client_write on public.employee_devices;
drop policy if exists attendance_events_no_client_write on public.attendance_events;
drop policy if exists device_commands_no_client_write on public.device_commands;

drop policy if exists attendance_read on public.attendance;
create policy attendance_read on public.attendance for select to authenticated
using (
  public.has_perm('attendance.view') or public.has_perm('attendance.manage')
  or public.has_perm('employees.view') or public.has_perm('reports.view')
  or exists (
    select 1 from public.employees e
    where e.id = employee_id and e.profile_id = (select auth.uid())
  )
);

drop policy if exists attendance_devices_read on public.attendance_devices;
create policy attendance_devices_read on public.attendance_devices for select to authenticated
using (public.has_perm('device.manage'));

drop policy if exists employee_devices_read on public.employee_devices;
create policy employee_devices_read on public.employee_devices for select to authenticated
using (
  public.has_perm('employees.manage') or public.has_perm('attendance.view')
  or public.has_perm('attendance.manage')
);

drop policy if exists attendance_events_read on public.attendance_events;
create policy attendance_events_read on public.attendance_events for select to authenticated
using (
  public.has_perm('attendance.manage')
  or (public.has_perm('attendance.view') and resolution_status in ('resolved','ignored'))
);

drop policy if exists device_commands_read on public.device_commands;
create policy device_commands_read on public.device_commands for select to authenticated
using (public.has_perm('employees.manage') or public.has_perm('device.manage'));

comment on table public.attendance_devices is
  'LX15 identity, policy and token-hash metadata. Only device.manage readers and service_role can access it; plaintext tokens are never stored.';
comment on table public.attendance_events is
  'Append-only raw punches with audited resolution metadata. Fingerprint templates are prohibited.';
comment on table public.device_commands is
  'Idempotent five-action bridge queue. Writes require permission-aware admin RPCs or the service-only finish RPC.';
