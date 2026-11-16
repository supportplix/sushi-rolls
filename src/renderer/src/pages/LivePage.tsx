import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Activity,
  ArrowLeft,
  ChefHat,
  Clock3,
  Flame,
  Radio,
  ShieldCheck,
  ShoppingBag,
  TriangleAlert
} from 'lucide-react'
import { useDb } from '@/lib/auth'
import { useAsync, useNow, useRealtimeRefresh } from '@/lib/hooks'
import { elapsedSince, fmtTime, money, num, rangeFor } from '@/lib/format'
import type { Order, RTable } from '@/lib/types'
import { colorOf, labelOf, ORDER_STATUS, ORDER_TYPES, TABLE_STATUS } from '@/lib/constants'
import { t } from '@/i18n'
import { cn } from '@/lib/cn'
import {
  Badge,
  EmptyState,
  PageHeader,
  SectionCard,
  Skeleton,
  StatCard
} from '@/components/ui/primitives'

interface DashboardMini {
  sales: number
  orders_count: number
  best_products: { name: string; qty: number; sales: number }[]
  low_stock: { id: string; name: string; quantity: number; min_stock: number; unit: string }[]
}

type LiveOrder = Order & {
  restaurant_tables?: { number: string } | null
  order_items?: { count: number }[]
}

const clockFmt = new Intl.DateTimeFormat('ar-EG-u-nu-latn', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: true
})

export default function LivePage(): JSX.Element {
  const db = useDb()
  const navigate = useNavigate()
  const now = useNow(1000)

  const dash = useAsync(async () => {
    const { from, to } = rangeFor('today')
    const { data, error } = await db.rpc('get_dashboard', {
      p_from: from.toISOString(),
      p_to: to.toISOString(),
      p_tz: 'Africa/Cairo'
    })
    if (error) throw error
    return data as DashboardMini
  }, [db])

  const live = useAsync(async () => {
    const { from } = rangeFor('today')
    const [ordersRes, tablesRes, kitchenRes] = await Promise.all([
      db
        .from('orders')
        .select('*, restaurant_tables(number), order_items(count)')
        .gte('created_at', from.toISOString())
        .order('created_at', { ascending: false })
        .limit(14),
      db.from('restaurant_tables').select('id, number, zone, status').order('number'),
      db
        .from('orders')
        .select('id, order_number, status, created_at')
        .in('status', ['sent_to_kitchen', 'preparing', 'ready'])
        .order('created_at', { ascending: true })
        .limit(50)
    ])
    if (ordersRes.error) throw ordersRes.error
    if (tablesRes.error) throw tablesRes.error
    if (kitchenRes.error) throw kitchenRes.error
    return {
      orders: (ordersRes.data ?? []) as unknown as LiveOrder[],
      tables: (tablesRes.data ?? []) as RTable[],
      kitchen: (kitchenRes.data ?? []) as { id: string; order_number: number; status: string; created_at: string }[]
    }
  }, [db])

  useRealtimeRefresh(['orders', 'restaurant_tables'], () => {
    void live.reload()
    void dash.reload()
  })

  const kitchenCounts = useMemo(() => {
    const counts = { sent_to_kitchen: 0, preparing: 0, ready: 0 }
    for (const o of live.data?.kitchen ?? []) {
      if (o.status in counts) counts[o.status as keyof typeof counts] += 1
    }
    return counts
  }, [live.data?.kitchen])

  const occupied = (live.data?.tables ?? []).filter((tb) => tb.status === 'occupied').length
  const oldest = live.data?.kitchen?.[0]
  const oldestElapsed = oldest ? elapsedSince(oldest.created_at, now) : null
  const conveyor = (live.data?.orders ?? []).slice(0, 10)

  return (
    <div>
      <PageHeader
        title={t('live.title')}
        actions={
          <>
            <span className="flex items-center gap-2 text-sm font-black tabular-nums text-txt-dim">
              <Clock3 className="h-4 w-4 text-brand-gold" />
              {clockFmt.format(new Date(now))}
            </span>
            <span className="flex items-center gap-2 rounded-full border border-brand-red/30 bg-brand-red/10 px-3 py-1.5 text-[11px] font-bold text-brand-redSoft">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-red opacity-60" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-brand-red" />
              </span>
              {t('live.on')}
            </span>
          </>
        }
      />

      {!dash.data && dash.loading ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[86px]" />
          ))}
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label={t('dashboard.sales')}
            value={money(dash.data?.sales)}
            icon={<ShoppingBag className="h-5 w-5" />}
            accent="red"
          />
          <StatCard
            label={t('dashboard.orders')}
            value={num(dash.data?.orders_count, 0)}
            icon={<Activity className="h-5 w-5" />}
            accent="gold"
          />
          <StatCard
            label={t('live.inKitchen')}
            value={num(live.data?.kitchen.length ?? 0, 0)}
            icon={<ChefHat className="h-5 w-5" />}
            accent="gold"
            hint={oldestElapsed ? `${t('live.oldest')}: ${oldestElapsed.text}` : undefined}
          />
          <StatCard
            label={t('live.tablesBusy')}
            value={`${num(occupied, 0)} من ${num(live.data?.tables.length ?? 0, 0)}`}
            icon={<Radio className="h-5 w-5" />}
            accent="green"
          />
        </div>
      )}

      <section className="card mt-3 overflow-hidden">
        <header className="flex items-center justify-between gap-2 border-b border-line px-5 py-3">
          <h2 className="flex items-center gap-2 text-sm font-bold">
            <Radio className="h-4 w-4 text-brand-red" />
            {t('live.conveyor')}
          </h2>
          <span className="text-[10.5px] font-semibold text-txt-faint">{conveyor.length} طلب</span>
        </header>
        {conveyor.length === 0 ? (
          <div className="grid h-20 place-items-center text-[11px] text-txt-faint">{t('live.noOrders')}</div>
        ) : (
          <div className={cn('relative overflow-hidden py-3', conveyor.length >= 4 && 'belt-marquee')}>
            <div
              className={cn(
                'flex gap-2 px-5',
                conveyor.length >= 4 ? 'belt-track w-max' : 'flex-wrap justify-center'
              )}
            >
              {(conveyor.length >= 4 ? [...conveyor, ...conveyor] : conveyor).map((o, i) => (
                <button
                  key={`${o.id}-${i}`}
                  type="button"
                  onClick={() => navigate(`/orders?open=${o.id}`)}
                  className="flex shrink-0 items-center gap-2 rounded-full border border-line bg-ink-800/80 px-3.5 py-1.5 text-[11px] font-semibold transition hover:border-brand-gold/40"
                >
                  <span
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ background: colorOf(ORDER_STATUS, o.status) ?? '#6B7176' }}
                  />
                  <span className="font-black text-brand-gold">#{o.order_number}</span>
                  <span className="text-txt-faint">{labelOf(ORDER_TYPES, o.order_type, 'ar')}</span>
                  <span>{money(o.total)}</span>
                  <span className="text-txt-faint">{fmtTime(o.created_at)}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </section>

      <div className="mt-3 grid gap-3 xl:grid-cols-3">
        <div className="space-y-3 self-start xl:col-span-2">
        <SectionCard
          title={t('live.latest')}
          bodyClassName="p-0"
        >
          {live.loading && !live.data ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-12" />
              ))}
            </div>
          ) : (live.data?.orders.length ?? 0) === 0 ? (
            <EmptyState title={t('live.noOrders')} icon={<ShoppingBag className="h-6 w-6" />} />
          ) : (
            <div className="max-h-[420px] overflow-y-auto">
              {live.data?.orders.map((o) => {
                const elapsed = elapsedSince(o.created_at, now)
                return (
                  <button
                    key={o.id}
                    type="button"
                    onClick={() => navigate(`/orders?open=${o.id}`)}
                    className="flex w-full animate-fadeUp items-center gap-3 border-b border-line/60 px-4 py-3 text-start transition hover:bg-white/[0.03]"
                  >
                    <span className="min-w-[52px] text-sm font-black text-brand-gold">#{o.order_number}</span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-bold">
                        {labelOf(ORDER_TYPES, o.order_type, 'ar')}
                        {o.restaurant_tables?.number ? ` · ${o.restaurant_tables.number}` : ''}
                        {o.customer_name ? ` · ${o.customer_name}` : ''}
                      </div>
                      <div className="mt-0.5 text-[10px] text-txt-faint">
                        {fmtTime(o.created_at)} · {elapsed.text}
                      </div>
                    </div>
                    <Badge color={colorOf(ORDER_STATUS, o.status)}>{labelOf(ORDER_STATUS, o.status, 'ar')}</Badge>
                    <span className="w-20 text-end text-xs font-bold">{money(o.total)}</span>
                    <ArrowLeft className="h-4 w-4 shrink-0 text-txt-faint" />
                  </button>
                )
              })}
            </div>
          )}
        </SectionCard>

        <SectionCard title={t('dashboard.best')} bodyClassName="px-1 py-1">
          {(dash.data?.best_products ?? []).length === 0 ? (
            <div className="grid h-20 place-items-center text-[11px] text-txt-faint">{t('common.empty')}</div>
          ) : (
            <ul className="divide-y divide-white/[0.045]">
              {dash.data?.best_products.map((p, i) => (
                <li key={p.name} className="flex items-center gap-3 px-4 py-2.5">
                  <span className="grid h-6 w-6 place-items-center rounded-md border border-white/[0.06] bg-white/[0.04] text-[10px] font-black text-brand-gold">
                    {i + 1}
                  </span>
                  <span className="flex-1 truncate text-xs font-semibold">{p.name}</span>
                  <span className="text-[11px] text-txt-faint">{p.qty} ×</span>
                  <span className="text-xs font-bold">{money(p.sales)}</span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
        </div>

        <div className="space-y-3">
          <SectionCard title={t('live.kitchen')} bodyClassName="p-4">
            {(
              [
                { key: 'sent_to_kitchen', icon: <ChefHat className="h-3.5 w-3.5" /> },
                { key: 'preparing', icon: <Flame className="h-3.5 w-3.5" /> },
                { key: 'ready', icon: <ShieldCheck className="h-3.5 w-3.5" /> }
              ] as const
            ).map((row) => (
              <div key={row.key} className="flex items-center justify-between border-b border-line/60 py-2 last:border-0">
                <span className="flex items-center gap-2 text-xs font-semibold" style={{ color: colorOf(ORDER_STATUS, row.key) }}>
                  {row.icon}
                  {labelOf(ORDER_STATUS, row.key, 'ar')}
                </span>
                <span className="text-lg font-black tabular-nums">{kitchenCounts[row.key]}</span>
              </div>
            ))}
            {oldest && (
              <div className="mt-2 rounded-lg bg-brand-gold/10 px-2.5 py-1.5 text-[10.5px] font-semibold text-brand-gold">
                {t('live.oldest')}: #{oldest.order_number} · {oldestElapsed?.text}
              </div>
            )}
          </SectionCard>

          <SectionCard title={t('live.tables')} bodyClassName="p-3">
            <div className="grid grid-cols-4 gap-2">
              {(live.data?.tables ?? []).map((tb) => {
                const color = colorOf(TABLE_STATUS, tb.status) ?? '#6B7176'
                return (
                  <div
                    key={tb.id}
                    className="rounded-lg border px-1.5 py-2 text-center"
                    style={{ borderColor: `${color}44`, background: `${color}0F` }}
                  >
                    <div className="text-xs font-black">{tb.number}</div>
                    <div className="mt-0.5 text-[9px] font-semibold" style={{ color }}>
                      {labelOf(TABLE_STATUS, tb.status, 'ar')}
                    </div>
                  </div>
                )
              })}
            </div>
          </SectionCard>

          <SectionCard title={t('live.stock')} bodyClassName="p-3">
            {(dash.data?.low_stock ?? []).length === 0 ? (
              <div className="flex items-center gap-2 py-2 text-[11px] font-semibold text-emerald-400">
                <ShieldCheck className="h-4 w-4" />
                {t('live.stockOk')}
              </div>
            ) : (
              <div className="space-y-1.5">
                {dash.data?.low_stock.map((item) => (
                  <div key={item.id} className="flex items-center justify-between gap-2 text-[11px]">
                    <span className="flex items-center gap-1.5 font-semibold text-txt-dim">
                      <TriangleAlert className="h-3.5 w-3.5 text-brand-redSoft" />
                      {item.name}
                    </span>
                    <span className="text-txt-faint">
                      {num(item.quantity, 2)} / {num(item.min_stock, 2)} {item.unit}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>
        </div>
      </div>
    </div>
  )
}
