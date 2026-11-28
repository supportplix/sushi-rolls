import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  deleteOwnerRow,
  fetchDeletedBatches,
  restoreOwnerBatch
} from '../src/renderer/src/lib/ownerData'

describe('owner data helpers', () => {
  it('deletes a row through the single RPC and returns the archive batch', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { ok: true, archive_batch: 42 }, error: null })
    const db = { rpc } as unknown as SupabaseClient
    await expect(deleteOwnerRow(db, 'orders', 'order-1')).resolves.toEqual({ ok: true, archiveBatch: 42 })
    expect(rpc).toHaveBeenCalledWith('owner_delete', { p_table: 'orders', p_id: 'order-1' })
  })

  it('surfaces RPC errors without claiming success', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'PERMISSION_DENIED' } })
    const db = { rpc } as unknown as SupabaseClient
    await expect(deleteOwnerRow(db, 'products', 'p-1')).resolves.toMatchObject({ ok: false })
  })

  it('restores a batch through owner_restore', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { ok: true, rows_restored: 5 }, error: null })
    const db = { rpc } as unknown as SupabaseClient
    await expect(restoreOwnerBatch(db, 42)).resolves.toEqual({ ok: true, rowsRestored: 5 })
    expect(rpc).toHaveBeenCalledWith('owner_restore', { p_batch: 42 })
  })

  it('groups archived rows into batches', async () => {
    const rows = [
      { batch_id: 2, table_name: 'order_items', deleted_at: 'b', restored_at: null },
      { batch_id: 1, table_name: 'orders', deleted_at: 'a', restored_at: 'a2' },
      { batch_id: 2, table_name: 'payments', deleted_at: 'b', restored_at: null }
    ]
    const db = {
      from: () => ({
        select: () => ({
          order: () => ({
            limit: async () => ({ data: rows, error: null })
          })
        })
      })
    } as unknown as SupabaseClient
    const batches = await fetchDeletedBatches(db)
    expect(batches).toHaveLength(2)
    expect(batches.find((b) => b.batch === 2)?.tables).toEqual(['order_items', 'payments'])
    expect(batches.find((b) => b.batch === 1)?.restored).toBe(true)
  })
})
