import { useState } from 'react'
import { History, Loader2, Pencil, Phone, Plus, RefreshCw, Trash2, UserPlus, UsersRound } from 'lucide-react'
import { useDb, useAuth } from '@/lib/auth'
import { useAsync } from '@/lib/hooks'
import { humanError } from '@/lib/errors'
import { fmtDateTime, money, num, parseNum } from '@/lib/format'
import type { Customer, Order } from '@/lib/types'
import { t } from '@/i18n'
import { colorOf, labelOf, ORDER_STATUS, ORDER_TYPES, PAYMENT_STATUS } from '@/lib/constants'
import { cn } from '@/lib/cn'
import {
  Badge,
  Button,
  EmptyState,
  Field,
  PageHeader,
  PageLoader,
  RowMenu,
  SearchInput,
  SectionCard,
  TableWrap
} from '@/components/ui/primitives'
import { Dialog, ConfirmDialog } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/toast'

interface CustomerForm {
  id?: string
  name: string
  phone: string
  address: string
  notes: string
}

const emptyForm: CustomerForm = { name: '', phone: '', address: '', notes: '' }

export default function CustomersPage(): JSX.Element {
  const db = useDb()
  const { can } = useAuth()
  const toast = useToast()
  const manage = can('customers.manage')
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<CustomerForm>(emptyForm)
  const [saving, setSaving] = useState(false)
  const [historyFor, setHistoryFor] = useState<Customer | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Customer | null>(null)

  const list = useAsync(async () => {
    let q = db.from('customers').select('*').order('total_spending', { ascending: false }).limit(500)
    const term = search.trim().replace(/[%,()]/g, '')
    if (term) q = q.or(`name.ilike.%${term}%,phone.ilike.%${term}%`)
    const { data, error } = await q
    if (error) throw error
    return (data ?? []) as Customer[]
  }, [db, search])

  const history = useAsync(async () => {
    if (!historyFor) return [] as Order[]
    const { data, error } = await db
      .from('orders')
      .select('*')
      .eq('customer_id', historyFor.id)
      .order('created_at', { ascending: false })
      .limit(50)
    if (error) throw error
    return (data ?? []) as Order[]
  }, [db, historyFor?.id])

  const save = async (): Promise<void> => {
    if (!form.name.trim()) return
    setSaving(true)
    try {
      const payload = {
        name: form.name.trim(),
        phone: form.phone.trim() || null,
        address: form.address.trim() || null,
        notes: form.notes.trim() || null
      }
      if (form.id) {
        const { error } = await db.from('customers').update(payload).eq('id', form.id)
        if (error) throw error
      } else {
        const { error } = await db.from('customers').insert(payload)
        if (error) throw error
      }
      toast.success(t('customers.added'))
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
        title={t('customers.title')}
        actions={
          <>
            {manage && (
              <Button
                size="sm"
                icon={<UserPlus className="h-4 w-4" />}
                onClick={() => {
                  setForm(emptyForm)
                  setOpen(true)
                }}
              >
                {t('customers.add')}
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
        <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          <SearchInput value={search} onChange={setSearch} placeholder={t('customers.search')} className="w-80 max-w-full" />
          <span className="text-[11px] text-txt-faint">{num(list.data?.length ?? 0, 0)} عميل</span>
        </div>
        {list.loading && !list.data ? (
          <PageLoader />
        ) : (list.data ?? []).length === 0 ? (
          <EmptyState title={t('customers.noCustomers')} icon={<UsersRound className="h-6 w-6" />} />
        ) : (
          <TableWrap>
            <thead>
              <tr>
                <th>{t('common.name')}</th>
                <th>{t('common.phone')}</th>
                <th>{t('customers.totalOrders')}</th>
                <th>{t('customers.spending')}</th>
                <th>{t('customers.lastOrder')}</th>
                <th className="w-10"></th>
              </tr>
            </thead>
            <tbody>
              {(list.data ?? []).map((c) => (
                <tr key={c.id}>
                  <td>
                    <div className="flex items-center gap-2.5">
                      <span className="grid h-8 w-8 place-items-center rounded-full bg-brand-gold/[0.12] text-[10px] font-black text-brand-gold">
                        {c.name.trim().slice(0, 2)}
                      </span>
                      <div>
                        <div className="flex items-center gap-2 font-semibold">
                          {c.name}
                          {Number(c.total_orders) >= 5 && <Badge color="#E4BE54">{t('customers.frequent')}</Badge>}
                        </div>
                        {c.address && <div className="max-w-[220px] truncate text-[10px] text-txt-faint">{c.address}</div>}
                      </div>
                    </div>
                  </td>
                  <td className="text-xs text-txt-dim" dir="ltr">{c.phone ?? '—'}</td>
                  <td className="text-xs">{num(c.total_orders, 0)}</td>
                  <td className="font-bold">{money(c.total_spending)}</td>
                  <td className="text-[11px] text-txt-faint">{c.last_order_at ? fmtDateTime(c.last_order_at) : '—'}</td>
                  <td>
                    <RowMenu
                      items={[
                        {
                          label: t('customers.history'),
                          icon: <History className="h-3.5 w-3.5" />,
                          onClick: () => setHistoryFor(c)
                        },
                        ...(manage
                          ? [
                              {
                                label: t('common.edit'),
                                icon: <Pencil className="h-3.5 w-3.5" />,
                                onClick: () => {
                                  setForm({
                                    id: c.id,
                                    name: c.name,
                                    phone: c.phone ?? '',
                                    address: c.address ?? '',
                                    notes: c.notes ?? ''
                                  })
                                  setOpen(true)
                                }
                              },
                              {
                                label: t('common.delete'),
                                icon: <Trash2 className="h-3.5 w-3.5" />,
                                danger: true,
                                onClick: () => setDeleteTarget(c)
                              }
                            ]
                          : [])
                      ]}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </SectionCard>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={form.id ? t('common.edit') : t('customers.add')}
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
          <Field label={t('common.address')} className="md:col-span-2">
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
        title={`${t('customers.history')} · ${historyFor?.name ?? ''}`}
        size="lg"
      >
        {history.loading ? (
          <PageLoader />
        ) : (
          <TableWrap>
            <thead>
              <tr>
                <th>#</th>
                <th>{t('common.type')}</th>
                <th>{t('common.total')}</th>
                <th>{t('common.status')}</th>
                <th>{t('common.date')}</th>
              </tr>
            </thead>
            <tbody>
              {(history.data ?? []).map((o) => (
                <tr key={o.id}>
                  <td className="font-black text-brand-gold">#{o.order_number}</td>
                  <td className="text-xs text-txt-dim">{labelOf(ORDER_TYPES, o.order_type, 'ar')}</td>
                  <td className="font-bold">{money(o.total)}</td>
                  <td>
                    <Badge color={colorOf(ORDER_STATUS, o.status)}>{labelOf(ORDER_STATUS, o.status, 'ar')}</Badge>
                  </td>
                  <td className="text-[11px] text-txt-faint">{fmtDateTime(o.created_at)}</td>
                </tr>
              ))}
              {(history.data ?? []).length === 0 && (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-xs text-txt-faint">
                    {t('common.empty')}
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
        message={`${t('common.delete')}: ${deleteTarget?.name ?? ''}?`}
        confirmLabel={t('common.delete')}
        onConfirm={async () => {
          if (!deleteTarget) return
          try {
            const { error } = await db.from('customers').delete().eq('id', deleteTarget.id)
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
