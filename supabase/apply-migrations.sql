-- SUSHI ROLLS — authoritative database bootstrap / migration runner.
--
-- Run from the REPOSITORY ROOT (psql resolves \i relative to the current
-- working directory, not to this file):
--
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/apply-migrations.sql
--
-- Run this ONCE on a new database. It applies the schema baseline first and
-- then every migration in ascending filename order. Never re-run schema.sql
-- alone on an already-initialised database: the baseline versions of
-- pay_order / refund_order / transfer_table / guard_profile_update / the
-- permission helpers / manual attendance would silently overwrite the hardened
-- versions installed by the migrations (see DB-01 / DB-02 in AUDIT_REPORT.md).
--
-- Supabase Dashboard → SQL Editor does not support \i: in that case paste the
-- files below into the editor one at a time, in exactly this order.
--
-- After any future migration is added, append it here in filename order.

\i supabase/schema.sql

\i supabase/migrations/20261124090000_zkteco_attendance.sql
\i supabase/migrations/20261125003855_fix_zkteco_command_employee_delete.sql
\i supabase/migrations/20261126050000_admin_bypass.sql
\i supabase/migrations/20261126070000_zkteco_ingest_events.sql
\i supabase/migrations/20261126210000_zkteco_reserve_device_user.sql

-- PREFLIGHT (existing databases only): 20261127210000 creates a partial unique
-- index allowing one open shift per cashier. Detect pre-existing duplicates
-- BEFORE running it:
--   select user_id, count(*) from public.cash_shifts where status = 'open'
--   group by user_id having count(*) > 1;
-- If any rows are returned, an operator must reconcile/close the stale shifts
-- first. Automatically merging financial shifts is deliberately NOT done here.
\i supabase/migrations/20261127210000_audit_hardening.sql

\i supabase/migrations/20261128000000_db_p0_p1_fixes.sql
\i supabase/migrations/20261128000100_admin_restore_backup.sql
