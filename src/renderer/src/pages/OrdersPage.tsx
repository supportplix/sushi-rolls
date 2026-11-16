import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  Ban,
  CheckCircle2,
  ChefHat,
  CircleDollarSign,
  FileText,
  Loader2,
  Printer,
  RefreshCw,
  Scissors,
  Send,
  ShieldCheck
} from 'lucide-react'
import { useAuth, useDb } from '@/lib/auth'
import { useAsync, useDebounced, useRealtimeRefresh } from '@/lib/hooks'
import { humanError } from '@/lib/errors'
import { fmtDateTime, money, num, parseNum, rangeFor, type Period } from '@/lib/format'
import type { Order, OrderItem, Payment } from '@/lib/types'
import { t } from '@/i18n'
import {
  colorOf,
  labelOf,
  ORDER_STATUS,
  ORDER_TYPES,
  PAYMENT_METHODS,
  PAYMENT_STATUS
} from '@/lib/constants'
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
  Select,
  TableWrap,
  Tabs
} from '@/components/ui/primitives'
import { Dialog, ConfirmDialog } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/toast'
import { fetchOrderFull, ORDER_LIST_SELECT, type OrderFull } from '@/lib/orders'
import { printA4Invoice, printKitchenTicket, printThermalReceipt } from '@/lib/receipt'

type PeriodFilter = Period | 'all'

const NEXT_STATUS: Record<string, { status: string; label: string } | null> = {
  draft: { status: 'sent_to_kitchen', label: t('orders.kitchen') },
  confirmed: { status: 'sent_to_kitchen', label: t('orders.kitchen') },
  sent_to_kitchen: { status: 'preparing', label: 'بدء التحضير' },
  preparing: { status: 'ready', label: 'جاهز' },
  ready: { status: 'completed', label: t('orders.complete') },
  completed: null,
  cancelled: null
}

export default function OrdersPage(): JSX.Element {
  const db = useDb()
  const { settings, can } = useAuth()
  const toast = useToast()
  const [statusFilter, setStatusFilter] = useState('all')
  const [typeFilter, setTypeFilter] = useState('all')
  const [period, setPeriod] = useState<PeriodFilter>('today')
  const [search, setSearch] = useState('')
  const debounced = useDebounced(search, 350)
  const [limit, setLimit] = useState(100)

  const orders = useAsync(async () => {
    let q = db
      .from('orders')
      .select(ORDER_LIST_SELECT)
      .order('created_at', { ascending: false })
      .limit(limit)
    if (statusFilter !== 'all') q = q.eq('status', statusFilter)
    if (typeFilter !== 'all') q = q.eq('order_type', typeFilter)
    if (period !== 'all') {
      const { from } = rangeFor(period)
      q = q.gte('created_at', from.toISOString())
    }
    const term = debounced.trim().replace(/[%,()]/g, '')
    if (term) {
      if (/^\d+$/.test(term)) q = q.eq('order_number', Number(term))
      else q = q.or(`customer_name.ilike.%${term}%,customer_phone.ilike.%${term}%`)
    }
    const { data, error } = await q
    if (error) throw error
    return (data ?? []) as unknown as (Order & { order_items?: { count: number }[] })[]
  }, [db, statusFilter, typeFilter, period, debounced, limit])

  useRealtimeRefresh(['orders'], () => void orders.reload())

  const [detailOpen, setDetailOpen] = useState(false)
  const [detail, setDetail] = useState<OrderFull | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [busy, setBusy] = useState(false)

  const [payOpen, setPayOpen] = useState(false)
  const [payAmount, setPayAmount] = useState('')
  const [payMethod, setPayMethod] = useState('cash')
  const [payRef, setPayRef] = useState('')

  const [cancelOpen, setCancelOpen] = useState(false)
  const [cancelReason, setCancelReason] = useState('')

  const [refundOpen, setRefundOpen] = useState(false)
  const [refundAmount, setRefundAmount] = useState('')
  const [refundReason, setRefundReason] = useState('')

  const [splitOpen, setSplitOpen] = useState(false)
  const [splitIds, setSplitIds] = useState<string[]>([])

  const openDetail = useCallback(
    async (id: string) => {
      setDetailOpen(true)
      setDetailLoading(true)
      setDetail(null)
      const full = await fetchOrderFull(db, id)
      setDetail(full)
      setDetailLoading(false)
    },
    [db]
  )

  const reloadDetail = useCallback(async () => {
    if (!detail) return
    const full = await fetchOrderFull(db, detail.order.id)
    setDetail(full)
    void orders.reload()
  }, [db, detail, orders.reload])

  const [searchParams] = useSearchParams()
  useEffect(() => {
    const openId = searchParams.get('open')
    if (openId) void openDetail(openId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const advance = async (): Promise<void> => {
    if (!detail) return
    const next = NEXT_STATUS[detail.order.status]
    if (!next) return
    setBusy(true)
    try {
      const { error } = await db.rpc('set_order_status', { p_order: detail.order.id, p_status: next.status })
      if (error) throw error
      toast.success(t('orders.statusChanged'))
      await reloadDetail()
    } catch (err) {
      toast.error(humanError(err))
    } finally {
      setBusy(false)
    }
  }

  const remaining = detail ? Number(detail.order.total) - detail.payments.reduce((s, p) => s + Number(p.amount), 0) : 0

  const actions = useMemo(() => {
    if (!detail) return []
    const o = detail.order
    return [
      {
        label: t('orders.reprint'),
        icon: <Printer className="h-3.5 w-3.5" />,
        onClick: () => void printThermalReceipt({ order: o, items: detail.items, payments: detail.payments, settings })
      },
      {
        label: t('orders.invoiceA4'),
        icon: <FileText className="h-3.5 w-3.5" />,
        onClick: () => void printA4Invoice({ order: o, items: detail.items, payments: detail.payments, settings })
      },
      {
        label: t('receipt.kitchen'),
        icon: <ChefHat className="h-3.5 w-3.5" />,
        onClick: () => void printKitchenTicket({ order: o, items: detail.items, payments: detail.payments, settings })
      },
      {
        label: t('orders.pay'),
        icon: <CircleDollarSign className="h-3.5 w-3.5" />,
        onClick: () => {
          setPayAmount('')
          setPayRef('')
          setPayOpen(true)
        },
        disabled: !can('pos.use') || o.status === 'cancelled' || o.status === 'completed'
      },
      {
        label: t('orders.refund'),
        icon: <ShieldCheck className="h-3.5 w-3.5" />,
        onClick: () => {
          setRefundAmount('')
          setRefundReason('')
          setRefundOpen(true)
        },
        disabled: !can('orders.refund'),
        danger: false
      },
      {
        label: t('orders.split'),
        icon: <Scissors className="h-3.5 w-3.5" />,
        onClick: () => {
          setSplitIds([])
          setSplitOpen(true)
        },
        disabled: !can('pos.use') || !['draft', 'confirmed'].includes(o.status)
      },
      {
        label: t('orders.cancel'),
        icon: <Ban className="h-3.5 w-3.5" />,
        onClick: () => {
          setCancelReason('')
          setCancelOpen(true)
        },
        disabled: !can('orders.cancel') || ['cancelled', 'completed'].includes(o.status),
        danger: true
      }
    ]
  }, [detail, can, settings, t])

  return (
    <div>
      <PageHeader
        title={t('orders.title')}
        actions={
          <>
            <Tabs
              value={period}
              onChange={setPeriod}
              tabs={[
                { value: 'today', label: t('common.today') },
                { value: 'week', label: t('common.week') },
                { value: 'month', label: t('common.month') },
                { value: 'all', label: t('common.all') }
              ]}
            />
            <button
              type="button"
              onClick={() => void orders.reload()}
              aria-label={t('common.refresh')}
              className="grid h-9 w-9 place-items-center rounded-lg border border-line bg-ink-800 text-txt-dim hover:text-txt"
            >
              <RefreshCw className={cn('h-4 w-4', orders.loading && 'animate-spin')} />
            </button>
          </>
        }
      />

      <SectionCard bodyClassName="p-0">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
          <SearchInput value={search} onChange={setSearch} placeholder={t('orders.search')} className="w-72 max-w-full" />
          <Select
            compact
            className="w-36"
            value={statusFilter}
            onChange={setStatusFilter}
            options={[{ value: 'all', ar: t('common.all') }, ...ORDER_STATUS.map((s) => ({ value: s.value, ar: s.ar }))]}
          />
          <Select
            compact
            className="w-32"
            value={typeFilter}
            onChange={setTypeFilter}
            options={[{ value: 'all', ar: t('common.all') }, ...ORDER_TYPES]}
          />
          <span className="ms-auto text-[11px] text-txt-faint">{num(orders.data?.length ?? 0, 0)} أوردر</span>
        </div>

        {orders.loading && !orders.data ? (
          <PageLoader />
        ) : (orders.data ?? []).length === 0 ? (
          <EmptyState title={t('common.empty')} icon={<FileText className="h-6 w-6" />} />
        ) : (
          <TableWrap>
            <thead>
              <tr>
                <th>#</th>
                <th>{t('common.type')}</th>
                <th>{t('common.customer')}</th>
                <th>{t('common.cashier')}</th>
                <th>{t('common.total')}</th>
                <th>{t('orders.paymentStatus')}</th>
                <th>{t('common.status')}</th>
                <th>{t('common.time')}</th>
                <th className="w-10"></th>
              </tr>
            </thead>
            <tbody>
              {(orders.data ?? []).map((o) => (
                <tr key={o.id} className="cursor-pointer" onClick={() => void openDetail(o.id)}>
                  <td className="font-black text-brand-gold">#{o.order_number}</td>
                  <td className="text-xs text-txt-dim">
                    {labelOf(ORDER_TYPES, o.order_type, 'ar')}
                    {o.restaurant_tables?.number ? ` · ${o.restaurant_tables.number}` : ''}
                  </td>
                  <td className="text-xs">
                    {o.customer_name || o.customer_phone || '—'}
                  </td>
                  <td className="text-xs text-txt-dim">{o.cashier?.full_name ?? '—'}</td>
                  <td className="font-bold">{money(o.total)}</td>
                  <td>
                    <Badge color={colorOf(PAYMENT_STATUS, o.payment_status)}>{labelOf(PAYMENT_STATUS, o.payment_status, 'ar')}</Badge>
                  </td>
                  <td>
                    <Badge color={colorOf(ORDER_STATUS, o.status)}>{labelOf(ORDER_STATUS, o.status, 'ar')}</Badge>
                  </td>
                  <td className="text-[11px] text-txt-faint">{fmtDateTime(o.created_at)}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <RowMenu items={[{ label: t('orders.details'), icon: <FileText className="h-3.5 w-3.5" />, onClick: () => void openDetail(o.id) }]} />
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}

        {(orders.data?.length ?? 0) >= limit && (
          <div className="border-t border-line p-3 text-center">
            <Button variant="ghost" size="sm" onClick={() => setLimit((l) => l + 100)}>
              تحميل المزيد
            </Button>
          </div>
        )}
      </SectionCard>

      <Dialog
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        title={detail ? `${t('orders.details')} · #${detail.order.order_number}` : t('orders.details')}
        subtitle={detail ? fmtDateTime(detail.order.created_at) : undefined}
        size="lg"
        footer={
          detail && (
            <div className="flex w-full flex-wrap items-center justify-between gap-2">
              <div className="text-xs text-txt-faint">
                {t('common.total')}: <span className="font-black text-brand-gold">{money(detail.order.total)}</span>
              </div>
              <div className="flex items-center gap-2">
                {NEXT_STATUS[detail.order.status] && (
                  <Button
                    variant="ghost"
                    icon={<Send className="h-4 w-4" />}
                    disabled={busy}
                    onClick={() => void advance()}
                  >
                    {NEXT_STATUS[detail.order.status]?.label}
                  </Button>
                )}
                {detail.order.payment_status !== 'paid' && detail.order.status !== 'cancelled' && can('pos.use') && (
                  <Button
                    icon={<CircleDollarSign className="h-4 w-4" />}
                    onClick={() => {
                      setPayAmount('')
                      setPayRef('')
                      setPayOpen(true)
                    }}
                  >
                    {t('orders.pay')}
                  </Button>
                )}
              </div>
            </div>
          )
        }
      >
        {detailLoading ? (
          <div className="grid h-40 place-items-center">
            <Loader2 className="h-6 w-6 animate-spin text-txt-dim" />
          </div>
        ) : detail ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge color={colorOf(ORDER_STATUS, detail.order.status)}>
                {labelOf(ORDER_STATUS, detail.order.status, 'ar')}
              </Badge>
              <Badge color={colorOf(PAYMENT_STATUS, detail.order.payment_status)}>
                {labelOf(PAYMENT_STATUS, detail.order.payment_status, 'ar')}
              </Badge>
              <Badge>{labelOf(ORDER_TYPES, detail.order.order_type, 'ar')}</Badge>
              {detail.order.restaurant_tables?.number && <Badge>{t('common.table')} {detail.order.restaurant_tables.number}</Badge>}
              <div className="ms-auto flex items-center gap-1">
                <RowMenu items={actions} />
              </div>
            </div>

            {(detail.order.customer_name || detail.order.customer_phone) && (
              <div className="flex flex-wrap gap-4 rounded-xl border border-line bg-ink-800/60 p-3 text-xs">
                <span className="text-txt-faint">{t('common.customer')}: <span className="font-semibold text-txt">{detail.order.customer_name || '—'}</span></span>
                <span className="text-txt-faint">{t('common.phone')}: <span className="font-semibold text-txt" dir="ltr">{detail.order.customer_phone || '—'}</span></span>
                {detail.order.customer_address && <span className="text-txt-faint">{t('common.address')}: <span className="font-semibold text-txt">{detail.order.customer_address}</span></span>}
              </div>
            )}

            <div className="overflow-hidden rounded-xl border border-line">
              <table className="table-base">
                <thead>
                  <tr>
                    <th>{t('orders.items')}</th>
                    <th>{t('common.qty')}</th>
                    <th>{t('common.total')}</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.items.map((item: OrderItem) => (
                    <tr key={item.id}>
                      <td>
                        <div className="font-semibold">
                          {item.name_snapshot}
                          {item.variant_name ? <span className="text-txt-faint"> · {item.variant_name}</span> : null}
                        </div>
                        {(item.order_item_extras ?? []).length > 0 && (
                          <div className="text-[10px] text-brand-gold">
                            {(item.order_item_extras ?? []).map((ex) => `${ex.name_snapshot} ×${ex.quantity}`).join(' · ')}
                          </div>
                        )}
                        {item.notes && <div className="text-[10px] text-txt-faint">✎ {item.notes}</div>}
                      </td>
                      <td className="text-xs">{item.quantity}</td>
                      <td className="font-bold">{money(item.line_total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-xl border border-line bg-ink-800/60 p-3 text-xs">
                <Row label={t('common.subtotal')} value={money(detail.order.subtotal)} />
                {Number(detail.order.discount) > 0 && <Row label={t('common.discount')} value={`- ${money(detail.order.discount)}`} />}
                {Number(detail.order.tax) > 0 && <Row label={`${t('common.tax')} ${detail.order.tax_rate}%`} value={money(detail.order.tax)} />}
                <div className="mt-1.5 flex items-center justify-between border-t border-line pt-1.5 text-sm font-black">
                  <span>{t('common.total')}</span>
                  <span className="text-brand-gold">{money(detail.order.total)}</span>
                </div>
                {remaining > 0 && <Row label={t('pos.remaining')} value={money(remaining)} danger />}
              </div>

              <div className="rounded-xl border border-line bg-ink-800/60 p-3 text-xs">
                <div className="mb-1.5 font-bold text-txt-dim">{t('orders.payment')}</div>
                {detail.payments.length === 0 && <div className="text-[11px] text-txt-faint">{t('orders.noPayments')}</div>}
                {detail.payments.map((p: Payment) => (
                  <div key={p.id} className="flex items-center justify-between py-1 text-[11px]">
                    <span className="text-txt-dim">{labelOf(PAYMENT_METHODS, p.method, 'ar')}</span>
                    <span className="font-bold">{money(p.amount)}</span>
                  </div>
                ))}
                {detail.order.notes && (
                  <div className="mt-2 border-t border-line pt-2 text-[11px] text-txt-faint">
                    {t('common.notes')}: {detail.order.notes}
                  </div>
                )}
                {detail.order.cancel_reason && (
                  <div className="mt-2 rounded-lg bg-brand-red/10 p-2 text-[11px] text-brand-redSoft">
                    {t('orders.cancelReason')}: {detail.order.cancel_reason}
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : null}
      </Dialog>

      <Dialog
        open={payOpen}
        onClose={() => setPayOpen(false)}
        title={t('orders.pay')}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setPayOpen(false)}>{t('common.cancel')}</Button>
            <Button
              disabled={busy}
              onClick={async () => {
                if (!detail) return
                if (parseNum(payAmount) <= 0) return
                setBusy(true)
                try {
                  const { error } = await db.rpc('pay_order', {
                    p_order: detail.order.id,
                    p_method: payMethod,
                    p_amount: parseNum(payAmount),
                    p_reference: payRef.trim() || null
                  })
                  if (error) throw error
                  toast.success(t('orders.paidNow'))
                  setPayOpen(false)
                  await reloadDetail()
                } catch (err) {
                  toast.error(humanError(err))
                } finally {
                  setBusy(false)
                }
              }}
            >
              {t('common.confirm')}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label={t('common.amount')} hint={remaining > 0 ? `${t('pos.remaining')}: ${money(remaining)}` : undefined}>
            <input autoFocus className="input" inputMode="decimal" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} placeholder="0" />
          </Field>
          <Field label={t('common.paymentMethod')}>
            <Select value={payMethod} onChange={setPayMethod} options={PAYMENT_METHODS} />
          </Field>
          <Field label="رقم مرجعي">
            <input className="input" value={payRef} onChange={(e) => setPayRef(e.target.value)} />
          </Field>
        </div>
      </Dialog>

      <Dialog
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        title={t('orders.cancel')}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setCancelOpen(false)}>{t('common.cancel')}</Button>
            <Button
              variant="danger"
              disabled={busy || !cancelReason.trim()}
              onClick={async () => {
                if (!detail) return
                setBusy(true)
                try {
                  const { error } = await db.rpc('cancel_order', { p_order: detail.order.id, p_reason: cancelReason.trim() })
                  if (error) throw error
                  toast.success(t('orders.cancelled'))
                  setCancelOpen(false)
                  await reloadDetail()
                } catch (err) {
                  toast.error(humanError(err))
                } finally {
                  setBusy(false)
                }
              }}
            >
              {t('common.confirm')}
            </Button>
          </>
        }
      >
        <Field label={t('orders.cancelReason')}>
          <input className="input" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} autoFocus />
        </Field>
      </Dialog>

      <Dialog
        open={refundOpen}
        onClose={() => setRefundOpen(false)}
        title={t('orders.refund')}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRefundOpen(false)}>{t('common.cancel')}</Button>
            <Button
              disabled={busy || parseNum(refundAmount) <= 0}
              onClick={async () => {
                if (!detail) return
                setBusy(true)
                try {
                  const { error } = await db.rpc('refund_order', {
                    p_order: detail.order.id,
                    p_amount: parseNum(refundAmount),
                    p_reason: refundReason.trim() || null
                  })
                  if (error) throw error
                  toast.success(t('orders.refunded'))
                  setRefundOpen(false)
                  await reloadDetail()
                } catch (err) {
                  toast.error(humanError(err))
                } finally {
                  setBusy(false)
                }
              }}
            >
              {t('common.confirm')}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label={t('orders.refundAmount')}>
            <input autoFocus className="input" inputMode="decimal" value={refundAmount} onChange={(e) => setRefundAmount(e.target.value)} placeholder="0" />
          </Field>
          <Field label={t('orders.refundReason')}>
            <input className="input" value={refundReason} onChange={(e) => setRefundReason(e.target.value)} />
          </Field>
        </div>
      </Dialog>

      <Dialog
        open={splitOpen}
        onClose={() => setSplitOpen(false)}
        title={t('orders.split')}
        subtitle={t('orders.splitHint')}
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setSplitOpen(false)}>{t('common.cancel')}</Button>
            <Button
              disabled={busy || splitIds.length === 0}
              onClick={async () => {
                if (!detail) return
                setBusy(true)
                try {
                  const { error } = await db.rpc('split_order', { p_order: detail.order.id, p_item_ids: splitIds })
                  if (error) throw error
                  toast.success(t('orders.splitDone'))
                  setSplitOpen(false)
                  await reloadDetail()
                } catch (err) {
                  toast.error(humanError(err))
                } finally {
                  setBusy(false)
                }
              }}
            >
              {t('common.confirm')}
            </Button>
          </>
        }
      >
        <div className="space-y-1.5">
          {detail?.items.map((item) => {
            const checked = splitIds.includes(item.id)
            return (
              <button
                key={item.id}
                type="button"
                onClick={() =>
                  setSplitIds((prev) => (checked ? prev.filter((id) => id !== item.id) : [...prev, item.id]))
                }
                className={cn(
                  'flex w-full items-center justify-between rounded-lg border px-3 py-2.5 text-start text-xs font-semibold transition',
                  checked ? 'border-brand-gold/50 bg-brand-gold/10 text-brand-gold' : 'border-line text-txt-dim hover:border-line-2'
                )}
              >
                <span>
                  {item.quantity}× {item.name_snapshot}
                </span>
                <span>{money(item.line_total)}</span>
              </button>
            )
          })}
        </div>
      </Dialog>
    </div>
  )
}

function Row({ label, value, danger }: { label: string; value: string; danger?: boolean }): JSX.Element {
  return (
    <div className="flex items-center justify-between py-0.5">
      <span className="text-txt-faint">{label}</span>
      <span className={cn('font-semibold', danger ? 'text-brand-redSoft' : 'text-txt')}>{value}</span>
    </div>
  )
}
