import type { SupabaseClient } from '@supabase/supabase-js'
import { api } from './ipc'
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

export async function exportBackup(db: SupabaseClient, userId: string | null): Promise<boolean> {
  const tables: Record<string, Record<string, unknown>[]> = {}
  for (const table of REFERENCE_TABLES) {
    const { data, error } = await db.from(table).select('*')
    if (error) throw error
    tables[table] = (data ?? []) as Record<string, unknown>[]
  }
  const { data: settings } = await db.from('settings').select('key, value')
  const payload: BackupFile = {
    app: 'sushi-rolls',
    version: 1,
    exported_at: new Date().toISOString(),
    tables,
    settings: (settings ?? []) as { key: string; value: unknown }[]
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
    await db.from('backups').insert({
      name: `backup-${stamp}.json`,
      size_bytes: json.length,
      created_by: userId,
      note: 'نسخة يدوية من التطبيق'
    })
  }
  return res.ok
}

export async function importBackup(
  db: SupabaseClient
): Promise<{ ok: boolean; canceled?: boolean; error?: string }> {
  const picked = await api.file.open({ filters: [{ name: 'JSON', extensions: ['json'] }] })
  if (!picked.ok || !picked.dataBase64) return { ok: false, canceled: picked.canceled, error: picked.error }
  try {
    const json = decodeURIComponent(escape(atob(picked.dataBase64)))
    const payload = JSON.parse(json) as BackupFile
    if (payload.app !== 'sushi-rolls' || payload.version !== 1 || !payload.tables) {
      return { ok: false, error: t('settings.restoreBad') }
    }
    for (const table of REFERENCE_TABLES) {
      const rows = payload.tables[table]
      if (!rows || rows.length === 0) continue
      const { error } = await db.from(table).upsert(rows as never[], { onConflict: 'id' })
      if (error) throw error
    }
    if (payload.settings?.length) {
      const { error } = await db
        .from('settings')
        .upsert(payload.settings.map((s) => ({ key: s.key, value: s.value })), { onConflict: 'key' })
      if (error) throw error
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message ?? err) }
  }
}
