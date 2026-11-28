-- OPTIONAL / RISKY — NOT APPLIED AUTOMATICALLY.
-- Gives owner/super_admin a controlled way to hard-delete a row through RLS.
-- Run in Supabase SQL Editor as the project owner ONLY if you accept that
-- financial/audit history can be permanently removed.
--
-- Why this is needed: RLS gives authenticated users SELECT-only on the ledger
-- tables (orders, payments, refunds, cash_shifts, cash_transactions,
-- attendance, audit_logs, login_history). A super_admin is still an
-- "authenticated" user, so RLS blocks DELETE regardless of the role.
-- This SECURITY DEFINER function is the narrow exception: it checks the role
-- from the signed JWT, then deletes as the function owner.

create or replace function public.owner_delete(p_table text, p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_count integer;
begin
  select pr.role into v_role
  from public.profiles pr
  where pr.id = auth.uid() and pr.is_active;

  if v_role is null or v_role not in ('owner', 'super_admin') then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;

  -- Whitelist prevents arbitrary SQL /system-table access through p_table.
  -- Excluded: settings/audit_logs/login_history/user_permissions (non-uuid PK),
  -- stock_movements and cash_transactions (bigserial), and attendance_devices
  -- (RESTRICT device children belong to the device flow). See reset_data.sql.
  if p_table is null or p_table not in (
    'suppliers','ingredients','categories','products',
    'product_variants','product_extras','recipes','recipe_items',
    'purchase_orders','purchase_order_items','customers','restaurant_tables',
    'expense_categories','expenses','cash_shifts','orders',
    'order_items','order_item_extras','payments','refunds','employees','attendance',
    'backups','employee_devices','attendance_events','device_commands'
  ) then
    raise exception 'INVALID_TABLE:%', coalesce(p_table, 'null') using errcode = '22023';
  end if;

  -- Known ON DELETE RESTRICT edges: clean children first so "delete anything"
  -- does not fail with a foreign-key error. These are hard deletes too.
  if p_table = 'ingredients' then
    delete from public.recipe_items where ingredient_id = p_id;
    delete from public.purchase_order_items where ingredient_id = p_id;
  elsif p_table = 'suppliers' then
    delete from public.purchase_order_items
      where purchase_order_id in (select id from public.purchase_orders where supplier_id = p_id);
    delete from public.purchase_orders where supplier_id = p_id;
  end if;

  execute format('delete from public.%I where id = $1', p_table) using p_id;
  get diagnostics v_count = row_count;

  insert into public.audit_logs (user_id, action, entity, entity_id, details)
  values (
    auth.uid(), 'owner_delete', p_table, p_id::text,
    jsonb_build_object('deleted', v_count)
  );

  return jsonb_build_object('ok', true, 'table', p_table, 'deleted', v_count);
end;
$$;

revoke all on function public.owner_delete(text, uuid) from public, anon;
grant execute on function public.owner_delete(text, uuid) to authenticated;

comment on function public.owner_delete(text, uuid) is
  'owner/super_admin only: hard-delete one row from a whitelisted business table, bypassing SELECT-only RLS. Audited.';
