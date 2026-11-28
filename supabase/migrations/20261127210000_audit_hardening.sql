-- SUSHI ROLLS — post-audit hardening.
--
-- Fixes found by the deep code audit, in priority order:
--   1. SECURITY DEFINER search_path shadowing (pg_temp searched first).
--   2. Missing FK indexes on hot paths.
--   3. open_shift TOCTOU (two concurrent open shifts per cashier).
--   4. Dead self-attendance RLS branch (filtered by employees RLS).
--   5. pay_order overpayment cap.
--   6. refund_order unbounded refunds / no status guard.
--   7. transfer_table missing row lock.
--   8. _deduct_inventory missing row lock.
--   9. Device-user-id reservation poisoned by an over-wide numeric id.
--  10. zkteco_claim_commands NULL limit bypassing validation.
--  11. zkteco_finish_command wrong errcode + double attempts counting.
--  12. Super-admin attendance bypass: identity stays immutable + audited.

-- ----------------------------------------------------------------------------
-- 1. Pin every public function's search_path to `public, pg_temp`.
--    Listing pg_temp explicitly pushes it AFTER public, so a temp table can no
--    longer shadow the permission tables (profiles / user_permissions) that the
--    definer helpers read. Functions already pinned stay untouched only if
--    fully hardened (`search_path = ''`); everything else — including bare
--    `public`, which still searches pg_temp first — is rewritten.
-- ----------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select n.nspname as schema, p.proname as name,
           pg_get_function_identity_arguments(p.oid) as args
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind = 'f'
      and not exists (
        select 1 from unnest(coalesce(p.proconfig, '{}')) c
        where c in ('search_path=', 'search_path=""')
      )
  loop
    execute format(
      'alter function %I.%I(%s) set search_path = public, pg_temp',
      r.schema, r.name, r.args
    );
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 2. FK indexes (sequential scans on parent-side enforcement and hot filters).
-- ----------------------------------------------------------------------------
create index if not exists orders_shift_id_idx on public.orders (shift_id);
create index if not exists orders_cashier_id_idx on public.orders (cashier_id);
create index if not exists orders_waiter_id_idx on public.orders (waiter_id);
create index if not exists orders_cancelled_by_idx on public.orders (cancelled_by);
create index if not exists order_items_product_id_idx on public.order_items (product_id);
create index if not exists stock_movements_reference_id_idx on public.stock_movements (reference_id);
create index if not exists stock_movements_created_by_idx on public.stock_movements (created_by);
create index if not exists refunds_payment_id_idx on public.refunds (payment_id);
create index if not exists cash_transactions_created_by_idx on public.cash_transactions (created_by);
create index if not exists recipe_items_ingredient_id_idx on public.recipe_items (ingredient_id);
create index if not exists product_extras_ingredient_id_idx on public.product_extras (ingredient_id);
create index if not exists purchase_order_items_ingredient_id_idx on public.purchase_order_items (ingredient_id);

-- ----------------------------------------------------------------------------
-- 3. One open shift per cashier. The unique partial index closes open_shift's
--    check-then-insert TOCTOU: the loser of a concurrent race fails on insert.
--    open_shift is re-emitted to translate that unique violation back into the
--    app-facing SHIFT_ALREADY_OPEN error and to pin its search_path.
-- ----------------------------------------------------------------------------
create unique index if not exists cash_shifts_one_open_per_user
  on public.cash_shifts (user_id) where status = 'open';

create or replace function public.open_shift(p_opening_balance numeric, p_note text default null)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  perform public.assert_perm('cash.manage');
  if exists (select 1 from cash_shifts where user_id = auth.uid() and status = 'open') then
    raise exception 'SHIFT_ALREADY_OPEN';
  end if;
  begin
    insert into cash_shifts (user_id, opening_balance)
    values (auth.uid(), coalesce(p_opening_balance, 0))
    returning id into v_id;
  exception
    when unique_violation then
      -- A concurrent open_shift won the race; this caller already has a shift.
      raise exception 'SHIFT_ALREADY_OPEN';
  end;
  insert into cash_transactions (shift_id, type, amount, note, created_by)
  values (v_id, 'opening', coalesce(p_opening_balance, 0), p_note, auth.uid());
  return (select to_jsonb(s) from cash_shifts s where s.id = v_id);
end;
$$;

-- _deduct_inventory is an internal helper; only definer RPCs (running as the
-- function owner) may call it, so close the accidental PUBLIC execute surface.
revoke all on function public._deduct_inventory(uuid) from public, anon;

-- ----------------------------------------------------------------------------
-- 4. Self-attendance read. The old policy branch sub-queried `employees`
--    subject to employees RLS, so staff without employees.view could never
--    satisfy it even for their own rows. A SECURITY DEFINER helper answers the
--    narrow question "does this employee row belong to me" without exposing
--    anything else.
-- ----------------------------------------------------------------------------
create or replace function public.employee_is_self(p_employee_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.employees e
    where e.id = p_employee_id and e.profile_id = (select auth.uid())
  );
$$;
revoke all on function public.employee_is_self(uuid) from public, anon;
grant execute on function public.employee_is_self(uuid) to authenticated;

drop policy if exists attendance_read on public.attendance;
create policy attendance_read on public.attendance for select to authenticated
using (
  public.has_perm('attendance.view') or public.has_perm('attendance.manage')
  or public.has_perm('employees.view') or public.has_perm('reports.view')
  or public.employee_is_self(employee_id)
);

-- ----------------------------------------------------------------------------
-- 5. pay_order: cap cumulative payments at the order total. Previously any
--    p_amount > 0 was accepted, flipping payment_status to paid and pushing
--    excess cash into the shift.
-- ----------------------------------------------------------------------------
create or replace function public.pay_order(
  p_order uuid,
  p_method text,
  p_amount numeric,
  p_reference text default null
)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_order orders%rowtype;
  v_shift uuid;
  v_paid numeric(12,2);
  v_status text;
begin
  perform public.assert_perm('pos.use');
  if p_amount is null or p_amount <= 0 then raise exception 'INVALID_AMOUNT'; end if;
  select * into v_order from orders where id = p_order for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  if v_order.status = 'cancelled' then raise exception 'ORDER_CANCELLED'; end if;

  select coalesce(sum(amount), 0) into v_paid from payments where order_id = p_order;
  if v_order.total <= 0 then raise exception 'ORDER_NOT_PAYABLE'; end if;
  if v_paid >= v_order.total then raise exception 'ORDER_ALREADY_PAID'; end if;
  if v_paid + p_amount > v_order.total then
    raise exception 'PAYMENT_EXCEEDS_TOTAL' using errcode = '23514';
  end if;

  select id into v_shift from cash_shifts where user_id = auth.uid() and status = 'open' limit 1;

  insert into payments (order_id, method, amount, reference, shift_id, created_by)
  values (p_order, p_method, p_amount, p_reference, v_shift, auth.uid());

  if v_shift is not null and p_method = 'cash' then
    insert into cash_transactions (shift_id, type, amount, reference_order, created_by)
    values (v_shift, 'sale', p_amount, p_order, auth.uid());
  end if;

  select coalesce(sum(amount), 0) into v_paid from payments where order_id = p_order;
  if v_paid >= v_order.total and v_order.total > 0 then
    v_status := 'paid';
  elsif v_paid > 0 then
    v_status := 'partial';
  else
    v_status := 'unpaid';
  end if;

  update orders set payment_status = v_status,
    payment_method = coalesce(payment_method, p_method),
    shift_id = coalesce(shift_id, v_shift)
  where id = p_order;

  return (select to_jsonb(o) from orders o where o.id = p_order);
end;
$$;

-- ----------------------------------------------------------------------------
-- 6. refund_order: only refund what was actually paid, never on cancelled or
--    draft orders. Previously any p_amount > 0 inserted a refund and could
--    drain the shift cash ledger beyond what was ever collected.
-- ----------------------------------------------------------------------------
create or replace function public.refund_order(p_order uuid, p_amount numeric, p_reason text)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_order orders%rowtype;
  v_shift uuid;
  v_refunded numeric(12,2);
  v_paid numeric(12,2);
  v_method text;
begin
  perform public.assert_perm('orders.refund');
  if p_amount is null or p_amount <= 0 then raise exception 'INVALID_AMOUNT'; end if;
  select * into v_order from orders where id = p_order for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  if v_order.status = 'cancelled' then raise exception 'ORDER_CANCELLED'; end if;
  if v_order.status = 'draft' then raise exception 'ORDER_NOT_REFUNDABLE'; end if;

  select coalesce(sum(amount), 0) into v_paid from payments where order_id = p_order;
  select coalesce(sum(amount), 0) into v_refunded from refunds where order_id = p_order;
  if v_paid <= 0 then raise exception 'NOTHING_TO_REFUND'; end if;
  if v_refunded >= v_paid then raise exception 'ORDER_ALREADY_REFUNDED'; end if;
  if v_refunded + p_amount > v_paid then
    raise exception 'REFUND_EXCEEDS_PAID' using errcode = '23514';
  end if;

  insert into refunds (order_id, amount, reason, created_by)
  values (p_order, p_amount, p_reason, auth.uid());

  v_method := v_order.payment_method;
  if v_method = 'cash' then
    select id into v_shift from cash_shifts where user_id = auth.uid() and status = 'open' limit 1;
    if v_shift is not null then
      insert into cash_transactions (shift_id, type, amount, reference_order, created_by)
      values (v_shift, 'refund', -p_amount, p_order, auth.uid());
    end if;
  end if;

  select coalesce(sum(amount), 0) into v_refunded from refunds where order_id = p_order;
  if v_refunded >= v_paid then
    update orders set payment_status = 'refunded' where id = p_order;
  end if;

  return jsonb_build_object('ok', true, 'refunded_total', v_refunded);
end;
$$;

-- ----------------------------------------------------------------------------
-- 7. transfer_table: lock the order row first. Previously the read unlocked and
--    concurrent close/transfer could leave table status inconsistent.
-- ----------------------------------------------------------------------------
create or replace function public.transfer_table(p_order uuid, p_table_id uuid)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_order orders%rowtype;
begin
  perform public.assert_perm('tables.manage');
  select * into v_order from orders where id = p_order for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  if v_order.status in ('completed','cancelled') then raise exception 'ORDER_CLOSED'; end if;

  if v_order.table_id is not null then
    update restaurant_tables set status = 'available', waiter_id = null where id = v_order.table_id;
  end if;
  update orders set table_id = p_table_id, order_type = 'dine_in' where id = p_order;
  update restaurant_tables set status = 'occupied' where id = p_table_id;

  return (select to_jsonb(o) from orders o where o.id = p_order);
end;
$$;

-- ----------------------------------------------------------------------------
-- 8. _deduct_inventory: take FOR UPDATE on the order so the idempotency check
--    (inventory_deducted_at) cannot race a concurrent deduction.
-- ----------------------------------------------------------------------------
create or replace function public._deduct_inventory(p_order uuid)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_done timestamptz;
  v_item record;
  v_rec record;
  v_extra record;
begin
  select inventory_deducted_at into v_done from orders where id = p_order for update;
  if v_done is not null then return; end if;
  for v_item in select * from order_items where order_id = p_order loop
    for v_rec in
      select ri.ingredient_id, ri.quantity * v_item.quantity as qty
      from recipe_items ri
      join recipes r on r.id = ri.recipe_id
      where r.product_id = v_item.product_id
    loop
      update ingredients set quantity = quantity - v_rec.qty, updated_at = now()
      where id = v_rec.ingredient_id;
      insert into stock_movements (ingredient_id, delta, type, reference_type, reference_id, note, created_by)
      values (v_rec.ingredient_id, -v_rec.qty, 'sale', 'order', p_order, 'خصم تلقائي من وصفة', auth.uid());
    end loop;
    for v_extra in
      select oie.quantity, pe.ingredient_id, pe.ingredient_qty
      from order_item_extras oie
      join product_extras pe on pe.id = oie.extra_id
      where oie.order_item_id = v_item.id and pe.ingredient_id is not null
    loop
      update ingredients set quantity = quantity - (v_extra.ingredient_qty * v_extra.quantity), updated_at = now()
      where id = v_extra.ingredient_id;
      insert into stock_movements (ingredient_id, delta, type, reference_type, reference_id, note, created_by)
      values (v_extra.ingredient_id, -(v_extra.ingredient_qty * v_extra.quantity), 'sale', 'order', p_order, 'إضافة على أوردر', auth.uid());
    end loop;
  end loop;
  update orders set inventory_deducted_at = now() where id = p_order;
end;
$$;

-- ----------------------------------------------------------------------------
-- 9. zkteco_reserve_device_user: keep the reservation lock (device row FOR
--    UPDATE serializes both reservers) but stop an over-wide numeric id from
--    poisoning the bigint max() computation forever. Numeric ids wider than
--    nine digits are excluded from the max and, when present, fail LOUDLY so
--    the operator cleans them up instead of the reservation silently minting
--    colliding numbers.
-- ----------------------------------------------------------------------------
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
    -- Only reserving a NEW id needs the numeric max(), so the poison check
    -- belongs here: employees that already hold a valid mapping keep reading
    -- it even while poisoned rows await manual cleanup.
    if exists (
      select 1 from public.employee_devices d
      where d.device_id = v_device.id and d.device_user_id ~ '^[0-9]{10,64}$'
    ) then
      raise exception 'DEVICE_USER_ID_SPACE_POISONED' using errcode = '55000';
    end if;
    -- The device row lock serializes reservation of the next stable numeric ID,
    -- mirroring zkteco_enroll_employee.
    select coalesce(max(reserved_id), 1000) + 1 into v_next_user_id
    from (
      select device_user_id::bigint as reserved_id from public.employee_devices
      where device_id = v_device.id and device_user_id ~ '^[0-9]{1,9}$'
      union all
      select (payload ->> 'device_user_id')::bigint as reserved_id from public.device_commands
      where device_id = v_device.id and payload ->> 'device_user_id' ~ '^[0-9]{1,9}$'
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

-- ----------------------------------------------------------------------------
-- 10. zkteco_enroll_employee: same reservation hardening, plus reject explicit
--     numeric ids too wide for the reservation arithmetic. Alphanumeric ids of
--     any length stay allowed (the terminal accepts them and they cannot
--     poison the numeric max).
-- ----------------------------------------------------------------------------
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
    if exists (
      select 1 from public.employee_devices d
      where d.device_id = v_device.id and d.device_user_id ~ '^[0-9]{10,64}$'
    ) then
      raise exception 'DEVICE_USER_ID_SPACE_POISONED' using errcode = '55000';
    end if;
    if coalesce(btrim(p_device_user_id), '') = '' then
      -- The device row lock serializes reservation of the next stable numeric ID.
      select coalesce(max(reserved_id), 1000) + 1 into v_next_user_id
      from (
        select device_user_id::bigint as reserved_id from public.employee_devices
        where device_id = v_device.id and device_user_id ~ '^[0-9]{1,9}$'
        union all
        select (payload ->> 'device_user_id')::bigint as reserved_id from public.device_commands
        where device_id = v_device.id and payload ->> 'device_user_id' ~ '^[0-9]{1,9}$'
      ) reserved;
      if v_next_user_id > 2147483647 then
        raise exception 'DEVICE_USER_ID_SPACE_EXHAUSTED' using errcode = '23514';
      end if;
      v_user_id := v_next_user_id::text;
    else
      v_user_id := btrim(p_device_user_id);
      if v_user_id ~ '^[0-9]{10,64}$' then
        raise exception 'DEVICE_USER_ID_TOO_LARGE' using errcode = '23514';
      end if;
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

-- ----------------------------------------------------------------------------
-- 11. zkteco_claim_commands: a NULL p_limit bypassed the range check and
--     claimed the whole queue (LIMIT NULL = no limit).
-- ----------------------------------------------------------------------------
create or replace function public.zkteco_claim_commands(p_device_id uuid, p_limit integer default 50)
returns setof public.device_commands
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_limit is null or p_limit < 1 or p_limit > 50 then
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

-- ----------------------------------------------------------------------------
-- 12. zkteco_finish_command: COMMAND_STATE_CONFLICT used P0004
--     (insufficient_privilege); the right class is 55000. The claim RPC already
--     increments attempts, so finish no longer double-counts.
-- ----------------------------------------------------------------------------
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
    raise exception 'COMMAND_STATE_CONFLICT' using errcode = '55000';
  end if;

  update public.device_commands
  set status = p_status,
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

-- ----------------------------------------------------------------------------
-- 13. Super-admin attendance bypass: identity stays immutable even under the
--     bypass, and every bypass use is audited through a SECURITY DEFINER
--     helper so the audit row lands regardless of the caller's context.
-- ----------------------------------------------------------------------------
create or replace function public._zkteco_log_bypass(p_attendance uuid, p_op text)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.audit_logs (user_id, action, entity, entity_id, details)
  values (auth.uid(), 'zkteco.attendance_super_admin_bypass', 'attendance',
    p_attendance::text, jsonb_build_object('op', p_op));
$$;
revoke all on function public._zkteco_log_bypass(uuid, text) from public, anon;

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
    if tg_op = 'UPDATE' and (new.id <> old.id or new.employee_id <> old.employee_id
      or new.source <> old.source or new.device_id is distinct from old.device_id) then
      raise exception 'ATTENDANCE_IDENTITY_IMMUTABLE' using errcode = '23514';
    end if;
    new.updated_at := now();
    perform public._zkteco_log_bypass(new.id, tg_op);
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
