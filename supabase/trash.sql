-- OPTIONAL UPGRADE — apply in Supabase SQL Editor after superadmin_delete.sql.
-- Replaces owner_delete with an archiving version and adds owner_restore.
-- Semantics: super_admin/owner "delete" = hard delete + full-row archive
-- (including known cascading children for orders/products/ingredients/suppliers).
-- owner_restore(batch_id) re-inserts the archived rows parent-first.

begin;

create table if not exists public.deleted_rows (
  id bigserial primary key,
  batch_id bigint not null,
  table_name text not null,
  row_data jsonb not null,
  deleted_by uuid references public.profiles(id) on delete set null,
  deleted_at timestamptz not null default now(),
  restored_at timestamptz
);
create index if not exists deleted_rows_batch_idx on public.deleted_rows (batch_id, id);
alter table public.deleted_rows enable row level security;
drop policy if exists deleted_rows_read on public.deleted_rows;
create policy deleted_rows_read on public.deleted_rows for select to authenticated
  using (public.has_perm('audit.view')
    or exists (select 1 from public.profiles p where p.id = auth.uid()
      and p.is_active and p.role in ('owner','super_admin')));

create or replace function public._archive_row(
  p_batch bigint, p_table text, p_sql text, p_id uuid
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  execute format(
    'insert into public.deleted_rows (batch_id, table_name, row_data, deleted_by) '
    || 'select $1, $2, to_jsonb(x), $3 from public.%I x where x.id = $4',
    p_sql
  ) using p_batch, p_table, auth.uid(), p_id;
end $$;
revoke all on function public._archive_row(bigint, text, text, uuid) from public, anon, authenticated;

create or replace function public.owner_delete(p_table text, p_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_role text;
  v_batch bigint;
  v_count integer;
begin
  select pr.role into v_role from public.profiles pr
  where pr.id = auth.uid() and pr.is_active;
  if v_role is null or v_role not in ('owner','super_admin') then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;

  if p_table is null or p_table not in (
    'user_permissions','suppliers','ingredients','categories','products',
    'product_variants','product_extras','recipes','recipe_items','stock_movements',
    'purchase_orders','purchase_order_items','customers','restaurant_tables',
    'expense_categories','expenses','cash_shifts','cash_transactions','orders',
    'order_items','order_item_extras','payments','refunds','employees','attendance',
    'backups','attendance_devices','employee_devices','attendance_events','device_commands'
  ) then
    raise exception 'INVALID_TABLE:%', coalesce(p_table, 'null') using errcode = '22023';
  end if;

  select nextval('public.deleted_rows_id_seq') into v_batch;

  -- Archive parent first, then children (restore order = archive order).
  perform public._archive_row(v_batch, p_table, p_table, p_id);

  if p_table = 'orders' then
    perform public._archive_row(v_batch, 'order_items', 'order_items', oi.id)
      from public.order_items oi where oi.order_id = p_id;
    perform public._archive_row(v_batch, 'order_item_extras', 'order_item_extras', ie.id)
      from public.order_item_extras ie
      join public.order_items oi on oi.id = ie.order_item_id where oi.order_id = p_id;
    perform public._archive_row(v_batch, 'payments', 'payments', pa.id)
      from public.payments pa where pa.order_id = p_id;
    perform public._archive_row(v_batch, 'refunds', 'refunds', rf.id)
      from public.refunds rf where rf.order_id = p_id;
  elsif p_table = 'products' then
    perform public._archive_row(v_batch, 'product_variants', 'product_variants', pv.id)
      from public.product_variants pv where pv.product_id = p_id;
    perform public._archive_row(v_batch, 'recipes', 'recipes', rc.id)
      from public.recipes rc where rc.product_id = p_id;
    perform public._archive_row(v_batch, 'recipe_items', 'recipe_items', ri.id)
      from public.recipe_items ri join public.recipes rc on rc.id = ri.recipe_id
      where rc.product_id = p_id;
  elsif p_table = 'ingredients' then
    perform public._archive_row(v_batch, 'recipe_items', 'recipe_items', ri.id)
      from public.recipe_items ri where ri.ingredient_id = p_id;
    perform public._archive_row(v_batch, 'purchase_order_items', 'purchase_order_items', pi.id)
      from public.purchase_order_items pi where pi.ingredient_id = p_id;
  elsif p_table = 'suppliers' then
    perform public._archive_row(v_batch, 'purchase_orders', 'purchase_orders', po.id)
      from public.purchase_orders po where po.supplier_id = p_id;
    perform public._archive_row(v_batch, 'purchase_order_items', 'purchase_order_items', pi.id)
      from public.purchase_order_items pi
      join public.purchase_orders po on po.id = pi.purchase_order_id
      where po.supplier_id = p_id;
  elsif p_table = 'profiles' then
    perform public._archive_row(v_batch, 'cash_transactions', 'cash_transactions', ct.id)
      from public.cash_transactions ct where ct.user_id = p_id;
  end if;

  -- ON DELETE RESTRICT children must go before the parent.
  if p_table = 'ingredients' then
    delete from public.recipe_items where ingredient_id = p_id;
    delete from public.purchase_order_items where ingredient_id = p_id;
  elsif p_table = 'suppliers' then
    delete from public.purchase_order_items
      where purchase_order_id in (select id from public.purchase_orders where supplier_id = p_id);
    delete from public.purchase_orders where supplier_id = p_id;
  elsif p_table = 'profiles' then
    delete from public.cash_transactions where user_id = p_id;
  end if;

  execute format('delete from public.%I where id = $1', p_table) using p_id;
  get diagnostics v_count = row_count;

  insert into public.audit_logs (user_id, action, entity, entity_id, details)
  values (auth.uid(), 'owner_delete', p_table, p_id::text,
    jsonb_build_object('deleted', v_count, 'archive_batch', v_batch));

  return jsonb_build_object('ok', true, 'table', p_table, 'deleted', v_count, 'archive_batch', v_batch);
end $$;

revoke all on function public.owner_delete(text, uuid) from public, anon;
grant execute on function public.owner_delete(text, uuid) to authenticated;

create or replace function public.owner_restore(p_batch bigint)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_role text;
  v_row record;
  v_restored integer := 0;
begin
  select pr.role into v_role from public.profiles pr
  where pr.id = auth.uid() and pr.is_active;
  if v_role is null or v_role not in ('owner','super_admin') then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;

  for v_row in
    select table_name, row_data from public.deleted_rows
    where batch_id = p_batch and restored_at is null
    order by id
  loop
    -- Identifiers come from the hardcoded whitelist above; row_data from our archive.
    execute format(
      'insert into public.%I select (jsonb_populate_record(null::public.%I, $1)).*',
      v_row.table_name, v_row.table_name
    ) using v_row.row_data;
    v_restored := v_restored + 1;
  end loop;

  update public.deleted_rows set restored_at = now() where batch_id = p_batch;

  insert into public.audit_logs (user_id, action, entity, entity_id, details)
  values (auth.uid(), 'owner_restore', 'deleted_rows', p_batch::text,
    jsonb_build_object('rows_restored', v_restored));

  return jsonb_build_object('ok', true, 'rows_restored', v_restored);
end $$;

revoke all on function public.owner_restore(bigint) from public, anon;
grant execute on function public.owner_restore(bigint) to authenticated;

commit;
