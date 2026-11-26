-- Idempotent attendance ingest.
--
-- The bridge may re-read the device log after a restart, so the same punch can
-- arrive with a new event_id but an existing payload_hash. Inserting the whole
-- batch with a single ON CONFLICT target made one duplicate fail the entire
-- batch (HTTP 409), and the bridge then marked every event as delivered.
-- This RPC skips any conflicting row (primary key or device/payload hash) and
-- reports how many rows were actually inserted.

create or replace function public.zkteco_ingest_events(
  p_device_id uuid,
  p_events jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event jsonb;
  v_id uuid;
  v_inserted integer := 0;
  v_ids uuid[] := '{}';
begin
  if p_device_id is null then
    raise exception 'DEVICE_REQUIRED' using errcode = '22023';
  end if;
  if p_events is null or jsonb_typeof(p_events) <> 'array' then
    raise exception 'EVENTS_REQUIRED' using errcode = '22023';
  end if;
  if not exists (select 1 from public.attendance_devices where id = p_device_id) then
    raise exception 'DEVICE_NOT_FOUND' using errcode = 'P0002';
  end if;

  for v_event in select * from jsonb_array_elements(p_events)
  loop
    v_id := (v_event ->> 'id')::uuid;
    insert into public.attendance_events (
      id, device_id, device_user_id, occurred_at, device_timestamp, timezone,
      verify_mode, raw_state, work_code, payload_hash, resolution_status
    ) values (
      v_id,
      p_device_id,
      v_event ->> 'device_user_id',
      (v_event ->> 'occurred_at')::timestamptz,
      v_event ->> 'device_timestamp',
      v_event ->> 'timezone',
      (v_event ->> 'verify_mode')::integer,
      (v_event ->> 'raw_state')::integer,
      nullif(v_event ->> 'work_code', '')::integer,
      v_event ->> 'payload_hash',
      'pending'
    )
    on conflict do nothing;

    if found then
      v_inserted := v_inserted + 1;
      v_ids := v_ids || v_id;
    end if;
  end loop;

  return jsonb_build_object('inserted', v_inserted, 'ids', to_jsonb(v_ids));
end;
$$;

comment on function public.zkteco_ingest_events(uuid, jsonb) is
  'Privileged device-sync RPC: inserts attendance events idempotently, skipping duplicate ids and device/payload hashes.';

revoke all on function public.zkteco_ingest_events(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.zkteco_ingest_events(uuid, jsonb) to service_role;
