-- Read-only. Run in Supabase SQL Editor to confirm the database objects used by
-- v1.0.30 + the optional trash feature exist. Returns OK / MISSING per object.

with expected(label, present) as (
  select 'schema baseline: attendance_devices', to_regclass('public.attendance_devices') is not null
  union all select 'schema baseline: order_number_seq', to_regclass('public.order_number_seq') is not null
  union all select 'zk 20261124: device_commands', to_regclass('public.device_commands') is not null
  union all select 'zk 20261124: attendance_events', to_regclass('public.attendance_events') is not null
  union all select 'hardening: pay_order', to_regprocedure('public.pay_order(uuid,text,numeric,text)') is not null
  union all select 'hardening: refund_order', to_regprocedure('public.refund_order(uuid,numeric,text)') is not null
  union all select 'hardening: one open shift index', exists (
    select 1 from pg_index i join pg_class c on c.oid = i.indrelid
    where c.relname = 'cash_shifts' and i.indisunique and i.indpred is not null
  )
  union all select 'fixes: _role_rank', to_regprocedure('public._role_rank(text)') is not null
  union all select 'fixes: _attendance_work_date', to_regprocedure('public._attendance_work_date()') is not null
  union all select 'fixes: _recalc_order revoked from anon', not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = '_recalc_order'
      and has_function_privilege('anon', p.oid, 'EXECUTE')
  )
  union all select 'backup: admin_restore_backup(jsonb)', to_regprocedure('public.admin_restore_backup(jsonb)') is not null
  union all select 'backup: granted to authenticated', exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'admin_restore_backup'
      and has_function_privilege('authenticated', p.oid, 'EXECUTE')
  )
  union all select 'guard_profile_update trigger', exists (
    select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where c.relname = 'profiles' and t.tgname = 'trg_profile_guard' and not t.tgisinternal
  )
  -- Optional trash feature (superadmin_delete.sql + trash.sql)
  union all select 'trash: deleted_rows table', to_regclass('public.deleted_rows') is not null
  union all select 'trash: owner_delete(text,uuid)', to_regprocedure('public.owner_delete(text,uuid)') is not null
  union all select 'trash: owner_restore(bigint)', to_regprocedure('public.owner_restore(bigint)') is not null
  union all select 'trash: owner_delete archives', exists (
    select 1 from pg_proc p where p.oid = to_regprocedure('public.owner_delete(text,uuid)')
      and pg_get_functiondef(p.oid) like '%deleted_rows%'
  )
)
select label, case when present then 'OK' else 'MISSING' end as status
from expected
order by present, label;
