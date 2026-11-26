-- Allow a super admin to bypass the ZKTeco attendance invariants when they
-- explicitly clean up or correct data from the Supabase dashboard/console.
create or replace function public._zkteco_validate_attendance()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_correction boolean := false;
  v_super_admin boolean := false;
begin
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'super_admin'
  ) into v_super_admin;

  if v_super_admin then
    new.updated_at := now();
    return new;
  end if;

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
