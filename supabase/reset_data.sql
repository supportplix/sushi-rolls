-- WARNING: DESTRUCTIVE. Run ONLY in Supabase SQL Editor as the project owner.
-- Deletes ALL business data and resets the order-number sequence.
-- Keeps auth.users + public.profiles so the existing super admin can still log in.
-- TRUNCATE is used on purpose: it is fast, does not fire per-row audit triggers,
-- and resets owned sequences. There is NO undo. Take a Supabase backup first.

begin;

truncate table
  public.deleted_rows,
  public.attendance_events,
  public.device_commands,
  public.employee_devices,
  public.attendance_devices,
  public.attendance,
  public.employees,
  public.audit_logs,
  public.login_history,
  public.backups,
  public.cash_transactions,
  public.cash_shifts,
  public.refunds,
  public.payments,
  public.order_item_extras,
  public.order_items,
  public.orders,
  public.expenses,
  public.expense_categories,
  public.restaurant_tables,
  public.customers,
  public.purchase_order_items,
  public.purchase_orders,
  public.stock_movements,
  public.recipe_items,
  public.recipes,
  public.product_extras,
  public.product_variants,
  public.products,
  public.categories,
  public.ingredients,
  public.suppliers,
  public.user_permissions,
  public.settings
  restart identity cascade;

select setval('public.order_number_seq', 1000, true);

insert into public.settings (key, value) values
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

commit;

-- OPTIONAL — only if you really want to remove all user accounts too.
-- After this NOBODY can log in until a new identity is created in Auth and a
-- matching profile row with role 'super_admin' is inserted. Do not run blindly.
-- delete from public.profiles;
-- delete from auth.users;
