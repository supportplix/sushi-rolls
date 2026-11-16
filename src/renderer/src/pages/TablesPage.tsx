import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowLeftRight,
  Coffee,
  Loader2,
  Pencil,
  Plus,
  ReceiptText,
  RefreshCw,
  Trash2,
  UserCheck
} from 'lucide-react'
import { useAuth, useDb } from '@/lib/auth'
import { useAsync, useRealtimeRefresh } from '@/lib/hooks'
import { humanError } from '@/lib/errors'
import { fmtTime, money, num } from '@/lib/format'
import type { Order, Profile, RTable } from '@/lib/types'
import { t } from '@/i18n'
import { colorOf, labelOf, ROLES, TABLE_STATUS } from '@/lib/constants'
import { cn } from '@/lib/cn'
import {
  Badge,
  Button,
  Field,
  PageHeader,
  PageLoader,
  RowMenu,
  Select,
  TableWrap
} from '@/components/ui/primitives'
import { Dialog, ConfirmDialog } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/toast'

export default function TablesPage(): JSX.Element {
  const db = useDb()
  const { can } = useAuth()
  const toast = useToast()
  const navigate = useNavigate()
  const [editOpen, setEditOpen] = useState(false)
  const [form, setForm] = useState<{ id?: string; number: string; capacity: string; zone: string }>({
    number: '',
    capacity: '4',
    zone: 'الصالة'
  })
  const [saving, setSaving] = useState(false)
  const [transferOpen, setTransferOpen] = useState(false)
  const [transferOrder, setTransferOrder] = useState<Order | null>(null)
  const [targetTable, setTargetTable] = useState('')
  const [waiterOpen, setWaiterOpen] = useState(false)
  const [waiterTable, setWaiterTable] = useState<RTable | null>(null)
  const [waiterId, setWaiterId] = useState('')
  const [statusChange, setStatusChange] = useState<{ table: RTable; status: string } | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<RTable | null>(null)

  const tables = useAsync(async () => {
    const { data, error } = await db.from('restaurant_tables').select('*').order('zone').order('number')
    if (error) throw error
    return (data ?? []) as RTable[]
  }, [db])

  const openOrders = useAsync(async () => {
    const { data, error } = await db
      .from('orders')
      .select('*, cashier:profiles!orders_cashier_id_fkey(full_name)')
      .in('status', ['draft', 'confirmed', 'sent_to_kitchen', 'preparing', 'ready'])
      .not('table_id', 'is', null)
    if (error) throw error
    return (data ?? []) as Order[]
  }, [db])

  const staff = useAsync(async () => {
    const { data } = await db
      .from('profiles')
      .select('*')
      .eq('is_active', true)
      .in('role', ['waiter', 'cashier', 'branch_manager', 'general_manager', 'super_admin', 'owner'])
      .order('full_name')
    return (data ?? []) as Profile[]
  }, [db])

  useRealtimeRefresh(['restaurant_tables', 'orders'], () => {
    void tables.reload()
    void openOrders.reload()
  })

  const ordersByTable = useMemo(() => {
    const map = new Map<string, Order>()
    for (const o of openOrders.data ?? []) {
      if (o.table_id) map.set(o.table_id, o)
    }
    return map
  }, [openOrders.data])

  const zones = useMemo(() => {
    const set = new Set((tables.data ?? []).map((tb) => tb.zone))
    return Array.from(set)
  }, [tables.data])

  const saveTable = async (): Promise<void> => {
    if (!form.number.trim()) return
    setSaving(true)
    try {
      const payload = {
        number: form.number.trim(),
        capacity: Math.max(1, Number(form.capacity) || 1),
        zone: form.zone.trim() || 'الصالة'
      }
      if (form.id) {
        const { error } = await db.from('restaurant_tables').update(payload).eq('id', form.id)
        if (error) throw error
      } else {
        const { error } = await db.from('restaurant_tables').insert(payload)
        if (error) throw error
      }
      toast.success(t('common.saved'))
      setEditOpen(false)
      void tables.reload()
    } catch (err) {
      toast.error(humanError(err))
    } finally {
      setSaving(false)
    }
  }

  const setStatus = async (table: RTable, status: string): Promise<void> => {
    try {
      const { error } = await db.from('restaurant_tables').update({ status }).eq('id', table.id)
      if (error) throw error
      void tables.reload()
    } catch (err) {
      toast.error(humanError(err))
    }
  }

  return (
    <div>
      <PageHeader
        title={t('tables.title')}
        actions={
          <>
            {can('tables.manage') && (
              <Button
                size="sm"
                icon={<Plus className="h-4 w-4" />}
                onClick={() => {
                  setForm({ number: '', capacity: '4', zone: 'الصالة' })
                  setEditOpen(true)
                }}
              >
                {t('tables.add')}
              </Button>
            )}
            <button
              type="button"
              onClick={() => void tables.reload()}
              aria-label={t('common.refresh')}
              className="grid h-9 w-9 place-items-center rounded-lg border border-line bg-ink-800 text-txt-dim hover:text-txt"
            >
              <RefreshCw className={cn('h-4 w-4', tables.loading && 'animate-spin')} />
            </button>
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        {TABLE_STATUS.map((s) => (
          <span key={s.value} className="flex items-center gap-1.5 text-[11px] font-semibold text-txt-dim">
            <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
            {s.ar}
          </span>
        ))}
        <span className="ms-auto text-[11px] text-txt-faint">
          {num(tables.data?.length ?? 0, 0)} ترابيزة
        </span>
      </div>

      {tables.loading && !tables.data ? (
        <PageLoader />
      ) : (
        <div className="space-y-6">
          {zones.map((zone) => (
            <section key={zone}>
              <h2 className="mb-2.5 text-xs font-black uppercase tracking-wider text-txt-faint">{zone}</h2>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                {(tables.data ?? [])
                  .filter((tb) => tb.zone === zone)
                  .map((tb) => {
                    const order = ordersByTable.get(tb.id)
                    const statusColor = colorOf(TABLE_STATUS, tb.status) ?? '#6B7176'
                    return (
                      <article
                        key={tb.id}
                        className="card relative flex flex-col overflow-hidden p-4"
                      >
                        <span
                          className="absolute inset-y-0 start-0 w-1"
                          style={{ background: statusColor }}
                        />
                        <div className="flex items-start justify-between">
                          <div>
                            <div className="text-lg font-black">{tb.number}</div>
                            <div className="text-[10.5px] text-txt-faint">
                              {tb.capacity} {t('tables.capacityShort')} · {tb.zone}
                            </div>
                          </div>
                          <Badge color={statusColor}>{labelOf(TABLE_STATUS, tb.status, 'ar')}</Badge>
                        </div>

                        {order ? (
                          <div className="mt-3 rounded-xl border border-white/[0.05] bg-white/[0.03] p-2.5 text-[11px]">
                            <div className="flex items-center justify-between">
                              <span className="font-black text-brand-gold">#{order.order_number}</span>
                              <span className="font-bold">{money(order.total)}</span>
                            </div>
                            <div className="mt-0.5 text-[10px] text-txt-faint">
                              {fmtTime(order.created_at)} · {order.cashier?.full_name ?? '—'}
                            </div>
                          </div>
                        ) : tb.status !== 'available' ? (
                          <div className="mt-3 grid h-[52px] place-items-center rounded-xl border border-white/[0.04] bg-white/[0.02] text-[10.5px] text-txt-faint">
                            {labelOf(TABLE_STATUS, tb.status, 'ar')}
                          </div>
                        ) : null}

                        <div className="mt-auto flex items-center gap-1.5 pt-3">
                          {tb.status === 'available' && !order && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="flex-1"
                              icon={<Coffee className="h-3.5 w-3.5" />}
                              onClick={() => navigate(`/pos?table=${tb.id}`)}
                            >
                              {t('tables.openOrder')}
                            </Button>
                          )}
                          {order && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="flex-1"
                              icon={<ReceiptText className="h-3.5 w-3.5" />}
                              onClick={() => navigate(`/orders?open=${order.id}`)}
                            >
                              {t('orders.details')}
                            </Button>
                          )}
                          <RowMenu
                            items={[
                              ...(order
                                ? [
                                    {
                                      label: t('tables.transfer'),
                                      icon: <ArrowLeftRight className="h-3.5 w-3.5" />,
                                      onClick: () => {
                                        setTransferOrder(order)
                                        setTargetTable('')
                                        setTransferOpen(true)
                                      }
                                    }
                                  ]
                                : []),
                              {
                                label: t('tables.assignWaiter'),
                                icon: <UserCheck className="h-3.5 w-3.5" />,
                                onClick: () => {
                                  setWaiterTable(tb)
                                  setWaiterId(tb.waiter_id ?? '')
                                  setWaiterOpen(true)
                                }
                              },
                              ...TABLE_STATUS.filter((s) => s.value !== tb.status && s.value !== 'occupied').map((s) => ({
                                label: s.ar,
                                onClick: () => setStatusChange({ table: tb, status: s.value })
                              })),
                              {
                                label: t('common.edit'),
                                icon: <Pencil className="h-3.5 w-3.5" />,
                                onClick: () => {
                                  setForm({ id: tb.id, number: tb.number, capacity: String(tb.capacity), zone: tb.zone })
                                  setEditOpen(true)
                                }
                              },
                              {
                                label: t('common.delete'),
                                icon: <Trash2 className="h-3.5 w-3.5" />,
                                danger: true,
                                onClick: () => setDeleteTarget(tb)
                              }
                            ]}
                          />
                        </div>
                      </article>
                    )
                  })}
              </div>
            </section>
          ))}
        </div>
      )}

      <Dialog
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title={form.id ? t('common.edit') : t('tables.add')}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditOpen(false)}>{t('common.cancel')}</Button>
            <Button onClick={() => void saveTable()} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : t('common.save')}
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('tables.number')}>
            <input className="input" value={form.number} onChange={(e) => setForm({ ...form, number: e.target.value })} autoFocus />
          </Field>
          <Field label={t('tables.capacity')}>
            <input className="input" inputMode="numeric" value={form.capacity} onChange={(e) => setForm({ ...form, capacity: e.target.value })} />
          </Field>
          <Field label={t('tables.zone')} className="col-span-2">
            <input className="input" value={form.zone} onChange={(e) => setForm({ ...form, zone: e.target.value })} />
          </Field>
        </div>
      </Dialog>

      <Dialog
        open={transferOpen}
        onClose={() => setTransferOpen(false)}
        title={t('tables.transfer')}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setTransferOpen(false)}>{t('common.cancel')}</Button>
            <Button
              disabled={!targetTable}
              onClick={async () => {
                if (!transferOrder) return
                try {
                  const { error } = await db.rpc('transfer_table', {
                    p_order: transferOrder.id,
                    p_table_id: targetTable
                  })
                  if (error) throw error
                  toast.success(t('tables.transferred'))
                  setTransferOpen(false)
                  void tables.reload()
                  void openOrders.reload()
                } catch (err) {
                  toast.error(humanError(err))
                }
              }}
            >
              {t('common.confirm')}
            </Button>
          </>
        }
      >
        <Field label={t('tables.transferTo')}>
          <Select
            value={targetTable}
            onChange={setTargetTable}
            options={(tables.data ?? [])
              .filter((tb) => tb.id !== transferOrder?.table_id)
              .map((tb) => ({ value: tb.id, ar: `${tb.number} · ${tb.zone} (${labelOf(TABLE_STATUS, tb.status, 'ar')})` }))}
          />
        </Field>
      </Dialog>

      <Dialog
        open={waiterOpen}
        onClose={() => setWaiterOpen(false)}
        title={t('tables.assignWaiter')}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setWaiterOpen(false)}>{t('common.cancel')}</Button>
            <Button
              onClick={async () => {
                if (!waiterTable) return
                try {
                  const { error } = await db
                    .from('restaurant_tables')
                    .update({ waiter_id: waiterId || null })
                    .eq('id', waiterTable.id)
                  if (error) throw error
                  toast.success(t('common.saved'))
                  setWaiterOpen(false)
                  void tables.reload()
                } catch (err) {
                  toast.error(humanError(err))
                }
              }}
            >
              {t('common.save')}
            </Button>
          </>
        }
      >
        <Field label={t('tables.assignWaiter')}>
          <Select
            value={waiterId}
            onChange={setWaiterId}
            options={(staff.data ?? []).map((p) => ({ value: p.id, ar: `${p.full_name} (${labelOf(ROLES, p.role, 'ar')})` }))}
            placeholder={t('common.none')}
          />
        </Field>
      </Dialog>

      <ConfirmDialog
        open={!!statusChange}
        onClose={() => setStatusChange(null)}
        title={t('tables.status')}
        message={t('tables.statusConfirm', {
          table: statusChange?.table.number ?? '',
          status: labelOf(TABLE_STATUS, statusChange?.status, 'ar')
        })}
        confirmLabel={t('common.confirm')}
        danger={false}
        onConfirm={async () => {
          if (!statusChange) return
          await setStatus(statusChange.table, statusChange.status)
          setStatusChange(null)
        }}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title={t('common.delete')}
        message={t('tables.deleteConfirm', { table: deleteTarget?.number ?? '' })}
        confirmLabel={t('common.delete')}
        onConfirm={async () => {
          if (!deleteTarget) return
          try {
            const { error } = await db.from('restaurant_tables').delete().eq('id', deleteTarget.id)
            if (error) throw error
            toast.success(t('common.deleted'))
            setDeleteTarget(null)
            void tables.reload()
          } catch (err) {
            toast.error(humanError(err))
          }
        }}
      />
    </div>
  )
}
