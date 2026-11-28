import type { SupabaseClient } from '@supabase/supabase-js'
import { humanError } from './errors'

/** Tables accepted by public.owner_delete(text, uuid). Keep in sync with supabase/trash.sql. */
export const OWNER_TABLES = [
  'user_permissions', 'suppliers', 'ingredients', 'categories', 'products',
  'product_variants', 'product_extras', 'recipes', 'recipe_items', 'stock_movements',
  'purchase_orders', 'purchase_order_items', 'customers', 'restaurant_tables',
  'expense_categories', 'expenses', 'cash_shifts', 'cash_transactions', 'orders',
  'order_items', 'order_item_extras', 'payments', 'refunds', 'employees', 'attendance',
  'backups', 'attendance_devices', 'employee_devices', 'attendance_events', 'device_commands'
] as const

export type OwnerTable = (typeof OWNER_TABLES)[number]

export interface OwnerRow {
  id: string
  [key: string]: unknown
}

export interface DeleteResult {
  ok: boolean
  error?: string
  archiveBatch?: number
}

export interface RestoreResult {
  ok: boolean
  error?: string
  rowsRestored?: number
}

export async function deleteOwnerRow(
  db: SupabaseClient,
  table: OwnerTable,
  id: string
): Promise<DeleteResult> {
  const { data, error } = await db.rpc('owner_delete', { p_table: table, p_id: id })
  if (error) return { ok: false, error: humanError(error) }
  const result = data as { ok?: boolean; archive_batch?: number } | null
  if (result?.ok === false) return { ok: false, error: humanError('PERMISSION_DENIED') }
  return { ok: true, archiveBatch: Number(result?.archive_batch ?? 0) }
}

export async function restoreOwnerBatch(db: SupabaseClient, batch: number): Promise<RestoreResult> {
  const { data, error } = await db.rpc('owner_restore', { p_batch: batch })
  if (error) return { ok: false, error: humanError(error) }
  const result = data as { ok?: boolean; rows_restored?: number } | null
  return { ok: result?.ok !== false, rowsRestored: Number(result?.rows_restored ?? 0) }
}

export async function fetchOwnerRows(db: SupabaseClient, table: OwnerTable, limit = 50): Promise<OwnerRow[]> {
  // Table name comes only from the whitelist above; never from user free text.
  const { data, error } = await db
    .from(table as 'products')
    .select('*')
    .order('id', { ascending: false })
    .limit(limit)
  if (error) throw error
  return (data ?? []) as unknown as OwnerRow[]
}

export interface DeletedBatch {
  batch: number
  tables: string[]
  deletedAt: string
  restored: boolean
}

export async function fetchDeletedBatches(db: SupabaseClient): Promise<DeletedBatch[]> {
  const { data, error } = await db
    .from('deleted_rows')
    .select('batch_id, table_name, deleted_at, restored_at')
    .order('deleted_at', { ascending: false })
    .limit(200)
  if (error) throw error
  const grouped = new Map<number, DeletedBatch>()
  for (const row of (data ?? []) as Array<{ batch_id: number; table_name: string; deleted_at: string; restored_at: string | null }>) {
    const existing = grouped.get(row.batch_id)
    if (existing) {
      if (!existing.tables.includes(row.table_name)) existing.tables.push(row.table_name)
      continue
    }
    grouped.set(row.batch_id, {
      batch: row.batch_id,
      tables: [row.table_name],
      deletedAt: row.deleted_at,
      restored: row.restored_at !== null
    })
  }
  return [...grouped.values()]
}
