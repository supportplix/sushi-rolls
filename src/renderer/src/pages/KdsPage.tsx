import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowRight, CheckCheck, ChefHat, Clock, Flame, LogOut, MonitorPlay } from 'lucide-react'
import { useDb } from '@/lib/auth'
import { useAsync, useNow, useRealtimeRefresh } from '@/lib/hooks'
import { humanError } from '@/lib/errors'
import { elapsedSince, fmtTime } from '@/lib/format'
import type { Order, OrderItem } from '@/lib/types'
import { t } from '@/i18n'
import { labelOf, ORDER_TYPES } from '@/lib/constants'
import { cn } from '@/lib/cn'
import { Badge, Button, Spinner } from '@/components/ui/primitives'
import { useToast } from '@/components/ui/toast'
import { logoDataUrl } from '@/lib/logo'
import { AuroraField } from '@/components/layout/AuroraField'
import { useState } from 'react'

type KdsOrder = Order & { order_items: OrderItem[] }

const COLUMNS = [
  { key: 'sent_to_kitchen', label: t('kds.new'), color: '#E4BE54', icon: <ChefHat className="h-4 w-4" /> },
  { key: 'preparing', label: t('kds.preparing'), color: '#FF8A3D', icon: <Flame className="h-4 w-4" /> },
  { key: 'ready', label: t('kds.ready'), color: '#3DBE7A', icon: <CheckCheck className="h-4 w-4" /> }
] as const

export default function KdsPage(): JSX.Element {
  const db = useDb()
  const toast = useToast()
  const navigate = useNavigate()
  const now = useNow(15_000)
  const [logo, setLogo] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const lastCount = useRef(0)

  useEffect(() => {
    void logoDataUrl().then(setLogo)
  }, [])

  const orders = useAsync(async () => {
    const { data, error } = await db
      .from('orders')
      .select('*, order_items(*, order_item_extras(*)), restaurant_tables(number)')
      .in('status', ['sent_to_kitchen', 'preparing', 'ready'])
      .order('created_at', { ascending: true })
      .limit(80)
    if (error) throw error
    return (data ?? []) as unknown as KdsOrder[]
  }, [db])

  useRealtimeRefresh(['orders', 'order_items'], () => void orders.reload())

  // Browsers cap AudioContext instances (~6 in Chromium); creating one per new
  // order leaks them until beeps silently stop on a screen that runs all day.
  const audioCtxRef = useRef<AudioContext | null>(null)
  useEffect(() => {
    return () => {
      void audioCtxRef.current?.close().catch(() => undefined)
      audioCtxRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!orders.data) return
    if (orders.data.length > lastCount.current && lastCount.current > 0) {
      try {
        if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
          audioCtxRef.current = new AudioContext()
        }
        const ctx = audioCtxRef.current
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.connect(gain)
        gain.connect(ctx.destination)
        osc.frequency.value = 880
        gain.gain.setValueAtTime(0.08, ctx.currentTime)
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35)
        osc.start()
        osc.stop(ctx.currentTime + 0.35)
      } catch {
        void 0
      }
    }
    lastCount.current = orders.data.length
  }, [orders.data])

  const advance = useCallback(
    async (order: KdsOrder) => {
      const next =
        order.status === 'sent_to_kitchen' ? 'preparing' : order.status === 'preparing' ? 'ready' : 'completed'
      setBusyId(order.id)
      try {
        const { error } = await db.rpc('set_order_status', { p_order: order.id, p_status: next })
        if (error) throw error
        void orders.reload()
      } catch (err) {
        toast.error(humanError(err))
      } finally {
        setBusyId(null)
      }
    },
    [db, orders.reload, toast]
  )

  const grouped = useMemo(() => {
    const map: Record<string, KdsOrder[]> = {
      sent_to_kitchen: [],
      preparing: [],
      ready: []
    }
    for (const o of orders.data ?? []) {
      if (map[o.status]) map[o.status].push(o)
    }
    return map
  }, [orders.data])

  const exit = (): void => {
    if (window.history.length > 1) navigate(-1)
    else window.close()
  }

  return (
    <div className="relative flex h-screen flex-col bg-ink">
      <AuroraField />
      <div className="app-drag fixed inset-x-0 top-0 z-50 h-[38px] bg-transparent" />
      <header className="relative z-10 flex items-center justify-between gap-4 border-b border-white/[0.06] px-6 pb-3 pt-[50px]">
        <div className="flex items-center gap-3">
          {logo ? (
            <img src={logo} alt="SUSHI ROLLS" className="h-10 w-10 object-contain drop-shadow-[0_8px_18px_rgba(0,0,0,0.5)]" />
          ) : (
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-ink-600">
              <ChefHat className="h-5 w-5 text-brand-gold" />
            </div>
          )}
          <div>
            <h1 className="text-lg font-black">{t('kds.title')}</h1>
            <p className="text-[10.5px] text-txt-faint">
              {t('kds.autoRefresh')} · {fmtTime(new Date())}
            </p>
          </div>
          <Badge color="#3DBE7A" className="ms-2">
            {orders.data?.length ?? 0} {t('common.order')}
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          <span className="hidden items-center gap-1.5 text-[11px] text-txt-faint md:flex">
            <MonitorPlay className="h-3.5 w-3.5" />
            {t('kds.openWindow')}
          </span>
          <Button variant="ghost" size="sm" icon={<ArrowRight className="h-4 w-4" />} onClick={exit}>
            {t('common.back')}
          </Button>
        </div>
      </header>

      {orders.loading && !orders.data ? (
        <div className="grid flex-1 place-items-center">
          <Spinner className="h-8 w-8" />
        </div>
      ) : (
        <div className="relative z-10 grid flex-1 grid-cols-1 gap-4 overflow-hidden p-4 md:grid-cols-3">
          {COLUMNS.map((col) => (
            <section key={col.key} className="flex min-h-0 flex-col rounded-[24px] border border-white/[0.065] bg-[#0A0B0D]/60 backdrop-blur-xl">
              <header className="flex items-center justify-between border-b border-white/[0.06] px-4 py-3">
                <div className="flex items-center gap-2 text-sm font-bold" style={{ color: col.color }}>
                  {col.icon}
                  {col.label}
                </div>
                <span
                  className="rounded-full px-2 py-0.5 text-[11px] font-black"
                  style={{ background: `${col.color}1A`, color: col.color }}
                >
                  {grouped[col.key]?.length ?? 0}
                </span>
              </header>
              <div className="scroll-area flex-1 space-y-2.5 p-3">
                {(grouped[col.key] ?? []).map((order) => {
                  const elapsed = elapsedSince(order.created_at, now)
                  const delayed = elapsed.minutes >= 20 && order.status !== 'ready'
                  return (
                    <article
                      key={order.id}
                      className={cn(
                        'rounded-2xl border bg-[#0F1013]/[0.85] p-3.5 shadow-card backdrop-blur-xl transition',
                        delayed ? 'border-brand-red/60 shadow-glow' : 'border-white/[0.07]'
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-xl font-black">#{order.order_number}</div>
                        <span
                          className={cn(
                            'flex items-center gap-1 rounded-full px-2 py-1 text-[10.5px] font-bold',
                            delayed ? 'bg-brand-red/[0.15] text-brand-redSoft' : 'bg-white/[0.05] text-txt-dim'
                          )}
                        >
                          <Clock className="h-3 w-3" />
                          {elapsed.text}
                        </span>
                      </div>
                      <div className="mt-1 flex items-center gap-2 text-[10.5px] text-txt-faint">
                        <span className="font-semibold">{labelOf(ORDER_TYPES, order.order_type, 'ar')}</span>
                        {order.restaurant_tables?.number && <span>· {t('kds.table')} {order.restaurant_tables.number}</span>}
                        <span>· {fmtTime(order.created_at)}</span>
                        {delayed && <span className="font-bold text-brand-redSoft">· {t('kds.delayed')}</span>}
                      </div>
                      <div className="mt-2.5 space-y-1.5 border-t border-line pt-2">
                        {order.order_items.map((item) => (
                          <div key={item.id}>
                            <div className="flex items-start gap-2 text-sm">
                              <span className="min-w-[24px] rounded-md bg-white/[0.06] px-1 text-center text-xs font-black">
                                {item.quantity}×
                              </span>
                              <span className="font-bold leading-5">
                                {item.name_snapshot}
                                {item.variant_name ? <span className="text-xs text-txt-faint"> ({item.variant_name})</span> : null}
                              </span>
                            </div>
                            {(item.order_item_extras ?? []).map((ex) => (
                              <div key={ex.id} className="ps-8 text-[11px] font-semibold text-brand-gold">
                                + {ex.name_snapshot}
                              </div>
                            ))}
                            {item.notes && <div className="ps-8 text-[11px] text-txt-dim">✎ {item.notes}</div>}
                          </div>
                        ))}
                      </div>
                      {order.notes && (
                        <div className="mt-2 rounded-lg border border-brand-gold/30 bg-brand-gold/10 px-2 py-1.5 text-[11px] font-semibold text-brand-gold">
                          {order.notes}
                        </div>
                      )}
                      <Button
                        size="sm"
                        className="mt-3 w-full"
                        variant={order.status === 'ready' ? 'gold' : 'ghost'}
                        disabled={busyId === order.id}
                        onClick={() => void advance(order)}
                      >
                        {busyId === order.id
                          ? t('common.loading')
                          : order.status === 'sent_to_kitchen'
                            ? t('kds.start')
                            : order.status === 'preparing'
                              ? t('kds.markReady')
                              : t('kds.done')}
                      </Button>
                    </article>
                  )
                })}
                {(grouped[col.key] ?? []).length === 0 && (
                  <div className="grid h-32 place-items-center text-center text-[11px] text-txt-faint">
                    {col.key === 'sent_to_kitchen'
                      ? t('kds.emptyNew')
                      : col.key === 'preparing'
                        ? t('kds.emptyPreparing')
                        : t('kds.noneReady')}
                  </div>
                )}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
