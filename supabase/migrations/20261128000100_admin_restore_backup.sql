-- SUSHI ROLLS — atomic, permission-checked backup restore RPC (contract for
-- src/renderer/src/lib/backup.ts). Apply AFTER 20261127210000_audit_hardening.sql.
--
-- Payload (the BackupFile JSON written by exportBackup):
-- {
--   "app": "sushi-rolls", "version": 1, "exported_at": "<iso>"   (metadata,
--     optional here but validated when present),
--   "tables": {
--     "categories": [...], "products": [...], "product_variants": [...],
--     "product_extras": [...], "suppliers": [...], "ingredients": [...],
--     "recipes": [...], "recipe_items": [...], "customers": [...],
--     "restaurant_tables": [...], "expense_categories": [...],
--     "employees": [...]
--   },
--   "settings": [{ "key": "...", "value": <any jsonb> }]
-- }
--
-- Unknown tables and unknown columns are REJECTED (not silently ignored).
-- Rows are upserted by id (settings by key) inside one transaction, parents
-- before children. Dangling *optional* profile references (employees.profile_id,
-- restaurant_tables.waiter_id) are nulled and counted in the summary, because
-- profiles are never part of the backup and cannot be restored by this RPC.
-- Required references must resolve or the whole restore rolls back.

create or replace function public.admin_restore_backup(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_allowed_columns jsonb := jsonb_build_object(
    'settings',            '["key","value"]'::jsonb,
    'categories',          '["id","name_ar","name_en","sort_order","is_active","created_at"]'::jsonb,
    'products',            '["id","category_id","name_ar","name_en","description_ar","description_en","price","cost","sku","image_url","is_available","is_popular","is_archived","sort_order","created_at","updated_at"]'::jsonb,
    'product_variants',    '["id","product_id","name_ar","name_en","price_delta","is_default","sort_order"]'::jsonb,
    'product_extras',      '["id","name_ar","name_en","price","ingredient_id","ingredient_qty","is_active","sort_order"]'::jsonb,
    'suppliers',           '["id","name","phone","address","contact_person","notes","balance","created_at"]'::jsonb,
    'ingredients',         '["id","name_ar","name_en","sku","category","unit","quantity","min_stock","purchase_cost","supplier_id","expiry_date","storage_location","is_active","created_at","updated_at"]'::jsonb,
    'recipes',             '["id","product_id","notes"]'::jsonb,
    'recipe_items',        '["id","recipe_id","ingredient_id","quantity"]'::jsonb,
    'customers',           '["id","name","phone","address","notes","total_orders","total_spending","last_order_at","created_at"]'::jsonb,
    'restaurant_tables',   '["id","number","capacity","zone","status","waiter_id","pos_x","pos_y","created_at"]'::jsonb,
    'expense_categories',  '["id","name_ar","name_en","is_active"]'::jsonb,
    'employees',           '["id","profile_id","full_name","job_title","phone","salary","hire_date","is_active","created_at"]'::jsonb
  );
  -- Columns with a database default that are NOT NULL: fill them when an
  -- older/partial backup omits them. A missing required column without a safe
  -- default (e.g. name_ar) is left NULL and fails loudly at insert time.
  v_defaults jsonb := jsonb_build_object(
    'settings',           '{}'::jsonb,
    'categories',          jsonb_build_object('sort_order', 0, 'is_active', true, 'created_at', now()),
    'products',            jsonb_build_object('price', 0, 'cost', 0, 'is_available', true,
                             'is_popular', false, 'is_archived', false, 'sort_order', 0,
                             'created_at', now(), 'updated_at', now()),
    'product_variants',    jsonb_build_object('price_delta', 0, 'is_default', false, 'sort_order', 0),
    'product_extras',      jsonb_build_object('price', 0, 'ingredient_qty', 0, 'is_active', true, 'sort_order', 0),
    'suppliers',           jsonb_build_object('balance', 0, 'created_at', now()),
    'ingredients',         jsonb_build_object('unit', 'كجم', 'quantity', 0, 'min_stock', 0,
                             'purchase_cost', 0, 'is_active', true, 'created_at', now(), 'updated_at', now()),
    'recipes',             '{}'::jsonb,
    'recipe_items',        '{}'::jsonb,
    'customers',           jsonb_build_object('total_orders', 0, 'total_spending', 0, 'created_at', now()),
    'restaurant_tables',   jsonb_build_object('capacity', 4, 'zone', 'الصالة', 'status', 'available',
                             'pos_x', 0, 'pos_y', 0, 'created_at', now()),
    'expense_categories',  jsonb_build_object('is_active', true),
    'employees',           jsonb_build_object('salary', 0, 'is_active', true, 'created_at', now())
  );
  -- Parent-before-child order. settings uses its own conflict key ("key").
  v_order text[] := array[
    'settings','suppliers','categories','ingredients','products','product_variants',
    'product_extras','recipes','recipe_items','customers','restaurant_tables',
    'expense_categories','employees'
  ];
  v_uuid_regex text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_table text;
  v_conflict text;
  v_rows jsonb;
  v_row jsonb;
  v_merged jsonb;
  v_key text;
  v_cols text;
  v_select text;
  v_update text;
  v_sql text;
  v_count integer;
  v_total integer := 0;
  v_nulled integer := 0;
  v_summary jsonb := '{}'::jsonb;
begin
  perform public.assert_perm('backup.manage');

  if jsonb_typeof(p_payload) is distinct from 'object' then
    raise exception 'INVALID_BACKUP_PAYLOAD' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_payload) k
    where k not in ('app','version','exported_at','tables','settings')
  ) then
    raise exception 'INVALID_BACKUP_FIELDS' using errcode = '22023';
  end if;
  if p_payload ? 'app' and p_payload ->> 'app' <> 'sushi-rolls' then
    raise exception 'INVALID_BACKUP_APP' using errcode = '22023';
  end if;
  if p_payload ? 'version' and p_payload ->> 'version' <> '1' then
    raise exception 'INVALID_BACKUP_VERSION' using errcode = '22023';
  end if;
  if jsonb_typeof(p_payload -> 'tables') is distinct from 'object' then
    raise exception 'BACKUP_TABLES_REQUIRED' using errcode = '22023';
  end if;
  for v_key in select jsonb_object_keys(p_payload -> 'tables') loop
    -- settings is a top-level array, not a member of "tables".
    if not (v_allowed_columns ? v_key) or v_key = 'settings' then
      raise exception 'UNKNOWN_BACKUP_TABLE:%', v_key using errcode = '22023';
    end if;
  end loop;
  if p_payload ? 'settings' and jsonb_typeof(p_payload -> 'settings') is distinct from 'array' then
    raise exception 'INVALID_BACKUP_SETTINGS' using errcode = '22023';
  end if;

  foreach v_table in array v_order loop
    if v_table = 'settings' then
      v_rows := coalesce(p_payload -> 'settings', '[]'::jsonb);
      v_conflict := 'key';
    else
      v_rows := coalesce(p_payload -> 'tables' -> v_table, '[]'::jsonb);
      v_conflict := 'id';
    end if;
    if jsonb_typeof(v_rows) is distinct from 'array' then
      raise exception 'INVALID_BACKUP_ROWS:%', v_table using errcode = '22023';
    end if;

    v_count := 0;
    for v_row in select value from jsonb_array_elements(v_rows) loop
      if jsonb_typeof(v_row) is distinct from 'object' then
        raise exception 'INVALID_BACKUP_ROW:%', v_table using errcode = '22023';
      end if;

      for v_key in select jsonb_object_keys(v_row) loop
        if not ((v_allowed_columns -> v_table) ? v_key) then
          raise exception 'UNKNOWN_BACKUP_COLUMN:%.%', v_table, v_key using errcode = '22023';
        end if;
        if v_key ~ '(^id$|_id$)' and jsonb_typeof(v_row -> v_key) is distinct from 'null' then
          if jsonb_typeof(v_row -> v_key) <> 'string'
             or (v_row ->> v_key) !~ v_uuid_regex then
            raise exception 'INVALID_BACKUP_ID:%.%', v_table, v_key using errcode = '22023';
          end if;
        end if;
      end loop;

      if v_conflict = 'id' and (not (v_row ? 'id') or jsonb_typeof(v_row -> 'id') <> 'string') then
        raise exception 'MISSING_BACKUP_ID:%', v_table using errcode = '22023';
      end if;
      if v_table = 'settings' and (
        not (v_row ? 'key') or jsonb_typeof(v_row -> 'key') <> 'string'
        or btrim(v_row ->> 'key') = ''
      ) then
        raise exception 'INVALID_BACKUP_SETTING_KEY' using errcode = '22023';
      end if;
      if v_table = 'settings' and not (v_row ? 'value') then
        raise exception 'MISSING_BACKUP_SETTING_VALUE' using errcode = '22023';
      end if;

      v_merged := coalesce(v_defaults -> v_table, '{}'::jsonb) || v_row;

      -- profiles are never backed up; keep the row but drop an unresolvable
      -- optional link. Required FKs are left alone and fail loudly if missing.
      if v_table = 'employees' and v_merged ? 'profile_id'
         and jsonb_typeof(v_merged -> 'profile_id') <> 'null'
         and not exists (
           select 1 from public.profiles p where p.id = (v_merged ->> 'profile_id')::uuid
         ) then
        v_merged := jsonb_set(v_merged, '{profile_id}', 'null'::jsonb);
        v_nulled := v_nulled + 1;
      end if;
      if v_table = 'restaurant_tables' and v_merged ? 'waiter_id'
         and jsonb_typeof(v_merged -> 'waiter_id') <> 'null'
         and not exists (
           select 1 from public.profiles p where p.id = (v_merged ->> 'waiter_id')::uuid
         ) then
        v_merged := jsonb_set(v_merged, '{waiter_id}', 'null'::jsonb);
        v_nulled := v_nulled + 1;
      end if;

      -- Identifiers come only from the two hardcoded whitelists above, so
      -- format('%I') is safe here. jsonb_populate_record performs the JSON ->
      -- column-type coercion and rejects values that cannot be cast.
      select string_agg(format('%I', k), ', ' order by k)
        into v_cols from jsonb_object_keys(v_merged) k;
      select string_agg(format('(s.r).%I', k), ', ' order by k)
        into v_select from jsonb_object_keys(v_merged) k;
      select string_agg(format('%I = excluded.%I', k, k), ', ' order by k)
        into v_update from jsonb_object_keys(v_merged) k where k <> v_conflict;
      if v_update is null then
        raise exception 'EMPTY_BACKUP_ROW:%', v_table using errcode = '22023';
      end if;

      v_sql := format(
        'insert into public.%1$I (%2$s) select %3$s '
        || 'from (select jsonb_populate_record(null::public.%1$I, $1) as r) s '
        || 'on conflict (%4$I) do update set %5$s',
        v_table, v_cols, v_select, v_conflict, v_update
      );
      execute v_sql using v_merged;
      v_count := v_count + 1;
    end loop;

    v_summary := v_summary || jsonb_build_object(v_table, v_count);
    v_total := v_total + v_count;
  end loop;

  insert into public.audit_logs (user_id, action, entity, entity_id, details)
  values (
    auth.uid(), 'backup.restore', 'backups', null,
    v_summary || jsonb_build_object('rows_upserted', v_total, 'dangling_refs_nulled', v_nulled)
  );

  return jsonb_build_object(
    'ok', true, 'tables', v_summary,
    'rows_upserted', v_total, 'dangling_refs_nulled', v_nulled
  );
end;
$$;

comment on function public.admin_restore_backup(jsonb) is
  'backup.manage only: atomically upserts the 12 reference tables + settings from a v1 sushi-rolls backup; unknown tables/columns are rejected.';

revoke all on function public.admin_restore_backup(jsonb) from public, anon;
grant execute on function public.admin_restore_backup(jsonb) to authenticated;
