import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const fileOpen = vi.hoisted(() => vi.fn())
const fileSave = vi.hoisted(() => vi.fn())

vi.mock('@/lib/ipc', () => ({ api: { file: { open: fileOpen, save: fileSave } } }))

import { exportBackup, importBackup } from '../src/renderer/src/lib/backup'

const UUID = '11111111-1111-4111-8111-111111111111'
const TABLES = [
  'categories', 'products', 'product_variants', 'product_extras', 'suppliers', 'ingredients',
  'recipes', 'recipe_items', 'customers', 'restaurant_tables', 'expense_categories', 'employees'
]
const emptyTables = (): Record<string, unknown[]> => Object.fromEntries(TABLES.map((name) => [name, []]))
const validPayload = {
  app: 'sushi-rolls',
  version: 1,
  exported_at: '2026-01-01T00:00:00.000Z',
  tables: { ...emptyTables(), categories: [{ id: UUID, name_ar: 'مشروبات' }] },
  settings: [{ key: 'tax', value: { enabled: true } }]
}
const fileFor = (value: unknown): { ok: true; dataBase64: string } => ({
  ok: true,
  dataBase64: Buffer.from(JSON.stringify(value), 'utf8').toString('base64')
})

describe('importBackup', () => {
  const rpc = vi.fn()

  beforeEach(() => {
    rpc.mockReset()
    fileOpen.mockReset()
    fileOpen.mockResolvedValue(fileFor(validPayload))
  })

  it('validates the file and delegates the whole restore to one RPC', async () => {
    const summary = { ok: true, tables: { categories: 1 }, rows_upserted: 1, dangling_refs_nulled: 0 }
    rpc.mockResolvedValue({ data: summary, error: null })
    const db = { rpc } as unknown as SupabaseClient

    await expect(importBackup(db)).resolves.toEqual({ ok: true, summary })
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('admin_restore_backup', { p_payload: validPayload })
  })

  it('rejects a file with missing, extra or unknown tables without calling the RPC', async () => {
    const db = { rpc } as unknown as SupabaseClient
    fileOpen.mockResolvedValue(fileFor({ ...validPayload, tables: { categories: [{ id: UUID }] } }))
    await expect(importBackup(db)).resolves.toMatchObject({ ok: false })
    expect(rpc).not.toHaveBeenCalled()

    fileOpen.mockResolvedValue(fileFor({ ...validPayload, tables: { ...validPayload.tables, secrets: [] } }))
    await expect(importBackup(db)).resolves.toMatchObject({ ok: false })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('rejects malformed rows, unknown top-level fields and missing settings', async () => {
    const db = { rpc } as unknown as SupabaseClient
    fileOpen.mockResolvedValue(fileFor({ ...validPayload, tables: { ...validPayload.tables, products: [{ name_ar: 'x' }] } }))
    await expect(importBackup(db)).resolves.toMatchObject({ ok: false })
    expect(rpc).not.toHaveBeenCalled()

    fileOpen.mockResolvedValue(fileFor({ ...validPayload, injected: true }))
    await expect(importBackup(db)).resolves.toMatchObject({ ok: false })
    expect(rpc).not.toHaveBeenCalled()

    const { settings: _settings, ...withoutSettings } = validPayload
    fileOpen.mockResolvedValue(fileFor(withoutSettings))
    await expect(importBackup(db)).resolves.toMatchObject({ ok: false })
    expect(rpc).not.toHaveBeenCalled()

    fileOpen.mockResolvedValue(
      fileFor({ ...validPayload, tables: { ...validPayload.tables, products: [{ id: UUID, ['__proto__']: { polluted: true } }] } })
    )
    await expect(importBackup(db)).resolves.toMatchObject({ ok: false })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('surfaces translated permission and missing-RPC errors', async () => {
    const db = { rpc } as unknown as SupabaseClient
    rpc.mockResolvedValue({ data: null, error: { message: 'PERMISSION_DENIED' } })
    await expect(importBackup(db)).resolves.toMatchObject({ ok: false, error: 'ليست لديك صلاحية لهذه العملية' })

    rpc.mockResolvedValue({ data: null, error: { message: 'PGRST202: Could not find the function' } })
    await expect(importBackup(db)).resolves.toMatchObject({ ok: false, error: 'وظيفة الاستعادة غير منشورة على قاعدة البيانات' })
  })

  it('surfaces an error returned inside the RPC payload', async () => {
    rpc.mockResolvedValue({ data: { ok: false, error: 'ORDER_NOT_PAYABLE' }, error: null })
    const db = { rpc } as unknown as SupabaseClient
    await expect(importBackup(db)).resolves.toMatchObject({ ok: false })
  })

  it('reports cancellation and malformed JSON without calling the RPC', async () => {
    const db = { rpc } as unknown as SupabaseClient
    fileOpen.mockResolvedValue({ ok: false, canceled: true })
    await expect(importBackup(db)).resolves.toEqual({ ok: false, canceled: true })
    expect(rpc).not.toHaveBeenCalled()

    fileOpen.mockResolvedValue({ ok: true, dataBase64: Buffer.from('{not json').toString('base64') })
    await expect(importBackup(db)).resolves.toMatchObject({ ok: false })
    expect(rpc).not.toHaveBeenCalled()
  })
})

describe('exportBackup', () => {
  it('pages past the PostgREST row cap and records UTF-8 byte size', async () => {
    const categories = Array.from({ length: 502 }, (_, i) => ({ id: `id-${i}`, name_ar: 'مشروبات' }))
    const inserted: Record<string, unknown>[] = []
    const db = {
      from(table: string) {
        return {
          select() { return this },
          order() { return this },
          async range(from: number, to: number) {
            const rows = table === 'categories' ? categories : table === 'settings' ? [{ key: 'tax', value: {} }] : []
            return { data: rows.slice(from, to + 1), error: null }
          },
          async insert(row: Record<string, unknown>) {
            inserted.push(row)
            return { error: null }
          }
        }
      }
    } as unknown as SupabaseClient

    fileSave.mockReset()
    fileSave.mockResolvedValue({ ok: true })
    await expect(exportBackup(db, 'user-1')).resolves.toBe(true)

    const savedJson = Buffer.from(fileSave.mock.calls[0][0].dataBase64 as string, 'base64').toString('utf8')
    expect(JSON.parse(savedJson).tables.categories).toHaveLength(502)
    expect(inserted).toHaveLength(1)
    expect(inserted[0].size_bytes).toBe(new TextEncoder().encode(savedJson).length)
  })
})
