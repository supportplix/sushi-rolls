-- SUSHI ROLLS — database P0/P1 fixes (2026-11-28).
-- Apply AFTER 20261127210000_audit_hardening.sql. Every function below is a
-- full replacement of the hardened definition so no guard from that migration
-- is lost. Files that must be visible in this order:
--   supabase/apply-migrations.sql
--
--   DB-03: guard_profile_update exempts service_role (auth.uid() is NULL there)
--          so the admin-users Edge Function can change role / is_active.
--   SEC-01: role changes are additionally capped by caller rank in the trigger
--          (defence in depth: users.manage can also write profiles directly via
--          PostgREST, bypassing the Edge Function). owner/super_admin remain the
--          only assignable privileged roles, and only owner/super_admin may
--          assign them; caller rank is taken from the caller's own profile.
--   DB-06: zero-total (100% discount) orders can be paid with p_amount = 0.
--          pay_order still rejects every other invalid/zero/over payment and
--          keeps all of the hardening guards. submit_order marks a zero-total
--          order paid without inserting a 0-amount payment row (the
--          payments.amount > 0 CHECK forbids one). _recalc_order preserves both
--          paid zero-total orders and refunded orders.
--   DB-04: manual attendance uses the same business timezone and the same
--          advisory lock as the device path, and check_out no longer closes an
--          open row from a previous work date with today's timestamp.

-- ----------------------------------------------------------------------------
-- 1. Role hierarchy helper + profile guard (DB-03 / SEC-01, DB side)
-- ----------------------------------------------------------------------------

create or replace function public._role_rank(p_role text)
returns integer
language sql immutable
set search_path = ''
as $$
  select case p_role
    when 'super_admin' then 100
    when 'owner' then 100
    when 'general_manager' then 70
    when 'branch_manager' then 60
    when 'inventory_manager' then 40
    when 'accountant' then 40
    when 'cashier' then 30
    when 'waiter' then 20
    when 'kitchen' then 20
    else -1
  end;
$$;

revoke all on function public._role_rank(text) from public, anon, authenticated;

create or replace function public.guard_profile_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller_role text;
begin
  -- The admin-users Edge Function authenticates the caller from the signed JWT
  -- and then writes with service_role (auth.uid() is NULL, auth.role() is
  -- 'service_role'). Its own role-hierarchy check is authoritative for that
  -- path; the trigger must not apply the user-facing has_perm() check to it.
  if auth.role() = 'service_role' and auth.uid() is null then
    return new;
  end if;

  if not public.has_perm('users.manage') then
    if new.role <> old.role
       or new.is_active <> old.is_active
       or new.username <> old.username
       or new.id <> old.id then
      raise exception 'PERMISSION_DENIED:users.manage' using errcode = '42501';
    end if;
    return new;
  end if;

  -- users.manage (including an explicit override) does not by itself confer
  -- the right to mint a higher-privileged account. This closes the direct
  -- PostgREST PATCH /profiles escalation that bypasses admin-users entirely.
  if new.role is distinct from old.role then
    select role into v_caller_role from public.profiles where id = auth.uid();
    if public._role_rank(new.role) < 0
       or public._role_rank(new.role) > public._role_rank(v_caller_role) then
      raise exception 'ROLE_NOT_ASSIGNABLE:%', new.role using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

-- The trigger is unchanged: trg_profile_guard BEFORE UPDATE ON profiles.

-- ----------------------------------------------------------------------------
-- 2. Zero-total orders (DB-06)
-- ----------------------------------------------------------------------------

-- pay_order: hardened definition plus an explicit free/zero-total branch.
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
  if p_amount is null or p_amount < 0 then raise exception 'INVALID_AMOUNT'; end if;
  select * into v_order from orders where id = p_order for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  if v_order.status = 'cancelled' then raise exception 'ORDER_CANCELLED'; end if;

  select coalesce(sum(amount), 0) into v_paid from payments where order_id = p_order;
  select id into v_shift from cash_shifts where user_id = auth.uid() and status = 'open' limit 1;

  if v_order.total < 0 then raise exception 'ORDER_NOT_PAYABLE'; end if;

  if v_order.total = 0 then
    -- 100% discount / free order. payments.amount > 0 forbids a 0-row, so
    -- settle it by setting the status only. p_amount = 0 means "collect
    -- nothing"; any non-zero amount is still an overpayment and negative
    -- amounts were rejected above.
    if p_amount <> 0 then
      raise exception 'PAYMENT_EXCEEDS_TOTAL' using errcode = '23514';
    end if;
    if v_paid > 0 or v_order.payment_status = 'refunded' then
      -- Money already changed hands (or was refunded): an operator must resolve
      -- it through refund_order / a correction, never through a free settle.
      raise exception 'ORDER_NOT_PAYABLE';
    end if;
    update orders set payment_status = 'paid',
      payment_method = coalesce(payment_method, p_method),
      shift_id = coalesce(shift_id, v_shift)
    where id = p_order;
    return (select to_jsonb(o) from orders o where o.id = p_order);
  end if;

  if p_amount = 0 then raise exception 'INVALID_AMOUNT'; end if;
  if v_paid >= v_order.total then raise exception 'ORDER_ALREADY_PAID'; end if;
  if v_paid + p_amount > v_order.total then
    raise exception 'PAYMENT_EXCEEDS_TOTAL' using errcode = '23514';
  end if;

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

-- submit_order: baseline body, unchanged except for the zero-total settlement.
-- (search_path pinned to the hardened value; no other logic was touched.)
create or replace function public.submit_order(p_payload jsonb, p_options jsonb default '{}'::jsonb)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_item jsonb;
  v_extra jsonb;
  v_product products%rowtype;
  v_variant record;
  v_ex record;
  v_price numeric(12,2);
  v_cost numeric(12,2);
  v_extras_total numeric(12,2);
  v_line numeric(12,2);
  v_subtotal numeric(12,2) := 0;
  v_discount_type text := nullif(p_payload->>'discount_type', '');
  v_discount_value numeric(12,2) := coalesce(nullif(p_payload->>'discount_value', '')::numeric, 0);
  v_discount numeric(12,2) := 0;
  v_tax_rate numeric(5,2) := 0;
  v_tax numeric(12,2) := 0;
  v_total numeric(12,2);
  v_tax_cfg jsonb;
  v_order_id uuid;
  v_order_number bigint;
  v_item_id uuid;
  v_qty int;
  v_exqty int;
  v_customer_id uuid := nullif(p_payload->>'customer_id', '')::uuid;
  v_table_id uuid := nullif(p_payload->>'table_id', '')::uuid;
  v_status text := 'draft';
  v_payment_method text := nullif(p_options->>'payment_method', '');
  v_paid numeric(12,2) := coalesce(nullif(p_options->>'paid_amount', '')::numeric, 0);
  v_send boolean := coalesce((p_options->>'send_to_kitchen')::boolean, false);
  v_payment_status text := 'unpaid';
  v_shift uuid;
  v_customer_name text := nullif(p_payload->>'customer_name', '');
  v_customer_phone text := nullif(p_payload->>'customer_phone', '');
  v_result jsonb;
begin
  perform public.assert_perm('pos.use');
  if jsonb_array_length(coalesce(p_payload->'items', '[]'::jsonb)) = 0 then
    raise exception 'EMPTY_ORDER';
  end if;
  if coalesce(nullif(p_payload->>'order_type', ''), 'dine_in') not in ('dine_in','takeaway','delivery') then
    raise exception 'INVALID_ORDER_TYPE';
  end if;

  select value into v_tax_cfg from settings where key = 'tax';
  if coalesce((v_tax_cfg->>'enabled')::boolean, false) then
    v_tax_rate := coalesce((v_tax_cfg->>'rate')::numeric, 0);
  end if;

  if v_customer_id is null and v_customer_phone is not null then
    select id into v_customer_id from customers where phone = v_customer_phone limit 1;
    if v_customer_id is null and v_customer_name is not null then
      insert into customers (name, phone) values (v_customer_name, v_customer_phone)
      returning id into v_customer_id;
    end if;
  end if;

  insert into orders (
    order_type, table_id, customer_id, customer_name, customer_phone, customer_address,
    cashier_id, waiter_id, discount_type, discount_value, tax_rate, notes
  ) values (
    coalesce(nullif(p_payload->>'order_type', ''), 'dine_in'),
    v_table_id, v_customer_id, v_customer_name, v_customer_phone,
    nullif(p_payload->>'customer_address', ''),
    v_uid, nullif(p_payload->>'waiter_id', '')::uuid,
    v_discount_type, v_discount_value, v_tax_rate, nullif(p_payload->>'notes', '')
  )
  returning id, order_number into v_order_id, v_order_number;

  for v_item in select * from jsonb_array_elements(p_payload->'items')
  loop
    v_qty := greatest(coalesce(nullif(v_item->>'quantity', '')::int, 1), 1);
    select * into v_product from products
    where id = (v_item->>'product_id')::uuid and not is_archived;
    if not found then raise exception 'PRODUCT_NOT_FOUND'; end if;

    v_price := v_product.price;
    v_cost := v_product.cost;
    select * into v_variant from product_variants
    where id = nullif(v_item->>'variant_id', '')::uuid;
    if found then
      v_price := v_price + coalesce(v_variant.price_delta, 0);
    end if;

    insert into order_items (order_id, product_id, name_snapshot, variant_name, unit_price, cost_snapshot, quantity, notes, line_total)
    values (
      v_order_id, v_product.id, v_product.name_ar,
      case when v_variant.id is not null then v_variant.name_ar else null end,
      v_price, v_cost, v_qty, nullif(v_item->>'notes', ''), 0
    )
    returning id into v_item_id;

    v_extras_total := 0;
    if v_item ? 'extras' then
      for v_extra in select * from jsonb_array_elements(v_item->'extras')
      loop
        v_exqty := greatest(coalesce(nullif(v_extra->>'quantity', '')::int, 1), 1);
        select * into v_ex from product_extras where id = (v_extra->>'extra_id')::uuid;
        if found then
          insert into order_item_extras (order_item_id, extra_id, name_snapshot, price, quantity)
          values (v_item_id, v_ex.id, v_ex.name_ar, v_ex.price, v_exqty);
          v_extras_total := v_extras_total + (v_ex.price * v_exqty);
        end if;
      end loop;
    end if;

    v_line := (v_price + v_extras_total) * v_qty;
    update order_items set line_total = v_line where id = v_item_id;
    v_subtotal := v_subtotal + v_line;
  end loop;

  if v_discount_type = 'percent' then
    v_discount := least(greatest(v_discount_value, 0), 100) * v_subtotal / 100;
  elsif v_discount_type = 'fixed' then
    v_discount := least(greatest(v_discount_value, 0), v_subtotal);
  else
    v_discount := 0;
  end if;

  if coalesce((v_tax_cfg->>'enabled')::boolean, false) and v_tax_rate > 0 then
    if coalesce((v_tax_cfg->>'inclusive')::boolean, false) then
      v_tax := round((v_subtotal - v_discount) * v_tax_rate / (100 + v_tax_rate), 2);
      v_total := v_subtotal - v_discount;
    else
      v_tax := round((v_subtotal - v_discount) * v_tax_rate / 100, 2);
      v_total := v_subtotal - v_discount + v_tax;
    end if;
  else
    v_total := v_subtotal - v_discount;
  end if;

  select id into v_shift from cash_shifts where user_id = v_uid and status = 'open' limit 1;

  if v_paid > 0 and v_payment_method is not null then
    if v_paid > v_total then v_paid := v_total; end if;
    insert into payments (order_id, method, amount, shift_id, created_by)
    values (v_order_id, v_payment_method, v_paid, v_shift, v_uid);
    if v_shift is not null and v_payment_method = 'cash' then
      insert into cash_transactions (shift_id, type, amount, reference_order, created_by)
      values (v_shift, 'sale', v_paid, v_order_id, v_uid);
    end if;
  end if;

  if v_paid >= v_total and v_total > 0 then
    v_payment_status := 'paid';
  elsif v_paid > 0 then
    v_payment_status := 'partial';
  elsif v_total = 0 then
    -- Nothing to collect. No payment row is inserted (payments.amount > 0),
    -- but the order must not be reported as unpaid forever.
    v_payment_status := 'paid';
  end if;

  if v_send then
    v_status := 'sent_to_kitchen';
  end if;

  update orders set
    subtotal = v_subtotal, discount = v_discount, tax = v_tax, total = v_total,
    payment_status = v_payment_status, payment_method = v_payment_method,
    status = v_status, shift_id = v_shift
  where id = v_order_id;

  if v_send then
    perform public._deduct_inventory(v_order_id);
    update orders set status = 'sent_to_kitchen' where id = v_order_id;
  end if;

  if v_table_id is not null and v_status <> 'draft' then
    update restaurant_tables set status = 'occupied' where id = v_table_id;
  end if;

  if v_customer_id is not null then
    update customers set total_orders = total_orders + 1,
      total_spending = total_spending + v_total, last_order_at = now()
    where id = v_customer_id;
  end if;

  select to_jsonb(o) into v_result from orders o where o.id = v_order_id;
  return v_result;
end;
$$;

-- _recalc_order: preserve a settled zero-total order (split_order calls this
-- on both halves) and a fully refunded order. Baseline body otherwise intact.
create or replace function public._recalc_order(p_order uuid)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_order orders%rowtype;
  v_subtotal numeric(12,2);
  v_discount numeric(12,2);
  v_tax_cfg jsonb;
  v_tax numeric(12,2) := 0;
  v_total numeric(12,2);
  v_paid numeric(12,2);
  v_refunded numeric(12,2);
  v_status text;
begin
  select * into v_order from orders where id = p_order;
  if not found then return; end if;
  select coalesce(sum(line_total), 0) into v_subtotal from order_items where order_id = p_order;
  if v_order.discount_type = 'percent' then
    v_discount := least(greatest(v_order.discount_value, 0), 100) * v_subtotal / 100;
  elsif v_order.discount_type = 'fixed' then
    v_discount := least(greatest(v_order.discount_value, 0), v_subtotal);
  else
    v_discount := 0;
  end if;
  select value into v_tax_cfg from settings where key = 'tax';
  if coalesce((v_tax_cfg->>'enabled')::boolean, false) and v_order.tax_rate > 0 then
    if coalesce((v_tax_cfg->>'inclusive')::boolean, false) then
      v_tax := round((v_subtotal - v_discount) * v_order.tax_rate / (100 + v_order.tax_rate), 2);
      v_total := v_subtotal - v_discount;
    else
      v_tax := round((v_subtotal - v_discount) * v_order.tax_rate / 100, 2);
      v_total := v_subtotal - v_discount + v_tax;
    end if;
  else
    v_total := v_subtotal - v_discount;
  end if;
  select coalesce(sum(amount), 0) into v_paid from payments where order_id = p_order;
  select coalesce(sum(amount), 0) into v_refunded from refunds where order_id = p_order;
  if v_paid > 0 and v_refunded >= v_paid then
    v_status := 'refunded';
  elsif v_paid >= v_total and v_total > 0 then
    v_status := 'paid';
  elsif v_paid > 0 then
    v_status := 'partial';
  elsif v_total = 0 then
    -- Keep 'paid' for a free/100%-discounted order that was explicitly
    -- settled; an untouched zero-total draft stays 'unpaid'.
    v_status := case when v_order.payment_status = 'refunded' then 'refunded'
                     else v_order.payment_status end;
  else
    v_status := 'unpaid';
  end if;
  update orders set subtotal = v_subtotal, discount = v_discount, tax = v_tax,
    total = v_total, payment_status = v_status
  where id = p_order;
end;
$$;

-- Internal helper: submit_order / split_order call it as the function owner.
-- It was executable by PUBLIC (including anon) because schema.sql never
-- revoked it, giving an unauthenticated caller a write surface on orders.
revoke all on function public._recalc_order(uuid) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 3. Manual attendance parity with the device path (DB-04)
-- ----------------------------------------------------------------------------

-- SECURITY DEFINER is required: attendance_devices is RLS-protected and an
-- ordinary employee (no device.manage) cannot read its timezone otherwise.
create or replace function public._attendance_work_date()
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select (now() at time zone coalesce(
    (select timezone from public.attendance_devices order by created_at, id limit 1),
    'Africa/Cairo'
  ))::date;
$$;

revoke all on function public._attendance_work_date() from public, anon, authenticated;

create or replace function public.attendance_check_in()
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_emp uuid;
  v_work_date date;
  v_open uuid;
  v_id uuid;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;
  select id into v_emp from public.employees
  where profile_id = auth.uid() and is_active limit 1;
  if v_emp is null then raise exception 'NO_EMPLOYEE_RECORD' using errcode = 'P0002'; end if;

  v_work_date := public._attendance_work_date();
  -- Same lock key/order as apply_attendance_event and
  -- zkteco_correct_attendance: serialises manual and device punches per
  -- employee/workday (the partial unique index alone only covers check-in).
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    v_emp::text || ':' || v_work_date::text, 0
  ));
  select id into v_open from public.attendance
  where employee_id = v_emp and check_out is null and work_date = v_work_date
  limit 1 for update;
  if v_open is not null then raise exception 'ALREADY_CHECKED_IN' using errcode = '23514'; end if;

  insert into public.attendance (employee_id, check_in, work_date, source)
  values (v_emp, now(), v_work_date, 'manual') returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;

create or replace function public.attendance_check_out()
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_emp uuid;
  v_work_date date;
  v_open uuid;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;
  select id into v_emp from public.employees
  where profile_id = auth.uid() and is_active limit 1;
  if v_emp is null then raise exception 'NO_EMPLOYEE_RECORD' using errcode = 'P0002'; end if;

  v_work_date := public._attendance_work_date();
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    v_emp::text || ':' || v_work_date::text, 0
  ));
  -- Do not close an open row from a previous work date and stamp it with
  -- today's check_out; stale rows need zkteco_correct_attendance instead.
  select id into v_open from public.attendance
  where employee_id = v_emp and check_out is null and work_date = v_work_date
  order by check_in desc, id desc limit 1 for update;
  if v_open is null then raise exception 'NOT_CHECKED_IN' using errcode = 'P0002'; end if;

  update public.attendance set check_out = now() where id = v_open;
  return jsonb_build_object('ok', true);
end;
$$;
