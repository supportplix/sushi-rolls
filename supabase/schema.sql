-- ============================================================================
-- SUSHI ROLLS — Restaurant Management & POS
-- Supabase schema (Postgres 15+). BASELINE ONLY — run this once on a NEW
-- database, then apply every file in supabase/migrations/ in filename order.
-- The authoritative runner is supabase/apply-migrations.sql (psql) — it makes
-- the required order explicit. From the Supabase SQL Editor, run schema.sql
-- first, then paste the migration files one by one in ascending filename order.
--
-- DO NOT RE-RUN THIS FILE ON AN INITIALISED DATABASE. Several functions below
-- are the pre-hardening baseline (permission helpers, pay_order, refund_order,
-- transfers, guard_profile_update, manual attendance, ...). Re-running it
-- SILENTLY REVERTS the fixes in the migrations, including the financial guards
-- in 20261127210000_audit_hardening.sql. The tripwire below refuses a re-run
-- once any migration has been applied; rebuild from scratch instead.
--
-- This is a baseline, not an upgrade path: schema changes belong in a new
-- migration under supabase/migrations/, not in this file.
-- ============================================================================

do $$
begin
  if to_regclass('public.attendance_devices') is not null
     or to_regprocedure('public.employee_is_self(uuid)') is not null
     or to_regprocedure('public.admin_restore_backup(jsonb)') is not null then
    raise exception 'SCHEMA_ALREADY_MIGRATED: do not re-run schema.sql; apply the migrations in supabase/migrations/ in filename order (see supabase/apply-migrations.sql)'
      using errcode = '55000';
  end if;
end $$;

create extension if not exists pgcrypto;

create sequence if not exists order_number_seq start 1001;

-- ----------------------------------------------------------------------------
-- Tables
-- ----------------------------------------------------------------------------

create table if not exists settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique check (username = lower(username) and username ~ '^[a-z0-9._-]{3,32}$'),
  full_name text not null,
  role text not null default 'cashier' check (role in (
    'super_admin','owner','general_manager','branch_manager','cashier',
    'waiter','kitchen','inventory_manager','accountant'
  )),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists user_permissions (
  user_id uuid not null references profiles(id) on delete cascade,
  permission text not null,
  allowed boolean not null default true,
  primary key (user_id, permission)
);

create table if not exists login_history (
  id bigserial primary key,
  user_id uuid references profiles(id) on delete set null,
  username text,
  success boolean not null default true,
  user_agent text,
  created_at timestamptz not null default now()
);

create table if not exists suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text,
  address text,
  contact_person text,
  notes text,
  balance numeric(12,2) not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists ingredients (
  id uuid primary key default gen_random_uuid(),
  name_ar text not null,
  name_en text,
  sku text,
  category text,
  unit text not null default 'كجم',
  quantity numeric(14,3) not null default 0,
  min_stock numeric(14,3) not null default 0,
  purchase_cost numeric(12,4) not null default 0,
  supplier_id uuid references suppliers(id) on delete set null,
  expiry_date date,
  storage_location text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists categories (
  id uuid primary key default gen_random_uuid(),
  name_ar text not null,
  name_en text,
  sort_order int not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists products (
  id uuid primary key default gen_random_uuid(),
  category_id uuid references categories(id) on delete set null,
  name_ar text not null,
  name_en text,
  description_ar text,
  description_en text,
  price numeric(12,2) not null default 0 check (price >= 0),
  cost numeric(12,2) not null default 0 check (cost >= 0),
  sku text,
  image_url text,
  is_available boolean not null default true,
  is_popular boolean not null default false,
  is_archived boolean not null default false,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists product_variants (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id) on delete cascade,
  name_ar text not null,
  name_en text,
  price_delta numeric(12,2) not null default 0,
  is_default boolean not null default false,
  sort_order int not null default 0
);

create table if not exists product_extras (
  id uuid primary key default gen_random_uuid(),
  name_ar text not null,
  name_en text,
  price numeric(12,2) not null default 0 check (price >= 0),
  ingredient_id uuid references ingredients(id) on delete set null,
  ingredient_qty numeric(14,3) not null default 0,
  is_active boolean not null default true,
  sort_order int not null default 0
);

create table if not exists recipes (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null unique references products(id) on delete cascade,
  notes text
);

create table if not exists recipe_items (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null references recipes(id) on delete cascade,
  ingredient_id uuid not null references ingredients(id) on delete restrict,
  quantity numeric(14,3) not null check (quantity > 0)
);

create table if not exists stock_movements (
  id bigserial primary key,
  ingredient_id uuid not null references ingredients(id) on delete cascade,
  delta numeric(14,3) not null,
  type text not null check (type in (
    'in','out','adjustment','waste','damage','expired','transfer','purchase','sale','reversal'
  )),
  reference_type text,
  reference_id uuid,
  unit_cost numeric(12,4),
  note text,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists purchase_orders (
  id uuid primary key default gen_random_uuid(),
  number bigserial,
  supplier_id uuid not null references suppliers(id) on delete restrict,
  status text not null default 'draft' check (status in ('draft','ordered','received','cancelled')),
  total numeric(12,2) not null default 0,
  paid numeric(12,2) not null default 0,
  notes text,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  received_at timestamptz
);

create table if not exists purchase_order_items (
  id uuid primary key default gen_random_uuid(),
  purchase_order_id uuid not null references purchase_orders(id) on delete cascade,
  ingredient_id uuid not null references ingredients(id) on delete restrict,
  quantity numeric(14,3) not null check (quantity > 0),
  unit_cost numeric(12,4) not null default 0,
  total numeric(12,2) not null default 0
);

create table if not exists customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text unique,
  address text,
  notes text,
  total_orders int not null default 0,
  total_spending numeric(12,2) not null default 0,
  last_order_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists restaurant_tables (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,
  capacity int not null default 4,
  zone text not null default 'الصالة',
  status text not null default 'available' check (status in ('available','occupied','reserved','cleaning')),
  waiter_id uuid references profiles(id) on delete set null,
  pos_x int not null default 0,
  pos_y int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists expense_categories (
  id uuid primary key default gen_random_uuid(),
  name_ar text not null,
  name_en text,
  is_active boolean not null default true
);

create table if not exists expenses (
  id uuid primary key default gen_random_uuid(),
  category_id uuid references expense_categories(id) on delete set null,
  description text not null,
  amount numeric(12,2) not null check (amount > 0),
  expense_date date not null default current_date,
  payment_method text,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists cash_shifts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete restrict,
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  opening_balance numeric(12,2) not null default 0,
  expected_balance numeric(12,2),
  closing_balance numeric(12,2),
  difference numeric(12,2),
  total_sales numeric(12,2) not null default 0,
  notes text,
  status text not null default 'open' check (status in ('open','closed'))
);

create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  order_number bigint not null unique default nextval('order_number_seq'),
  status text not null default 'draft' check (status in (
    'draft','confirmed','sent_to_kitchen','preparing','ready','completed','cancelled'
  )),
  order_type text not null default 'dine_in' check (order_type in ('dine_in','takeaway','delivery')),
  table_id uuid references restaurant_tables(id) on delete set null,
  customer_id uuid references customers(id) on delete set null,
  customer_name text,
  customer_phone text,
  customer_address text,
  cashier_id uuid references profiles(id) on delete set null,
  waiter_id uuid references profiles(id) on delete set null,
  subtotal numeric(12,2) not null default 0,
  discount_type text check (discount_type in ('percent','fixed')),
  discount_value numeric(12,2) not null default 0,
  discount numeric(12,2) not null default 0,
  tax_rate numeric(5,2) not null default 0,
  tax numeric(12,2) not null default 0,
  total numeric(12,2) not null default 0,
  payment_status text not null default 'unpaid' check (payment_status in ('unpaid','partial','paid','refunded')),
  payment_method text,
  notes text,
  cancel_reason text,
  cancelled_by uuid references profiles(id) on delete set null,
  cancelled_at timestamptz,
  inventory_deducted_at timestamptz,
  shift_id uuid references cash_shifts(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  product_id uuid references products(id) on delete set null,
  name_snapshot text not null,
  variant_name text,
  unit_price numeric(12,2) not null default 0,
  cost_snapshot numeric(12,2) not null default 0,
  quantity int not null check (quantity > 0),
  notes text,
  line_total numeric(12,2) not null default 0
);

create table if not exists order_item_extras (
  id uuid primary key default gen_random_uuid(),
  order_item_id uuid not null references order_items(id) on delete cascade,
  extra_id uuid references product_extras(id) on delete set null,
  name_snapshot text not null,
  price numeric(12,2) not null default 0,
  quantity int not null default 1 check (quantity > 0)
);

create table if not exists payments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  method text not null,
  amount numeric(12,2) not null check (amount > 0),
  reference text,
  shift_id uuid references cash_shifts(id) on delete set null,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists refunds (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  payment_id uuid references payments(id) on delete set null,
  amount numeric(12,2) not null check (amount > 0),
  reason text,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists cash_transactions (
  id bigserial primary key,
  shift_id uuid not null references cash_shifts(id) on delete cascade,
  type text not null check (type in ('opening','sale','refund','withdrawal','addition','closing')),
  amount numeric(12,2) not null,
  reference_order uuid references orders(id) on delete set null,
  note text,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists employees (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid references profiles(id) on delete set null,
  full_name text not null,
  job_title text,
  phone text,
  salary numeric(12,2) not null default 0,
  hire_date date,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists attendance (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employees(id) on delete cascade,
  check_in timestamptz not null default now(),
  check_out timestamptz,
  work_date date not null default current_date,
  note text
);

create table if not exists audit_logs (
  id bigserial primary key,
  user_id uuid references profiles(id) on delete set null,
  action text not null,
  entity text not null,
  entity_id text,
  details jsonb,
  created_at timestamptz not null default now()
);

create table if not exists backups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  size_bytes bigint,
  note text,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- Indexes
-- ----------------------------------------------------------------------------

create index if not exists orders_status_idx on orders (status);
create index if not exists orders_created_at_idx on orders (created_at);
create index if not exists orders_table_idx on orders (table_id);
create index if not exists orders_customer_idx on orders (customer_id);
create index if not exists order_items_order_idx on order_items (order_id);
create index if not exists order_item_extras_item_idx on order_item_extras (order_item_id);
create index if not exists payments_order_idx on payments (order_id);
create index if not exists payments_shift_idx on payments (shift_id);
create index if not exists refunds_order_idx on refunds (order_id);
create index if not exists products_category_idx on products (category_id);
create index if not exists products_archived_idx on products (is_archived);
create index if not exists ingredients_supplier_idx on ingredients (supplier_id);
create index if not exists stock_movements_ingredient_idx on stock_movements (ingredient_id, created_at desc);
create index if not exists purchase_orders_supplier_idx on purchase_orders (supplier_id);
create index if not exists purchase_items_po_idx on purchase_order_items (purchase_order_id);
create index if not exists expenses_date_idx on expenses (expense_date);
create unique index if not exists employees_profile_unique on employees (profile_id) where profile_id is not null;
create index if not exists attendance_employee_idx on attendance (employee_id, work_date);
create index if not exists audit_created_idx on audit_logs (created_at desc);
create index if not exists login_history_user_idx on login_history (user_id, created_at desc);
create index if not exists cash_transactions_shift_idx on cash_transactions (shift_id);
-- ----------------------------------------------------------------------------
-- Permissions model
-- ----------------------------------------------------------------------------

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

create or replace function public.has_perm(p text)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1
    from profiles pr
    left join user_permissions up
      on up.user_id = pr.id and up.permission = p
    where pr.id = auth.uid()
      and pr.is_active
      and coalesce(up.allowed, p = any (role_default_perms(pr.role)))
  );
$$;

create or replace function public.is_staff()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (select 1 from profiles where id = auth.uid() and is_active);
$$;

create or replace function public.assert_perm(p text)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if not public.has_perm(p) then
    raise exception 'PERMISSION_DENIED:%', p using errcode = '42501';
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- Instance bootstrap / status
-- ----------------------------------------------------------------------------

create or replace function public.instance_status()
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_has_users boolean;
  v_name text;
begin
  select exists (select 1 from profiles) into v_has_users;
  select value->>'name' into v_name from settings where key = 'restaurant';
  return jsonb_build_object(
    'schema_ready', true,
    'has_users', v_has_users,
    'restaurant_name', coalesce(v_name, 'SUSHI ROLLS')
  );
end;
$$;

create or replace function public.bootstrap_admin(p_username text, p_full_name text)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(771701);
  if exists (select 1 from profiles) then
    raise exception 'ALREADY_SETUP';
  end if;
  if p_username !~ '^[a-z0-9._-]{3,32}$' then
    raise exception 'INVALID_USERNAME';
  end if;
  insert into profiles (id, username, full_name, role)
  values (auth.uid(), lower(p_username), coalesce(nullif(p_full_name, ''), p_username), 'super_admin');
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.log_login(p_username text, p_success boolean)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if auth.uid() is null then return; end if;
  insert into login_history (user_id, username, success, user_agent)
  values (
    auth.uid(),
    p_username,
    coalesce(p_success, true),
    current_setting('request.headers', true)::jsonb->>'user-agent'
  );
end;
$$;

-- ----------------------------------------------------------------------------
-- Triggers
-- ----------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_products_updated on products;
create trigger trg_products_updated before update on products
for each row execute function set_updated_at();

drop trigger if exists trg_ingredients_updated on ingredients;
create trigger trg_ingredients_updated before update on ingredients
for each row execute function set_updated_at();

drop trigger if exists trg_orders_updated on orders;
create trigger trg_orders_updated before update on orders
for each row execute function set_updated_at();

create or replace function public.guard_profile_update()
returns trigger language plpgsql security definer
set search_path = public
as $$
begin
  if not public.has_perm('users.manage') then
    if new.role <> old.role
       or new.is_active <> old.is_active
       or new.username <> old.username
       or new.id <> old.id then
      raise exception 'PERMISSION_DENIED:users.manage' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_profile_guard on profiles;
create trigger trg_profile_guard before update on profiles
for each row execute function guard_profile_update();

create or replace function public.audit_trigger()
returns trigger language plpgsql security definer
set search_path = public
as $$
declare
  v_id text;
begin
  v_id := coalesce((case when tg_op = 'DELETE' then old.id else new.id end)::text, '');
  insert into audit_logs (user_id, action, entity, entity_id, details)
  values (
    auth.uid(),
    lower(tg_op),
    tg_table_name,
    v_id,
    case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end
  );
  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_audit_orders on orders;
create trigger trg_audit_orders after insert or update on orders
for each row execute function audit_trigger();

drop trigger if exists trg_audit_payments on payments;
create trigger trg_audit_payments after insert or delete on payments
for each row execute function audit_trigger();

drop trigger if exists trg_audit_refunds on refunds;
create trigger trg_audit_refunds after insert on refunds
for each row execute function audit_trigger();

drop trigger if exists trg_audit_shifts on cash_shifts;
create trigger trg_audit_shifts after insert or update on cash_shifts
for each row execute function audit_trigger();

drop trigger if exists trg_audit_expenses on expenses;
create trigger trg_audit_expenses after insert or update or delete on expenses
for each row execute function audit_trigger();

drop trigger if exists trg_audit_profiles on profiles;
create trigger trg_audit_profiles after insert or update or delete on profiles
for each row execute function audit_trigger();

drop trigger if exists trg_audit_perms on user_permissions;
create trigger trg_audit_perms after insert or update or delete on user_permissions
for each row execute function audit_trigger();

drop trigger if exists trg_audit_purchases on purchase_orders;
create trigger trg_audit_purchases after insert or update on purchase_orders
for each row execute function audit_trigger();

-- ----------------------------------------------------------------------------
-- Default settings
-- ----------------------------------------------------------------------------

insert into settings (key, value) values
  ('restaurant', '{"name":"SUSHI ROLLS","phone":"","address":"","logo":""}'::jsonb),
  ('currency', '{"code":"EGP","symbol":"ج.م."}'::jsonb),
  ('tax', '{"enabled":false,"rate":14,"inclusive":false}'::jsonb),
  ('receipt', '{"footer":"شكراً لزيارتكم — SUSHI ROLLS","show_logo":true,"show_tax":true,"show_cashier":true}'::jsonb),
  ('orders', '{"send_to_kitchen":true}'::jsonb),
  ('inventory', '{"deduct_on":"confirmed"}'::jsonb),
  ('session', '{"timeout_minutes":480}'::jsonb),
  ('language', '{"default":"ar"}'::jsonb),
  ('printing', '{"width":80,"printer":""}'::jsonb)
on conflict (key) do nothing;
-- ----------------------------------------------------------------------------
-- Row Level Security
-- ----------------------------------------------------------------------------

alter table settings enable row level security;
alter table profiles enable row level security;
alter table user_permissions enable row level security;
alter table login_history enable row level security;
alter table suppliers enable row level security;
alter table ingredients enable row level security;
alter table categories enable row level security;
alter table products enable row level security;
alter table product_variants enable row level security;
alter table product_extras enable row level security;
alter table recipes enable row level security;
alter table recipe_items enable row level security;
alter table stock_movements enable row level security;
alter table purchase_orders enable row level security;
alter table purchase_order_items enable row level security;
alter table customers enable row level security;
alter table restaurant_tables enable row level security;
alter table expense_categories enable row level security;
alter table expenses enable row level security;
alter table cash_shifts enable row level security;
alter table orders enable row level security;
alter table order_items enable row level security;
alter table order_item_extras enable row level security;
alter table payments enable row level security;
alter table refunds enable row level security;
alter table cash_transactions enable row level security;
alter table employees enable row level security;
alter table attendance enable row level security;
alter table audit_logs enable row level security;
alter table backups enable row level security;

-- settings
drop policy if exists settings_read on settings;
create policy settings_read on settings for select to authenticated
using (public.is_staff());
drop policy if exists settings_write on settings;
create policy settings_write on settings for all to authenticated
using (public.has_perm('settings.manage'))
with check (public.has_perm('settings.manage'));

-- profiles
drop policy if exists profiles_read on profiles;
create policy profiles_read on profiles for select to authenticated
using (id = auth.uid() or public.has_perm('users.manage') or public.has_perm('employees.view'));
drop policy if exists profiles_update on profiles;
create policy profiles_update on profiles for update to authenticated
using (id = auth.uid() or public.has_perm('users.manage'))
with check (id = auth.uid() or public.has_perm('users.manage'));

-- user_permissions
drop policy if exists perms_read on user_permissions;
create policy perms_read on user_permissions for select to authenticated
using (user_id = auth.uid() or public.has_perm('users.manage'));
drop policy if exists perms_write on user_permissions;
create policy perms_write on user_permissions for all to authenticated
using (public.has_perm('users.manage'))
with check (public.has_perm('users.manage'));

-- login_history
drop policy if exists login_history_read on login_history;
create policy login_history_read on login_history for select to authenticated
using (user_id = auth.uid() or public.has_perm('users.manage'));

-- suppliers
drop policy if exists suppliers_read on suppliers;
create policy suppliers_read on suppliers for select to authenticated
using (public.has_perm('suppliers.view') or public.has_perm('purchases.view')
  or public.has_perm('inventory.view') or public.has_perm('reports.view'));
drop policy if exists suppliers_write on suppliers;
create policy suppliers_write on suppliers for all to authenticated
using (public.has_perm('suppliers.manage'))
with check (public.has_perm('suppliers.manage'));

-- ingredients
drop policy if exists ingredients_read on ingredients;
create policy ingredients_read on ingredients for select to authenticated
using (public.is_staff());
drop policy if exists ingredients_write on ingredients;
create policy ingredients_write on ingredients for all to authenticated
using (public.has_perm('inventory.manage'))
with check (public.has_perm('inventory.manage'));

-- categories
drop policy if exists categories_read on categories;
create policy categories_read on categories for select to authenticated
using (public.is_staff());
drop policy if exists categories_write on categories;
create policy categories_write on categories for all to authenticated
using (public.has_perm('menu.manage'))
with check (public.has_perm('menu.manage'));

-- products
drop policy if exists products_read on products;
create policy products_read on products for select to authenticated
using (public.is_staff());
drop policy if exists products_write on products;
create policy products_write on products for all to authenticated
using (public.has_perm('menu.manage'))
with check (public.has_perm('menu.manage'));

-- product_variants
drop policy if exists variants_read on product_variants;
create policy variants_read on product_variants for select to authenticated
using (public.is_staff());
drop policy if exists variants_write on product_variants;
create policy variants_write on product_variants for all to authenticated
using (public.has_perm('menu.manage'))
with check (public.has_perm('menu.manage'));

-- product_extras
drop policy if exists extras_read on product_extras;
create policy extras_read on product_extras for select to authenticated
using (public.is_staff());
drop policy if exists extras_write on product_extras;
create policy extras_write on product_extras for all to authenticated
using (public.has_perm('menu.manage'))
with check (public.has_perm('menu.manage'));

-- recipes
drop policy if exists recipes_read on recipes;
create policy recipes_read on recipes for select to authenticated
using (public.is_staff());
drop policy if exists recipes_write on recipes;
create policy recipes_write on recipes for all to authenticated
using (public.has_perm('inventory.manage') or public.has_perm('menu.manage'))
with check (public.has_perm('inventory.manage') or public.has_perm('menu.manage'));

-- recipe_items
drop policy if exists recipe_items_read on recipe_items;
create policy recipe_items_read on recipe_items for select to authenticated
using (public.is_staff());
drop policy if exists recipe_items_write on recipe_items;
create policy recipe_items_write on recipe_items for all to authenticated
using (public.has_perm('inventory.manage') or public.has_perm('menu.manage'))
with check (public.has_perm('inventory.manage') or public.has_perm('menu.manage'));

-- stock_movements
drop policy if exists stock_movements_read on stock_movements;
create policy stock_movements_read on stock_movements for select to authenticated
using (public.has_perm('inventory.view') or public.has_perm('reports.view'));

-- purchase_orders
drop policy if exists purchase_orders_read on purchase_orders;
create policy purchase_orders_read on purchase_orders for select to authenticated
using (public.has_perm('purchases.view') or public.has_perm('reports.view'));
drop policy if exists purchase_orders_write on purchase_orders;
create policy purchase_orders_write on purchase_orders for all to authenticated
using (public.has_perm('purchases.manage'))
with check (public.has_perm('purchases.manage'));

-- purchase_order_items
drop policy if exists purchase_items_read on purchase_order_items;
create policy purchase_items_read on purchase_order_items for select to authenticated
using (public.has_perm('purchases.view') or public.has_perm('reports.view'));
drop policy if exists purchase_items_write on purchase_order_items;
create policy purchase_items_write on purchase_order_items for all to authenticated
using (public.has_perm('purchases.manage'))
with check (public.has_perm('purchases.manage'));

-- customers
drop policy if exists customers_read on customers;
create policy customers_read on customers for select to authenticated
using (public.has_perm('customers.view') or public.has_perm('pos.use') or public.has_perm('orders.view'));
drop policy if exists customers_insert on customers;
create policy customers_insert on customers for insert to authenticated
with check (public.has_perm('customers.manage') or public.has_perm('pos.use'));
drop policy if exists customers_update on customers;
create policy customers_update on customers for update to authenticated
using (public.has_perm('customers.manage'))
with check (public.has_perm('customers.manage'));

drop policy if exists customers_delete on customers;
create policy customers_delete on customers for delete to authenticated
using (public.has_perm('customers.manage'));

-- restaurant_tables
drop policy if exists tables_read on restaurant_tables;
create policy tables_read on restaurant_tables for select to authenticated
using (public.is_staff());
drop policy if exists tables_write on restaurant_tables;
create policy tables_write on restaurant_tables for all to authenticated
using (public.has_perm('tables.manage'))
with check (public.has_perm('tables.manage'));

-- expense_categories
drop policy if exists expense_categories_read on expense_categories;
create policy expense_categories_read on expense_categories for select to authenticated
using (public.is_staff());
drop policy if exists expense_categories_write on expense_categories;
create policy expense_categories_write on expense_categories for all to authenticated
using (public.has_perm('expenses.manage'))
with check (public.has_perm('expenses.manage'));

-- expenses
drop policy if exists expenses_read on expenses;
create policy expenses_read on expenses for select to authenticated
using (public.has_perm('expenses.view') or public.has_perm('reports.view'));
drop policy if exists expenses_write on expenses;
create policy expenses_write on expenses for all to authenticated
using (public.has_perm('expenses.manage'))
with check (public.has_perm('expenses.manage'));

-- cash_shifts
drop policy if exists shifts_read on cash_shifts;
create policy shifts_read on cash_shifts for select to authenticated
using (user_id = auth.uid() or public.has_perm('cash.review'));

-- cash_transactions
drop policy if exists cash_tx_read on cash_transactions;
create policy cash_tx_read on cash_transactions for select to authenticated
using (exists (
  select 1 from cash_shifts s
  where s.id = shift_id and (s.user_id = auth.uid() or public.has_perm('cash.review'))
));

-- orders
drop policy if exists orders_read on orders;
create policy orders_read on orders for select to authenticated
using (public.has_perm('orders.view') or public.has_perm('pos.use') or public.has_perm('kds.use'));

-- order_items
drop policy if exists order_items_read on order_items;
create policy order_items_read on order_items for select to authenticated
using (public.has_perm('orders.view') or public.has_perm('pos.use') or public.has_perm('kds.use'));

-- order_item_extras
drop policy if exists order_extras_read on order_item_extras;
create policy order_extras_read on order_item_extras for select to authenticated
using (public.has_perm('orders.view') or public.has_perm('pos.use') or public.has_perm('kds.use'));

-- payments
drop policy if exists payments_read on payments;
create policy payments_read on payments for select to authenticated
using (public.has_perm('orders.view') or public.has_perm('reports.view'));

-- refunds
drop policy if exists refunds_read on refunds;
create policy refunds_read on refunds for select to authenticated
using (public.has_perm('orders.view') or public.has_perm('reports.view'));

-- employees
drop policy if exists employees_read on employees;
create policy employees_read on employees for select to authenticated
using (public.has_perm('employees.view') or public.has_perm('reports.view') or public.has_perm('users.manage'));
drop policy if exists employees_write on employees;
create policy employees_write on employees for all to authenticated
using (public.has_perm('employees.manage'))
with check (public.has_perm('employees.manage'));

-- attendance
drop policy if exists attendance_read on attendance;
create policy attendance_read on attendance for select to authenticated
using (public.has_perm('employees.view') or public.has_perm('reports.view') or exists (
  select 1 from employees e where e.id = employee_id and e.profile_id = auth.uid()
));

-- audit_logs
drop policy if exists audit_read on audit_logs;
create policy audit_read on audit_logs for select to authenticated
using (public.has_perm('audit.view'));

-- backups
drop policy if exists backups_all on backups;
create policy backups_all on backups for all to authenticated
using (public.has_perm('backup.manage'))
with check (public.has_perm('backup.manage'));
-- ----------------------------------------------------------------------------
-- Order workflow
-- ----------------------------------------------------------------------------

create or replace function public._deduct_inventory(p_order uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_done timestamptz;
  v_item record;
  v_rec record;
  v_extra record;
begin
  select inventory_deducted_at into v_done from orders where id = p_order;
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

create or replace function public._recalc_order(p_order uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_order orders%rowtype;
  v_subtotal numeric(12,2);
  v_discount numeric(12,2);
  v_tax_cfg jsonb;
  v_tax numeric(12,2) := 0;
  v_total numeric(12,2);
  v_paid numeric(12,2);
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
  if v_paid >= v_total and v_total > 0 then
    v_status := 'paid';
  elsif v_paid > 0 then
    v_status := 'partial';
  elsif v_order.payment_status = 'refunded' then
    v_status := 'refunded';
  else
    v_status := 'unpaid';
  end if;
  update orders set subtotal = v_subtotal, discount = v_discount, tax = v_tax,
    total = v_total, payment_status = v_status
  where id = p_order;
end;
$$;

create or replace function public.submit_order(p_payload jsonb, p_options jsonb default '{}'::jsonb)
returns jsonb
language plpgsql security definer
set search_path = public
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

create or replace function public.set_order_status(p_order uuid, p_status text)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_order orders%rowtype;
begin
  if not (public.has_perm('pos.use') or public.has_perm('kds.use')) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_status not in ('confirmed','sent_to_kitchen','preparing','ready','completed') then
    raise exception 'INVALID_STATUS';
  end if;
  select * into v_order from orders where id = p_order for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  if v_order.status in ('completed','cancelled') then
    raise exception 'ORDER_CLOSED';
  end if;
  if not (
    (v_order.status = 'draft' and p_status in ('confirmed','sent_to_kitchen'))
    or (v_order.status = 'confirmed' and p_status in ('sent_to_kitchen','preparing'))
    or (v_order.status = 'sent_to_kitchen' and p_status in ('preparing','ready'))
    or (v_order.status = 'preparing' and p_status in ('ready','completed'))
    or (v_order.status = 'ready' and p_status = 'completed')
  ) then
    raise exception 'INVALID_TRANSITION:%->%', v_order.status, p_status;
  end if;

  if p_status in ('sent_to_kitchen','preparing','ready','completed') then
    perform public._deduct_inventory(p_order);
  end if;

  update orders set status = p_status,
    completed_at = case when p_status = 'completed' then now() else completed_at end
  where id = p_order;

  if v_order.table_id is not null and p_status = 'completed' then
    update restaurant_tables set status = 'available', waiter_id = null where id = v_order.table_id;
  end if;

  return (select to_jsonb(o) from orders o where o.id = p_order);
end;
$$;

create or replace function public.cancel_order(p_order uuid, p_reason text)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_order orders%rowtype;
  v_item record;
  v_rec record;
  v_extra record;
begin
  perform public.assert_perm('orders.cancel');
  select * into v_order from orders where id = p_order for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  if v_order.status = 'cancelled' then raise exception 'ALREADY_CANCELLED'; end if;
  if v_order.status = 'completed' then
    raise exception 'USE_REFUND_FOR_COMPLETED';
  end if;

  if v_order.inventory_deducted_at is not null then
    for v_item in select * from order_items where order_id = p_order loop
      for v_rec in
        select ri.ingredient_id, ri.quantity * v_item.quantity as qty
        from recipe_items ri
        join recipes r on r.id = ri.recipe_id
        where r.product_id = v_item.product_id
      loop
        update ingredients set quantity = quantity + v_rec.qty, updated_at = now()
        where id = v_rec.ingredient_id;
        insert into stock_movements (ingredient_id, delta, type, reference_type, reference_id, note, created_by)
        values (v_rec.ingredient_id, v_rec.qty, 'reversal', 'order', p_order, 'إرجاع مخزون بعد إلغاء أوردر', auth.uid());
      end loop;
      for v_extra in
        select oie.quantity, pe.ingredient_id, pe.ingredient_qty
        from order_item_extras oie
        join product_extras pe on pe.id = oie.extra_id
        where oie.order_item_id = v_item.id and pe.ingredient_id is not null
      loop
        update ingredients set quantity = quantity + (v_extra.ingredient_qty * v_extra.quantity), updated_at = now()
        where id = v_extra.ingredient_id;
        insert into stock_movements (ingredient_id, delta, type, reference_type, reference_id, note, created_by)
        values (v_extra.ingredient_id, (v_extra.ingredient_qty * v_extra.quantity), 'reversal', 'order', p_order, 'إرجاع إضافة بعد إلغاء أوردر', auth.uid());
      end loop;
    end loop;
  end if;

  update orders set status = 'cancelled', cancel_reason = p_reason,
    cancelled_by = auth.uid(), cancelled_at = now()
  where id = p_order;

  if v_order.table_id is not null then
    update restaurant_tables set status = 'available', waiter_id = null where id = v_order.table_id;
  end if;

  return (select to_jsonb(o) from orders o where o.id = p_order);
end;
$$;

create or replace function public.pay_order(
  p_order uuid,
  p_method text,
  p_amount numeric,
  p_reference text default null
)
returns jsonb
language plpgsql security definer
set search_path = public
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

create or replace function public.refund_order(p_order uuid, p_amount numeric, p_reason text)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_order orders%rowtype;
  v_shift uuid;
  v_refunded numeric(12,2);
  v_method text;
begin
  perform public.assert_perm('orders.refund');
  if p_amount is null or p_amount <= 0 then raise exception 'INVALID_AMOUNT'; end if;
  select * into v_order from orders where id = p_order for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;

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
  if v_refunded >= v_order.total then
    update orders set payment_status = 'refunded' where id = p_order;
  end if;

  return jsonb_build_object('ok', true, 'refunded_total', v_refunded);
end;
$$;

create or replace function public.split_order(p_order uuid, p_item_ids uuid[])
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_order orders%rowtype;
  v_new_id uuid;
  v_item record;
begin
  perform public.assert_perm('pos.use');
  select * into v_order from orders where id = p_order for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  if v_order.status not in ('draft','confirmed') then raise exception 'ORDER_NOT_SPLITTABLE'; end if;
  if coalesce(array_length(p_item_ids, 1), 0) = 0 then raise exception 'NO_ITEMS'; end if;

  insert into orders (order_type, table_id, customer_id, customer_name, customer_phone, customer_address,
    cashier_id, waiter_id, tax_rate, notes, status)
  values (v_order.order_type, v_order.table_id, v_order.customer_id, v_order.customer_name,
    v_order.customer_phone, v_order.customer_address, auth.uid(), v_order.waiter_id,
    v_order.tax_rate, 'فاتورة مقسمة من #' || v_order.order_number, 'draft')
  returning id into v_new_id;

  for v_item in
    select * from order_items where order_id = p_order and id = any (p_item_ids)
  loop
    update order_items set order_id = v_new_id where id = v_item.id;
  end loop;

  perform public._recalc_order(p_order);
  perform public._recalc_order(v_new_id);

  return jsonb_build_object(
    'new_order_id', v_new_id,
    'new_order_number', (select order_number from orders where id = v_new_id)
  );
end;
$$;

create or replace function public.transfer_table(p_order uuid, p_table_id uuid)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_order orders%rowtype;
begin
  perform public.assert_perm('tables.manage');
  select * into v_order from orders where id = p_order;
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
-- Cash register & shifts
-- ----------------------------------------------------------------------------

create or replace function public.open_shift(p_opening_balance numeric, p_note text default null)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  perform public.assert_perm('cash.manage');
  if exists (select 1 from cash_shifts where user_id = auth.uid() and status = 'open') then
    raise exception 'SHIFT_ALREADY_OPEN';
  end if;
  insert into cash_shifts (user_id, opening_balance)
  values (auth.uid(), coalesce(p_opening_balance, 0))
  returning id into v_id;
  insert into cash_transactions (shift_id, type, amount, note, created_by)
  values (v_id, 'opening', coalesce(p_opening_balance, 0), p_note, auth.uid());
  return (select to_jsonb(s) from cash_shifts s where s.id = v_id);
end;
$$;

create or replace function public.cash_adjust(p_type text, p_amount numeric, p_note text default null)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_shift uuid;
begin
  perform public.assert_perm('cash.manage');
  if p_type not in ('withdrawal','addition') then raise exception 'INVALID_TYPE'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'INVALID_AMOUNT'; end if;
  select id into v_shift from cash_shifts where user_id = auth.uid() and status = 'open' limit 1;
  if v_shift is null then raise exception 'NO_OPEN_SHIFT'; end if;
  insert into cash_transactions (shift_id, type, amount, note, created_by)
  values (v_shift, p_type, case when p_type = 'withdrawal' then -p_amount else p_amount end, p_note, auth.uid());
  return (select to_jsonb(s) from cash_shifts s where s.id = v_shift);
end;
$$;

create or replace function public.close_shift(p_actual numeric, p_note text default null)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_shift cash_shifts%rowtype;
  v_expected numeric(12,2);
  v_sales numeric(12,2);
begin
  perform public.assert_perm('cash.manage');
  select * into v_shift from cash_shifts
  where user_id = auth.uid() and status = 'open' for update;
  if not found then raise exception 'NO_OPEN_SHIFT'; end if;

  select coalesce(sum(amount), 0) into v_sales from cash_transactions
  where shift_id = v_shift.id and type = 'sale';
  select coalesce(v_shift.opening_balance, 0) + coalesce(sum(amount), 0) into v_expected
  from cash_transactions where shift_id = v_shift.id;

  update cash_shifts set status = 'closed', closed_at = now(),
    closing_balance = coalesce(p_actual, 0),
    expected_balance = v_expected,
    difference = coalesce(p_actual, 0) - v_expected,
    total_sales = v_sales,
    notes = p_note
  where id = v_shift.id;

  insert into cash_transactions (shift_id, type, amount, note, created_by)
  values (v_shift.id, 'closing', coalesce(p_actual, 0), p_note, auth.uid());

  return (select to_jsonb(s) from cash_shifts s where s.id = v_shift.id);
end;
$$;

-- ----------------------------------------------------------------------------
-- Inventory & purchases
-- ----------------------------------------------------------------------------

create or replace function public.adjust_stock(
  p_ingredient uuid,
  p_delta numeric,
  p_type text,
  p_note text default null,
  p_unit_cost numeric default null
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
begin
  perform public.assert_perm('inventory.manage');
  if p_delta = 0 then raise exception 'INVALID_DELTA'; end if;
  if p_type not in ('in','out','adjustment','waste','damage','expired','transfer') then
    raise exception 'INVALID_TYPE';
  end if;
  update ingredients set quantity = quantity + p_delta,
    purchase_cost = coalesce(nullif(p_unit_cost, 0), purchase_cost),
    updated_at = now()
  where id = p_ingredient;
  if not found then raise exception 'INGREDIENT_NOT_FOUND'; end if;
  insert into stock_movements (ingredient_id, delta, type, note, unit_cost, created_by)
  values (p_ingredient, p_delta, p_type, p_note, p_unit_cost, auth.uid());
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.receive_purchase(p_po uuid)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_po purchase_orders%rowtype;
  v_item record;
begin
  perform public.assert_perm('purchases.manage');
  select * into v_po from purchase_orders where id = p_po for update;
  if not found then raise exception 'PO_NOT_FOUND'; end if;
  if v_po.status = 'received' then raise exception 'ALREADY_RECEIVED'; end if;
  if v_po.status = 'cancelled' then raise exception 'PO_CANCELLED'; end if;

  for v_item in select * from purchase_order_items where purchase_order_id = p_po loop
    update ingredients set quantity = quantity + v_item.quantity,
      purchase_cost = v_item.unit_cost, updated_at = now()
    where id = v_item.ingredient_id;
    insert into stock_movements (ingredient_id, delta, type, reference_type, reference_id, unit_cost, note, created_by)
    values (v_item.ingredient_id, v_item.quantity, 'purchase', 'purchase_order', p_po, v_item.unit_cost, 'استلام أمر شراء', auth.uid());
  end loop;

  update purchase_orders set status = 'received', received_at = now() where id = p_po;
  update suppliers set balance = balance + (v_po.total - v_po.paid) where id = v_po.supplier_id;

  return (select to_jsonb(p) from purchase_orders p where p.id = p_po);
end;
$$;

-- ----------------------------------------------------------------------------
-- Attendance
-- ----------------------------------------------------------------------------

create or replace function public.attendance_check_in()
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_emp uuid;
  v_open uuid;
  v_id uuid;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  select id into v_emp from employees where profile_id = auth.uid() and is_active limit 1;
  if v_emp is null then raise exception 'NO_EMPLOYEE_RECORD'; end if;
  select id into v_open from attendance
  where employee_id = v_emp and check_out is null and work_date = current_date limit 1;
  if v_open is not null then raise exception 'ALREADY_CHECKED_IN'; end if;
  insert into attendance (employee_id, check_in, work_date)
  values (v_emp, now(), current_date) returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;

create or replace function public.attendance_check_out()
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_emp uuid;
  v_open uuid;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  select id into v_emp from employees where profile_id = auth.uid() and is_active limit 1;
  if v_emp is null then raise exception 'NO_EMPLOYEE_RECORD'; end if;
  select id into v_open from attendance
  where employee_id = v_emp and check_out is null order by check_in desc limit 1;
  if v_open is null then raise exception 'NOT_CHECKED_IN'; end if;
  update attendance set check_out = now() where id = v_open;
  return jsonb_build_object('ok', true);
end;
$$;
-- ----------------------------------------------------------------------------
-- Reports & analytics
-- ----------------------------------------------------------------------------

create or replace function public.get_dashboard(p_from timestamptz, p_to timestamptz, p_tz text default 'Africa/Cairo')
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_sales numeric(12,2);
  v_count int;
  v_completed int;
  v_pending int;
  v_cancelled int;
  v_expenses numeric(12,2);
  v_cogs numeric(12,2);
begin
  perform public.assert_perm('dashboard.view');

  select coalesce(sum(total), 0), count(*) into v_sales, v_count
  from orders where status <> 'cancelled' and created_at >= p_from and created_at < p_to;

  select count(*) into v_completed from orders
  where status = 'completed' and created_at >= p_from and created_at < p_to;

  select count(*) into v_pending from orders
  where status in ('draft','confirmed','sent_to_kitchen','preparing','ready')
    and created_at >= p_from and created_at < p_to;

  select count(*) into v_cancelled from orders
  where status = 'cancelled' and created_at >= p_from and created_at < p_to;

  select coalesce(sum(amount), 0) into v_expenses from expenses
  where expense_date >= (p_from at time zone p_tz)::date
    and expense_date <= (p_to at time zone p_tz)::date;

  select coalesce(sum(oi.cost_snapshot * oi.quantity), 0) into v_cogs
  from order_items oi join orders o on o.id = oi.order_id
  where o.status <> 'cancelled' and o.created_at >= p_from and o.created_at < p_to;

  return jsonb_build_object(
    'sales', v_sales,
    'orders_count', v_count,
    'completed', v_completed,
    'pending', v_pending,
    'cancelled', v_cancelled,
    'avg_order', case when v_count > 0 then round(v_sales / v_count, 2) else 0 end,
    'expenses', v_expenses,
    'cogs', v_cogs,
    'profit_estimate', v_sales - v_cogs - v_expenses,
    'active_staff', coalesce((select count(distinct employee_id) from attendance
      where work_date = current_date and check_in is not null), 0),
    'best_products', coalesce((
      select jsonb_agg(x) from (
        select oi.name_snapshot as name, sum(oi.quantity)::int as qty, sum(oi.line_total) as sales
        from order_items oi join orders o on o.id = oi.order_id
        where o.status <> 'cancelled' and o.created_at >= p_from and o.created_at < p_to
        group by oi.name_snapshot order by qty desc limit 5
      ) x
    ), '[]'::jsonb),
    'low_stock', coalesce((
      select jsonb_agg(x) from (
        select id, name_ar as name, quantity, min_stock, unit
        from ingredients where is_active and quantity <= min_stock
        order by quantity / greatest(min_stock, 0.001) asc limit 5
      ) x
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.report_sales_by_day(p_from date, p_to date, p_tz text default 'Africa/Cairo')
returns jsonb
language plpgsql security definer
set search_path = public
as $$
begin
  perform public.assert_perm('dashboard.view');
  return coalesce((
    select jsonb_agg(x order by x->>'date') from (
      select jsonb_build_object(
        'date', d::date,
        'sales', coalesce((select sum(total) from orders o
          where o.status <> 'cancelled' and (o.created_at at time zone p_tz)::date = d::date), 0),
        'orders', coalesce((select count(*) from orders o
          where o.status <> 'cancelled' and (o.created_at at time zone p_tz)::date = d::date), 0)
      ) as x
      from generate_series(p_from, p_to, interval '1 day') d
    ) t
  ), '[]'::jsonb);
end;
$$;

create or replace function public.report_payment_methods(p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
begin
  perform public.assert_perm('reports.view');
  return coalesce((
    select jsonb_agg(jsonb_build_object('method', method, 'amount', amount, 'count', cnt)) from (
      select p.method, sum(p.amount) as amount, count(*) as cnt
      from payments p join orders o on o.id = p.order_id
      where o.status <> 'cancelled' and o.created_at >= p_from and o.created_at < p_to
      group by p.method order by amount desc
    ) t
  ), '[]'::jsonb);
end;
$$;

create or replace function public.report_order_types(p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
begin
  perform public.assert_perm('reports.view');
  return coalesce((
    select jsonb_agg(jsonb_build_object('type', order_type, 'amount', amount, 'count', cnt)) from (
      select order_type, coalesce(sum(total), 0) as amount, count(*) as cnt
      from orders
      where status <> 'cancelled' and created_at >= p_from and created_at < p_to
      group by order_type
    ) t
  ), '[]'::jsonb);
end;
$$;

create or replace function public.report_top_products(p_from timestamptz, p_to timestamptz, p_limit int default 10)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
begin
  perform public.assert_perm('reports.view');
  return coalesce((
    select jsonb_agg(jsonb_build_object('name', name, 'qty', qty, 'sales', sales)) from (
      select oi.name_snapshot as name, sum(oi.quantity)::int as qty, sum(oi.line_total) as sales
      from order_items oi join orders o on o.id = oi.order_id
      where o.status <> 'cancelled' and o.created_at >= p_from and o.created_at < p_to
      group by oi.name_snapshot
      order by qty desc
      limit greatest(p_limit, 1)
    ) t
  ), '[]'::jsonb);
end;
$$;

create or replace function public.report_products_sold(p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
begin
  perform public.assert_perm('reports.view');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'name', name, 'qty', qty, 'sales', sales, 'cost', cost, 'profit', sales - cost
    )) from (
      select oi.name_snapshot as name, sum(oi.quantity)::int as qty,
        sum(oi.line_total) as sales, sum(oi.cost_snapshot * oi.quantity) as cost
      from order_items oi join orders o on o.id = oi.order_id
      where o.status <> 'cancelled' and o.created_at >= p_from and o.created_at < p_to
      group by oi.name_snapshot
      order by sales desc
    ) t
  ), '[]'::jsonb);
end;
$$;

create or replace function public.report_expenses_by_category(p_from date, p_to date)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
begin
  perform public.assert_perm('reports.view');
  return coalesce((
    select jsonb_agg(jsonb_build_object('category', category, 'amount', amount, 'count', cnt)) from (
      select coalesce(ec.name_ar, 'أخرى') as category, sum(e.amount) as amount, count(*) as cnt
      from expenses e left join expense_categories ec on ec.id = e.category_id
      where e.expense_date >= p_from and e.expense_date <= p_to
      group by ec.name_ar order by amount desc
    ) t
  ), '[]'::jsonb);
end;
$$;

create or replace function public.report_profit(p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_gross numeric(12,2);
  v_tax numeric(12,2);
  v_cogs numeric(12,2);
  v_expenses numeric(12,2);
  v_discount numeric(12,2);
begin
  perform public.assert_perm('reports.view');
  select coalesce(sum(total), 0), coalesce(sum(tax), 0), coalesce(sum(discount), 0)
  into v_gross, v_tax, v_discount
  from orders where status <> 'cancelled' and created_at >= p_from and created_at < p_to;

  select coalesce(sum(oi.cost_snapshot * oi.quantity), 0) into v_cogs
  from order_items oi join orders o on o.id = oi.order_id
  where o.status <> 'cancelled' and o.created_at >= p_from and o.created_at < p_to;

  select coalesce(sum(amount), 0) into v_expenses from expenses
  where expense_date >= (p_from at time zone 'Africa/Cairo')::date
    and expense_date <= (p_to at time zone 'Africa/Cairo')::date;

  return jsonb_build_object(
    'gross_sales', v_gross,
    'tax', v_tax,
    'discounts', v_discount,
    'net_sales', v_gross - v_tax,
    'cogs', v_cogs,
    'expenses', v_expenses,
    'profit_estimate', (v_gross - v_tax) - v_cogs - v_expenses,
    'is_estimate', true
  );
end;
$$;

create or replace function public.report_cashier_sales(p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
begin
  perform public.assert_perm('reports.view');
  return coalesce((
    select jsonb_agg(jsonb_build_object('cashier', cashier, 'amount', amount, 'count', cnt)) from (
      select coalesce(pr.full_name, '—') as cashier, coalesce(sum(o.total), 0) as amount, count(*) as cnt
      from orders o left join profiles pr on pr.id = o.cashier_id
      where o.status <> 'cancelled' and o.created_at >= p_from and o.created_at < p_to
      group by pr.full_name order by amount desc
    ) t
  ), '[]'::jsonb);
end;
$$;

create or replace function public.report_customers(p_limit int default 20)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
begin
  perform public.assert_perm('reports.view');
  return coalesce((
    select jsonb_agg(jsonb_build_object('name', name, 'phone', phone, 'orders', orders, 'spending', spending)) from (
      select name, phone, total_orders as orders, total_spending as spending
      from customers order by total_spending desc limit greatest(p_limit, 1)
    ) t
  ), '[]'::jsonb);
end;
$$;

create or replace function public.report_inventory_value()
returns jsonb
language plpgsql security definer
set search_path = public
as $$
begin
  perform public.assert_perm('reports.view');
  return jsonb_build_object(
    'total_value', coalesce((select sum(quantity * purchase_cost) from ingredients where is_active), 0),
    'items_count', (select count(*) from ingredients where is_active),
    'low_stock_count', (select count(*) from ingredients where is_active and quantity <= min_stock),
    'expiring_count', (select count(*) from ingredients where is_active
      and expiry_date is not null and expiry_date <= current_date + 7),
    'low_stock', coalesce((
      select jsonb_agg(jsonb_build_object('name', name_ar, 'quantity', quantity, 'min_stock', min_stock, 'unit', unit)) from (
        select name_ar, quantity, min_stock, unit from ingredients
        where is_active and quantity <= min_stock
        order by quantity / greatest(min_stock, 0.001) asc limit 20
      ) x
    ), '[]'::jsonb),
    'expiring', coalesce((
      select jsonb_agg(jsonb_build_object('name', name_ar, 'expiry_date', expiry_date, 'quantity', quantity)) from (
        select name_ar, expiry_date, quantity from ingredients
        where is_active and expiry_date is not null and expiry_date <= current_date + 7
        order by expiry_date asc limit 20
      ) x
    ), '[]'::jsonb)
  );
end;
$$;

-- ----------------------------------------------------------------------------
-- Realtime
-- ----------------------------------------------------------------------------

do $$
begin
  alter publication supabase_realtime add table orders;
exception when duplicate_object then null; when undefined_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table order_items;
exception when duplicate_object then null; when undefined_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table restaurant_tables;
exception when duplicate_object then null; when undefined_object then null;
end $$;

-- ----------------------------------------------------------------------------
-- Storage bucket for product images
-- ----------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-images', 'product-images', true, 5242880, array['image/png','image/jpeg','image/webp'])
on conflict (id) do update set public = true;

drop policy if exists "product images write" on storage.objects;
create policy "product images write" on storage.objects for all to authenticated
using (bucket_id = 'product-images' and public.has_perm('menu.manage'))
with check (bucket_id = 'product-images' and public.has_perm('menu.manage'));

-- ----------------------------------------------------------------------------
-- Grants
-- ----------------------------------------------------------------------------

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;

grant execute on function public.instance_status() to anon, authenticated;
grant execute on function public.bootstrap_admin(text, text) to authenticated;
grant execute on function public.log_login(text, boolean) to authenticated;
grant execute on function public.has_perm(text) to authenticated;
grant execute on function public.is_staff() to authenticated;
grant execute on function public.assert_perm(text) to authenticated;

revoke execute on function public.submit_order(jsonb, jsonb) from public, anon;
grant execute on function public.submit_order(jsonb, jsonb) to authenticated;

revoke execute on function public.set_order_status(uuid, text) from public, anon;
grant execute on function public.set_order_status(uuid, text) to authenticated;

revoke execute on function public.cancel_order(uuid, text) from public, anon;
grant execute on function public.cancel_order(uuid, text) to authenticated;

revoke execute on function public.pay_order(uuid, text, numeric, text) from public, anon;
grant execute on function public.pay_order(uuid, text, numeric, text) to authenticated;

revoke execute on function public.refund_order(uuid, numeric, text) from public, anon;
grant execute on function public.refund_order(uuid, numeric, text) to authenticated;

revoke execute on function public.split_order(uuid, uuid[]) from public, anon;
grant execute on function public.split_order(uuid, uuid[]) to authenticated;

revoke execute on function public.transfer_table(uuid, uuid) from public, anon;
grant execute on function public.transfer_table(uuid, uuid) to authenticated;

revoke execute on function public.open_shift(numeric, text) from public, anon;
grant execute on function public.open_shift(numeric, text) to authenticated;

revoke execute on function public.cash_adjust(text, numeric, text) from public, anon;
grant execute on function public.cash_adjust(text, numeric, text) to authenticated;

revoke execute on function public.close_shift(numeric, text) from public, anon;
grant execute on function public.close_shift(numeric, text) to authenticated;

revoke execute on function public.adjust_stock(uuid, numeric, text, text, numeric) from public, anon;
grant execute on function public.adjust_stock(uuid, numeric, text, text, numeric) to authenticated;

revoke execute on function public.receive_purchase(uuid) from public, anon;
grant execute on function public.receive_purchase(uuid) to authenticated;

revoke execute on function public.attendance_check_in() from public, anon;
grant execute on function public.attendance_check_in() to authenticated;

revoke execute on function public.attendance_check_out() from public, anon;
grant execute on function public.attendance_check_out() to authenticated;

revoke execute on function public.get_dashboard(timestamptz, timestamptz, text) from public, anon;
grant execute on function public.get_dashboard(timestamptz, timestamptz, text) to authenticated;

revoke execute on function public.report_sales_by_day(date, date, text) from public, anon;
grant execute on function public.report_sales_by_day(date, date, text) to authenticated;

revoke execute on function public.report_payment_methods(timestamptz, timestamptz) from public, anon;
grant execute on function public.report_payment_methods(timestamptz, timestamptz) to authenticated;

revoke execute on function public.report_order_types(timestamptz, timestamptz) from public, anon;
grant execute on function public.report_order_types(timestamptz, timestamptz) to authenticated;

revoke execute on function public.report_top_products(timestamptz, timestamptz, int) from public, anon;
grant execute on function public.report_top_products(timestamptz, timestamptz, int) to authenticated;

revoke execute on function public.report_products_sold(timestamptz, timestamptz) from public, anon;
grant execute on function public.report_products_sold(timestamptz, timestamptz) to authenticated;

revoke execute on function public.report_expenses_by_category(date, date) from public, anon;
grant execute on function public.report_expenses_by_category(date, date) to authenticated;

revoke execute on function public.report_profit(timestamptz, timestamptz) from public, anon;
grant execute on function public.report_profit(timestamptz, timestamptz) to authenticated;

revoke execute on function public.report_cashier_sales(timestamptz, timestamptz) from public, anon;
grant execute on function public.report_cashier_sales(timestamptz, timestamptz) to authenticated;

revoke execute on function public.report_customers(int) from public, anon;
grant execute on function public.report_customers(int) to authenticated;

revoke execute on function public.report_inventory_value() from public, anon;
grant execute on function public.report_inventory_value() to authenticated;
