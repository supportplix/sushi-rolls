create or replace function public._zkteco_validate_command()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_employee_deleted boolean := false;
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
    -- The FK's nested ON DELETE SET NULL update must preserve terminal history.
    v_employee_deleted := old.employee_id is not null
      and new.employee_id is null
      and pg_trigger_depth() > 1
      and not exists (select 1 from public.employees e where e.id = old.employee_id);
    if (new.id <> old.id or new.device_id <> old.device_id
      or new.employee_id is distinct from old.employee_id
      or new.type <> old.type or new.payload <> old.payload
      or new.idempotency_key <> old.idempotency_key
      or new.created_by <> old.created_by or new.created_at <> old.created_at)
      and not v_employee_deleted then
      raise exception 'DEVICE_COMMAND_IMMUTABLE' using errcode = '23514';
    end if;
    if old.status in ('completed','failed','cancelled') and not v_employee_deleted then
      raise exception 'TERMINAL_COMMAND_IMMUTABLE' using errcode = '23514';
    end if;
    if new.status not in ('processing','completed','failed','cancelled') and not v_employee_deleted then
      raise exception 'INVALID_COMMAND_TRANSITION' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
