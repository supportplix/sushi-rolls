-- SUSHI ROLLS — reserve a device user id without dispatching a device command.
--
-- The live enrollment flow used to enqueue a create_user command and then start a
-- watch enrollment; the bridge could execute both create paths at once (the
-- command queue and the watch's own EnsureUser), racing two DisableDevice +
-- SetUserInfo + RefreshData sequences on a single SDK handle and locking the
-- LX15. This RPC only reserves the mapping, so the watch enrollment is the
-- single owner of the terminal user creation.

create or replace function public.zkteco_reserve_device_user(
  p_employee_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device public.attendance_devices;
  v_mapping_id uuid;
  v_user_id text;
  v_next_user_id bigint;
begin
  perform public.assert_perm('employees.manage');

  select * into v_device from public.attendance_devices
  order by created_at, id limit 1 for update;
  if not found then raise exception 'DEVICE_NOT_CONFIGURED' using errcode = 'P0002'; end if;

  if not exists (select 1 from public.employees where id = p_employee_id) then
    raise exception 'EMPLOYEE_NOT_FOUND' using errcode = 'P0002';
  end if;

  select id, device_user_id into v_mapping_id, v_user_id
  from public.employee_devices
  where employee_id = p_employee_id and device_id = v_device.id
  for update;
  if v_mapping_id is null then
    -- The device row lock serializes reservation of the next stable numeric ID,
    -- mirroring zkteco_enroll_employee.
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
    insert into public.employee_devices (employee_id, device_id, device_user_id, enrollment_status)
    values (p_employee_id, v_device.id, v_user_id, 'pending')
    returning id into v_mapping_id;
  end if;

  insert into public.audit_logs (user_id, action, entity, entity_id, details)
  values (
    auth.uid(), 'zkteco.reserve_device_user', 'employee_devices', p_employee_id::text,
    jsonb_build_object('employee_id', p_employee_id, 'device_id', v_device.id,
      'device_user_id', v_user_id)
  );
  return jsonb_build_object('ok', true, 'device_user_id', v_user_id, 'mapping_id', v_mapping_id);
end;
$$;

revoke all on function public.zkteco_reserve_device_user(uuid) from public, anon;
grant execute on function public.zkteco_reserve_device_user(uuid) to authenticated;
