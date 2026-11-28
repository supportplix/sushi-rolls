import { useCallback, useEffect, useState } from 'react'
import { Loader2, RefreshCw, RotateCcw, Trash2 } from 'lucide-react'
import { useAuth, useDb } from '@/lib/auth'
import { humanError } from '@/lib/errors'
import { t } from '@/i18n'
import { Badge, Button, PageHeader, Select, TableWrap } from '@/components/ui/primitives'
import { ConfirmDialog } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/toast'
import {
  OWNER_TABLES,
  deleteOwnerRow,
  fetchDeletedBatches,
  fetchOwnerRows,
  restoreOwnerBatch,
  type DeletedBatch,
  type OwnerRow,
  type OwnerTable
} from '@/lib/ownerData'

function rowLabel(row: OwnerRow): string {
  for (const key of ['name_ar', 'name', 'full_name', 'username', 'number', 'title']) {
    const value = row[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return String(row.id ?? '').slice(0, 8)
}

export default function TrashPage(): JSX.Element {
  const db = useDb()
  const { profile } = useAuth()
  const toast = useToast()
  const isOwner = profile?.role === 'owner' || profile?.role === 'super_admin'

  const [table, setTable] = useState<OwnerTable>('products')
  const [rows, setRows] = useState<OwnerRow[]>([])
  const [batches, setBatches] = useState<DeletedBatch[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<OwnerRow | null>(null)
  const [restoreTarget, setRestoreTarget] = useState<DeletedBatch | null>(null)

  const load = useCallback(async (): Promise<void> => {
    if (!isOwner) return
    setLoading(true)
    try {
      const [nextRows, nextBatches] = await Promise.all([
        fetchOwnerRows(db, table),
        fetchDeletedBatches(db)
      ])
      setRows(nextRows)
      setBatches(nextBatches)
    } catch (err) {
      toast.error(humanError(err))
    } finally {
      setLoading(false)
    }
  }, [db, table, isOwner, toast])

  useEffect(() => {
    void load()
  }, [load])

  if (!isOwner) {
    return (
      <div className="grid h-64 place-items-center">
        <div className="card max-w-sm px-8 py-10 text-center text-sm font-bold">
          {t('common.noPermission')}
        </div>
      </div>
    )
  }

  const confirmDelete = async (): Promise<void> => {
    if (!deleteTarget || busy) return
    setBusy(true)
    try {
      const res = await deleteOwnerRow(db, table, String(deleteTarget.id))
      if (!res.ok) {
        toast.error(res.error ?? t('trash.failed'))
      } else {
        toast.success(t('trash.deleted'))
      }
      setDeleteTarget(null)
      await load()
    } finally {
      setBusy(false)
    }
  }

  const confirmRestore = async (): Promise<void> => {
    if (!restoreTarget || busy) return
    setBusy(true)
    try {
      const res = await restoreOwnerBatch(db, restoreTarget.batch)
      if (!res.ok) {
        toast.error(res.error ?? t('trash.failed'))
      } else {
        toast.success(t('trash.restored').replace('{n}', String(res.rowsRestored ?? 0)))
      }
      setRestoreTarget(null)
      await load()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader title={t('trash.title')} subtitle={t('trash.subtitle')} />

      <div className="card flex flex-wrap items-center gap-3 p-4">
        <div className="w-64">
          <Select
            value={table}
            onChange={(value) => setTable(value as OwnerTable)}
            options={OWNER_TABLES.map((name) => ({ value: name, ar: name }))}
          />
        </div>
        <Button variant="ghost" icon={<RefreshCw className="h-4 w-4" />} onClick={() => void load()} disabled={loading}>
          {t('common.refresh')}
        </Button>
        {loading && <Loader2 className="h-4 w-4 animate-spin text-txt-faint" />}
      </div>

      <TableWrap>
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-line-2 text-txt-faint">
              <th className="p-3 text-right">{t('trash.row')}</th>
              <th className="p-3 text-right">{t('trash.id')}</th>
              <th className="p-3 text-right">{t('trash.action')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={String(row.id)} className="border-b border-line-1/50">
                <td className="p-3 font-semibold">{rowLabel(row)}</td>
                <td className="direction-ltr p-3 text-left font-mono text-[10px] text-txt-faint">{String(row.id)}</td>
                <td className="p-3">
                  <Button
                    variant="danger"
                    size="sm"
                    icon={<Trash2 className="h-3.5 w-3.5" />}
                    onClick={() => setDeleteTarget(row)}
                  >
                    {t('common.delete')}
                  </Button>
                </td>
              </tr>
            ))}
            {!rows.length && !loading && (
              <tr><td colSpan={3} className="p-6 text-center text-txt-faint">{t('trash.empty')}</td></tr>
            )}
          </tbody>
        </table>
      </TableWrap>

      <div className="card p-4">
        <h2 className="mb-3 text-sm font-bold">{t('trash.archive')}</h2>
        <div className="space-y-2">
          {batches.map((batch) => (
            <div key={batch.batch} className="flex items-center justify-between rounded-xl border border-line-1 bg-white/[0.02] px-3 py-2">
              <div className="min-w-0">
                <div className="text-[11px] font-semibold">#{batch.batch} — {batch.tables.join(', ')}</div>
                <div className="direction-ltr text-left text-[10px] text-txt-faint">{batch.deletedAt}</div>
              </div>
              <div className="flex items-center gap-2">
                <Badge color={batch.restored ? '#D4AF37' : '#E54F4F'}>{batch.restored ? t('trash.restoredBadge') : t('trash.pendingBadge')}</Badge>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<RotateCcw className="h-3.5 w-3.5" />}
                  disabled={batch.restored}
                  onClick={() => setRestoreTarget(batch)}
                >
                  {t('trash.restore')}
                </Button>
              </div>
            </div>
          ))}
          {!batches.length && <div className="text-[11px] text-txt-faint">{t('trash.noArchive')}</div>}
        </div>
      </div>

      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void confirmDelete()}
        title={t('trash.deleteTitle')}
        message={t('trash.deleteMessage').replace('{name}', deleteTarget ? rowLabel(deleteTarget) : '')}
        confirmLabel={t('common.delete')}
        loading={busy}
      />
      <ConfirmDialog
        open={!!restoreTarget}
        onClose={() => setRestoreTarget(null)}
        onConfirm={() => void confirmRestore()}
        title={t('trash.restoreTitle')}
        message={t('trash.restoreMessage')}
        confirmLabel={t('trash.restore')}
        danger={false}
        loading={busy}
      />
    </div>
  )
}
