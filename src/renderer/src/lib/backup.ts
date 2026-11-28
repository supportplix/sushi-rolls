import type { SupabaseClient } from '@supabase/supabase-js'
import { api } from './ipc'
import { humanError } from './errors'
import { t } from '@/i18n'

const REFERENCE_TABLES = [
  'categories',
  'products',
  'product_variants',
  'product_extras',
  'suppliers',
  'ingredients',
  'recipes',
  'recipe_items',
  'customers',
  'restaurant_tables',
  'expense_categories',
  'employees'
] as const

interface BackupFile {
  app: 'sushi-rolls'
  version: 1
  exported_at: string
  tables: Record<string, Record<string, unknown>[]>
  settings: { key: string; value: unknown }[]
}

// PostgREST caps a single response at max_rows (1000 here). A bare select('*')
// therefore produces a *successful* backup that is silently truncated, which is
// worse than an error. Page explicitly, with a deterministic order so no row is
// duplicated or skipped between pages.
const PAGE_SIZE = 500
const MAX_PAGES = 200

async function fetchAll(
  db: SupabaseClient,
  table: string,
  columns = '*'
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = []
  const orderColumn = table === 'settings' ? 'key' : 'id'
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE_SIZE
    const { data, error } = await db
      .from(table)
      .select(columns)
      .order(orderColumn, { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    if (error) throw error
    const batch = (data ?? []) as unknown as Record<string, unknown>[]
    rows.push(...batch)
    if (batch.length < PAGE_SIZE) return rows
  }
  throw new Error(`BACKUP_TOO_LARGE:${table}`)
}

export async function exportBackup(db: SupabaseClient, userId: string | null): Promise<boolean> {
  const tables: Record<string, Record<string, unknown>[]> = {}
  for (const table of REFERENCE_TABLES) {
    tables[table] = await fetchAll(db, table)
  }
  const settings = await fetchAll(db, 'settings', 'key, value')
  const payload: BackupFile = {
    app: 'sushi-rolls',
    version: 1,
    exported_at: new Date().toISOString(),
    tables,
    settings: settings as { key: string; value: unknown }[]
  }
  const json = JSON.stringify(payload)
  const b64 = btoa(unescape(encodeURIComponent(json)))
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const res = await api.file.save({
    dataBase64: b64,
    fileName: `sushi-rolls-backup-${stamp}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })
  if (res.ok && userId) {
    const { error: logError } = await db.from('backups').insert({
      name: `backup-${stamp}.json`,
      size_bytes: new TextEncoder().encode(json).length,
      created_by: userId,
      note: 'نسخة يدوية من التطبيق'
    })
    if (logError) throw logError
  }
  return res.ok
}

const TABLE_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TOP_LEVEL_KEYS = new Set(['app', 'version', 'exported_at', 'tables', 'settings'])

export interface RestoreSummary {
  ok?: boolean
  tables?: Record<string, number>
  rows_upserted?: number
  dangling_refs_nulled?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Strict client-side mirror of the admin_restore_backup RPC input contract. */
function validateBackup(value: unknown): BackupFile | null {
  if (!isRecord(value) || value.app !== 'sushi-rolls' || value.version !== 1 || !isRecord(value.tables)) return null
  if (Object.keys(value).some((key) => !TOP_LEVEL_KEYS.has(key))) return null
  if (value.exported_at !== undefined && typeof value.exported_at !== 'string') return null

  const tableKeys = Object.keys(value.tables)
  if (tableKeys.length !== REFERENCE_TABLES.length) return null
  for (const table of tableKeys) {
    if (!REFERENCE_TABLES.includes(table as (typeof REFERENCE_TABLES)[number])) return null
    const rows = value.tables[table]
    if (!Array.isArray(rows)) return null
    for (const row of rows) {
      // Reject prototype-polluting keys and rows without a valid UUID id.
      if (!isRecord(row) || typeof row.id !== 'string' || !UUID.test(row.id)) return null
      for (const key of Object.keys(row)) {
        if (!TABLE_KEY.test(key) || key === '__proto__' || key === 'constructor' || key === 'prototype') return null
      }
    }
  }

  if (!Array.isArray(value.settings)) return null
  for (const setting of value.settings) {
    if (!isRecord(setting) || typeof setting.key !== 'string' || !TABLE_KEY.test(setting.key) || !('value' in setting)) return null
  }
  return value as unknown as BackupFile
}

export async function importBackup(
  db: SupabaseClient
): Promise<{ ok: boolean; canceled?: boolean; error?: string; summary?: RestoreSummary }> {
  const picked = await api.file.open({ filters: [{ name: 'JSON', extensions: ['json'] }] })
  if (!picked.ok || !picked.dataBase64) return { ok: false, canceled: picked.canceled, error: picked.error }
  try {
    let parsed: unknown
    try {
      parsed = JSON.parse(decodeURIComponent(escape(atob(picked.dataBase64))))
    } catch {
      return { ok: false, error: t('settings.restoreBad') }
    }
    const payload = validateBackup(parsed)
    if (!payload) return { ok: false, error: t('settings.restoreBad') }

    // One atomic, permission-checked RPC. The database owns table ordering,
    // conflict targets and the transaction; the client never writes 12 tables
    // separately and can no longer leave a half-restored database behind.
    // Contract: public.admin_restore_backup(p_payload jsonb) returns jsonb.
    const { data, error } = await db.rpc('admin_restore_backup', { p_payload: payload })
    if (error) return { ok: false, error: humanError(error) }
    if (isRecord(data)) {
      if (data.ok === false || (typeof data.error === 'string' && data.error)) {
        return { ok: false, error: humanError(String(data.error ?? '')) }
      }
      return { ok: true, summary: data as unknown as RestoreSummary }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: humanError(err) }
  }
}
