import { useState } from 'react'
import { History, Loader2, Pencil, Phone, Plus, RefreshCw, Trash2, Truck } from 'lucide-react'
import { useDb, useAuth } from '@/lib/auth'
import { useAsync } from '@/lib/hooks'
import { humanError } from '@/lib/errors'
import { fmtDateTime, money, num, parseNum } from '@/lib/format'
import type { PurchaseOrder, Supplier } from '@/lib/types'
import { t } from '@/i18n'
import { colorOf, labelOf, PURCHASE_STATUS } from '@/lib/constants'
import { cn } from '@/lib/cn'
import {
  Badge,
  Button,
  Field,
  PageHeader,
  PageLoader,
  RowMenu,
  SectionCard,
  TableWrap
} from '@/components/ui/primitives'
import { Dialog, ConfirmDialog } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/toast'

interface SupplierForm {
  id?: string
  name: string
  phone: string
  contact_person: string
  address: string
  notes: string
}

const emptyForm: SupplierForm = { name: '', phone: '', contact_person: '', address: '', notes: '' }

export default function SuppliersPage(): JSX.Element {
  const db = useDb()
  const { can } = useAuth()
  const toast = useToast()
  const manage = can('suppliers.manage')
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<SupplierForm>(emptyForm)
  const [saving, setSaving] = useState(false)
  const [historyFor, setHistoryFor] = useState<Supplier | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Supplier | null>(null)

  const list = useAsync(async () => {
    const { data, error } = await db
      .from('suppliers')
      .select('*, purchase_orders(count)')
      .order('name')
    if (error) throw error
    return (data ?? []) as unknown as (Supplier & { purchase_orders: { count: number }[] })[]
  }, [db])

  const history = useAsync(async () => {
    if (!historyFor) return [] as PurchaseOrder[]
    const { data, error } = await db
      .from('purchase_orders')
      .select('*, purchase_order_items(count)')
      .eq('supplier_id', historyFor.id)
      .order('created_at', { ascending: false })
    if (error) throw error
    return (data ?? []) as PurchaseOrder[]
  }, [db, historyFor?.id])

  const save = async (): Promise<void> => {
    if (!form.name.trim()) return
    setSaving(true)
    try {
      const payload = {
        name: form.name.trim(),
        phone: form.phone.trim() || null,
        contact_person: form.contact_person.trim() || null,
        address: form.address.trim() || null,
        notes: form.notes.trim() || null
      }
      if (form.id) {
        const { error } = await db.from('suppliers').update(payload).eq('id', form.id)
        if (error) throw error
      } else {
        const { error } = await db.from('suppliers').insert(payload)
        if (error) throw error
      }
      toast.success(t('suppliers.added'))
      setOpen(false)
      void list.reload()
    } catch (err) {
      toast.error(humanError(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <PageHeader
        title={t('suppliers.title')}
        actions={
          <>
            {manage && (
              <Button
                size="sm"
                icon={<Plus className="h-4 w-4" />}
                onClick={() => {
                  setForm(emptyForm)
                  setOpen(true)
                }}
              >
                {t('suppliers.add')}
              </Button>
            )}
            <button
              type="button"
              onClick={() => void list.reload()}
              aria-label={t('common.refresh')}
              className="grid h-9 w-9 place-items-center rounded-lg border border-line bg-ink-800 text-txt-dim hover:text-txt"
            >
              <RefreshCw className={cn('h-4 w-4', list.loading && 'animate-spin')} />
            </button>
          </>
        }
      />

      <SectionCard bodyClassName="p-0">
        {list.loading && !list.data ? (
          <PageLoader />
        ) : (
          <TableWrap>
            <thead>
              <tr>
                <th>{t('common.name')}</th>
                <th>{t('common.phone')}</th>
                <th>{t('suppliers.contact')}</th>
                <th>{t('suppliers.totalPurchases')}</th>
                <th>{t('suppliers.balance')}</th>
                <th className="w-10"></th>
              </tr>
            </thead>
            <tbody>
              {(list.data ?? []).map((s) => (
                <tr key={s.id}>
                  <td>
                    <div className="flex items-center gap-2">
                      <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand-gold/10 text-brand-gold">
                        <Truck className="h-4 w-4" />
                      </span>
                      <div>
                        <div className="font-semibold">{s.name}</div>
                        {s.notes && <div className="text-[10px] text-txt-faint">{s.notes}</div>}
                      </div>
                    </div>
                  </td>
                  <td className="text-xs text-txt-dim" dir="ltr">
                    {s.phone ?? '—'}
                  </td>
                  <td className="text-xs text-txt-dim">{s.contact_person ?? '—'}</td>
                  <td className="text-xs">{num(s.purchase_orders?.[0]?.count ?? 0, 0)}</td>
                  <td className={cn('font-bold', Number(s.balance) > 0 ? 'text-brand-redSoft' : 'text-emerald-400')}>
                    {money(s.balance)}
                  </td>
                  <td>
                    <RowMenu
                      items={[
                        {
                          label: t('suppliers.history'),
                          icon: <History className="h-3.5 w-3.5" />,
                          onClick: () => setHistoryFor(s)
                        },
                        ...(manage
                          ? [
                              {
                                label: t('common.edit'),
                                icon: <Pencil className="h-3.5 w-3.5" />,
                                onClick: () => {
                                  setForm({
                                    id: s.id,
                                    name: s.name,
                                    phone: s.phone ?? '',
                                    contact_person: s.contact_person ?? '',
                                    address: s.address ?? '',
                                    notes: s.notes ?? ''
                                  })
                                  setOpen(true)
                                }
                              },
                              {
                                label: t('common.delete'),
                                icon: <Trash2 className="h-3.5 w-3.5" />,
                                danger: true,
                                onClick: () => setDeleteTarget(s)
                              }
                            ]
                          : [])
                      ]}
                    />
                  </td>
                </tr>
              ))}
              {(list.data ?? []).length === 0 && (
                <tr>
                  <td colSpan={6} className="py-10 text-center text-xs text-txt-faint">
                    لا يوجد موردين — أضف أول مورد
                  </td>
                </tr>
              )}
            </tbody>
          </TableWrap>
        )}
      </SectionCard>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={form.id ? t('common.edit') : t('suppliers.add')}
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : t('common.save')}
            </Button>
          </>
        }
      >
        <div className="grid gap-3 md:grid-cols-2">
          <Field label={t('common.name')}>
            <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />
          </Field>
          <Field label={t('common.phone')}>
            <input className="input" dir="ltr" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </Field>
          <Field label={t('suppliers.contact')}>
            <input className="input" value={form.contact_person} onChange={(e) => setForm({ ...form, contact_person: e.target.value })} />
          </Field>
          <Field label={t('common.address')}>
            <input className="input" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
          </Field>
          <Field label={t('common.notes')} className="md:col-span-2">
            <input className="input" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </Field>
        </div>
      </Dialog>

      <Dialog
        open={!!historyFor}
        onClose={() => setHistoryFor(null)}
        title={`${t('suppliers.history')} · ${historyFor?.name ?? ''}`}
        size="lg"
      >
        {history.loading ? (
          <PageLoader />
        ) : (
          <TableWrap>
            <thead>
              <tr>
                <th>{t('purchases.number')}</th>
                <th>{t('common.date')}</th>
                <th>{t('common.status')}</th>
                <th>{t('common.total')}</th>
                <th>{t('purchases.paid')}</th>
                <th>{t('purchases.remaining')}</th>
              </tr>
            </thead>
            <tbody>
              {(history.data ?? []).map((po) => (
                <tr key={po.id}>
                  <td className="font-black text-brand-gold">#{po.number}</td>
                  <td className="text-[11px] text-txt-faint">{fmtDateTime(po.created_at)}</td>
                  <td>
                    <Badge color={colorOf(PURCHASE_STATUS, po.status)}>{labelOf(PURCHASE_STATUS, po.status, 'ar')}</Badge>
                  </td>
                  <td className="font-bold">{money(po.total)}</td>
                  <td className="text-xs">{money(po.paid)}</td>
                  <td className="text-xs">{money(Number(po.total) - Number(po.paid))}</td>
                </tr>
              ))}
              {(history.data ?? []).length === 0 && (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-xs text-txt-faint">
                    {t('purchases.noOrders')}
                  </td>
                </tr>
              )}
            </tbody>
          </TableWrap>
        )}
      </Dialog>

      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title={t('common.delete')}
        message={t('suppliers.deleteConfirm')}
        confirmLabel={t('common.delete')}
        onConfirm={async () => {
          if (!deleteTarget) return
          try {
            const { error } = await db.from('suppliers').delete().eq('id', deleteTarget.id)
            if (error) throw error
            toast.success(t('common.deleted'))
            setDeleteTarget(null)
            void list.reload()
          } catch (err) {
            toast.error(humanError(err))
          }
        }}
      />
    </div>
  )
}
