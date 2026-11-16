import { useCallback, useMemo, useState } from 'react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts'
import {
  ArrowUpRight,
  Banknote,
  ChefHat,
  CircleDollarSign,
  ClipboardList,
  PackageSearch,
  RefreshCw,
  ShoppingBag,
  TrendingDown,
  TrendingUp,
  Users,
  Wallet
} from 'lucide-react'
import { Link } from 'react-router-dom'
import { useAsync, useRealtimeRefresh } from '@/lib/hooks'
import { useAuth, useDb } from '@/lib/auth'
import {
  fmtDate,
  money,
  num,
  rangeFor,
  addDays,
  toISODate,
  type Period
} from '@/lib/format'
import { t } from '@/i18n'
import { ORDER_TYPES, PAYMENT_METHODS, labelOf } from '@/lib/constants'
import { cn } from '@/lib/cn'
import {
  Badge,
  PageHeader,
  PageLoader,
  SectionCard,
  Skeleton,
  StatCard,
  Tabs
} from '@/components/ui/primitives'

interface DashboardData {
  sales: number
  orders_count: number
  completed: number
  pending: number
  cancelled: number
  avg_order: number
  expenses: number
  cogs: number
  profit_estimate: number
  active_staff: number
  best_products: { name: string; qty: number; sales: number }[]
  low_stock: { id: string; name: string; quantity: number; min_stock: number; unit: string }[]
}

interface DayRow {
  date: string
  sales: number
  orders: number
}

const PIE_COLORS = ['#E50E05', '#E4BE54', '#3DBE7A', '#9BA1A6', '#E58E05']

const tooltipStyle = {
  background: 'rgba(15,16,19,0.96)',
  border: '1px solid rgba(255,255,255,0.09)',
  borderRadius: 14,
  fontSize: 12,
  color: '#F7F7F5',
  backdropFilter: 'blur(12px)'
}

export default function Dashboard(): JSX.Element {
  const db = useDb()
  const { can } = useAuth()
  const canReports = can('reports.view')
  const [period, setPeriod] = useState<Period>('today')

  const { from, to } = useMemo(() => rangeFor(period), [period])
  const chartFrom = useMemo(
    () => (period === 'today' || period === 'yesterday' ? addDays(from, -6) : from),
    [period, from]
  )

  const dash = useAsync(async () => {
    const { data, error } = await db.rpc('get_dashboard', {
      p_from: from.toISOString(),
      p_to: to.toISOString(),
      p_tz: 'Africa/Cairo'
    })
    if (error) throw error
    return data as DashboardData
  }, [db, period])

  const days = useAsync(async () => {
    if (!canReports) return [] as DayRow[]
    const { data, error } = await db.rpc('report_sales_by_day', {
      p_from: toISODate(chartFrom),
      p_to: toISODate(to),
      p_tz: 'Africa/Cairo'
    })
    if (error) throw error
    return (data ?? []) as DayRow[]
  }, [db, period, canReports, chartFrom, to])

  const methods = useAsync(async () => {
    if (!canReports) return [] as { method: string; amount: number; count: number }[]
    const { data, error } = await db.rpc('report_payment_methods', {
      p_from: from.toISOString(),
      p_to: to.toISOString()
    })
    if (error) throw error
    return (data ?? []) as { method: string; amount: number; count: number }[]
  }, [db, period, canReports])

  const types = useAsync(async () => {
    if (!canReports) return [] as { type: string; amount: number; count: number }[]
    const { data, error } = await db.rpc('report_order_types', {
      p_from: from.toISOString(),
      p_to: to.toISOString()
    })
    if (error) throw error
    return (data ?? []) as { type: string; amount: number; count: number }[]
  }, [db, period, canReports])

  const reloadAll = useCallback(() => {
    void dash.reload()
    void days.reload()
    void methods.reload()
    void types.reload()
  }, [dash.reload, days.reload, methods.reload, types.reload])

  useRealtimeRefresh(['orders'], reloadAll)

  const d = dash.data
  const methodsTotal = (methods.data ?? []).reduce((s, m) => s + Number(m.amount), 0)

  return (
    <div>
      <PageHeader
        title={t('dashboard.title')}
        actions={
          <>
            <Tabs
              value={period}
              onChange={setPeriod}
              tabs={[
                { value: 'today', label: t('common.today') },
                { value: 'yesterday', label: t('common.yesterday') },
                { value: 'week', label: t('common.week') },
                { value: 'month', label: t('common.month') }
              ]}
            />
            <button
              type="button"
              onClick={reloadAll}
              aria-label={t('common.refresh')}
              className="grid h-9 w-9 place-items-center rounded-lg border border-line bg-ink-800 text-txt-dim transition hover:text-txt"
            >
              <RefreshCw className={cn('h-4 w-4', dash.loading && 'animate-spin')} />
            </button>
          </>
        }
      />

      {!d && dash.loading ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-[86px]" />
          ))}
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label={t('dashboard.sales')} value={money(d?.sales)} icon={<CircleDollarSign className="h-5 w-5" />} accent="red" />
            <StatCard label={t('dashboard.orders')} value={num(d?.orders_count, 0)} icon={<ShoppingBag className="h-5 w-5" />} accent="gold" />
            <StatCard label={t('dashboard.avg')} value={money(d?.avg_order)} icon={<TrendingUp className="h-5 w-5" />} accent="dim" />
            <StatCard label={t('dashboard.pending')} value={num(d?.pending, 0)} icon={<ClipboardList className="h-5 w-5" />} accent="gold" />
            <StatCard label={t('dashboard.completed')} value={num(d?.completed, 0)} icon={<ChefHat className="h-5 w-5" />} accent="green" />
            <StatCard label={t('dashboard.cancelled')} value={num(d?.cancelled, 0)} icon={<TrendingDown className="h-5 w-5" />} accent="red" />
            <StatCard label={t('dashboard.expenses')} value={money(d?.expenses)} icon={<Wallet className="h-5 w-5" />} accent="dim" />
            <StatCard label={t('dashboard.profit')} value={money(d?.profit_estimate)} icon={<Banknote className="h-5 w-5" />} accent="red" />
          </div>

          <div className="mt-3 grid gap-3 xl:grid-cols-3">
            <SectionCard
              title={t('dashboard.chart.sales')}
              subtitle={
                period === 'today' || period === 'yesterday'
                  ? t('dashboard.last7')
                  : period === 'week'
                    ? t('common.week')
                    : t('common.month')
              }
              className="xl:col-span-2"
              bodyClassName="p-3 pb-1"
            >
              {days.data && days.data.some((d) => Number(d.sales) > 0) ? (
                <ResponsiveContainer width="100%" height={264}>
                  <AreaChart data={days.data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="salesFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#E50E05" stopOpacity={0.35} />
                        <stop offset="100%" stopColor="#E50E05" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="#1F2023" vertical={false} />
                    <XAxis
                      dataKey="date"
                      tick={{ fill: '#6B7176', fontSize: 10 }}
                      tickLine={false}
                      axisLine={{ stroke: '#232428' }}
                      tickFormatter={(v: string) => v.slice(5).split('-').reverse().join('/')}
                    />
                    <YAxis
                      tick={{ fill: '#6B7176', fontSize: 10 }}
                      tickLine={false}
                      axisLine={false}
                      width={44}
                      tickFormatter={(v: number) => (v >= 1000 ? `${v / 1000}k` : String(v))}
                    />
                    <Tooltip
                      contentStyle={tooltipStyle}
                      labelFormatter={(v: string) => fmtDate(v)}
                      formatter={(v: number) => [money(v), t('dashboard.sales')]}
                    />
                    <Area type="monotone" dataKey="sales" stroke="#E50E05" strokeWidth={2.2} fill="url(#salesFill)" />
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <div className="grid h-[264px] place-items-center text-xs text-txt-faint">{t('dashboard.noSales')}</div>
              )}
            </SectionCard>

            <SectionCard title={t('dashboard.chart.methods')} bodyClassName="p-3">
              {methods.data && methods.data.length > 0 ? (
                <div className="flex items-center gap-2">
                  <div className="relative w-[55%]">
                    <ResponsiveContainer width="100%" height={230}>
                      <PieChart>
                        <Pie data={methods.data} dataKey="amount" nameKey="method" innerRadius={52} outerRadius={78} paddingAngle={3} stroke="none">
                          {methods.data.map((_, i) => (
                            <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                          ))}
                        </Pie>
                        <Tooltip
                          contentStyle={tooltipStyle}
                          formatter={(v: number, name: string) => [money(v), labelOf(PAYMENT_METHODS, String(name), 'ar')]}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                    <div className="pointer-events-none absolute inset-0 grid place-items-center">
                      <div className="text-center">
                        <div className="text-base font-black tabular-nums">{money(methodsTotal)}</div>
                        <div className="text-[10px] text-txt-faint">{t('dashboard.sales')}</div>
                      </div>
                    </div>
                  </div>
                  <div className="flex-1 space-y-2">
                    {methods.data.map((m, i) => (
                      <div key={m.method} className="flex items-center justify-between gap-2 text-[11px]">
                        <span className="flex items-center gap-1.5 text-txt-dim">
                          <span className="h-2 w-2 rounded-full" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />
                          {labelOf(PAYMENT_METHODS, m.method, 'ar')}
                        </span>
                        <span className="font-bold">{money(m.amount)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="grid h-[230px] place-items-center text-xs text-txt-faint">{t('common.empty')}</div>
              )}
            </SectionCard>
          </div>

          <div className="mt-3 grid gap-3 xl:grid-cols-3">
            <SectionCard title={t('dashboard.best')} bodyClassName="px-1 py-1">
              {d?.best_products && d.best_products.length > 0 ? (
                <ul className="divide-y divide-line/60">
                  {d.best_products.map((p, i) => (
                    <li key={p.name} className="flex items-center gap-3 px-4 py-2.5">
                      <span className="grid h-6 w-6 place-items-center rounded-md bg-white/[0.05] text-[10px] font-black text-brand-gold">
                        {i + 1}
                      </span>
                      <span className="flex-1 truncate text-xs font-semibold">{p.name}</span>
                      <span className="text-[11px] text-txt-faint">{p.qty} ×</span>
                      <span className="text-xs font-bold">{money(p.sales)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="grid h-32 place-items-center text-xs text-txt-faint">{t('common.empty')}</div>
              )}
            </SectionCard>

            <SectionCard
              title={t('dashboard.lowStock')}
              actions={
                <Link to="/inventory" className="flex items-center gap-1 text-[11px] font-bold text-brand-gold hover:underline">
                  {t('common.viewAll')}
                  <ArrowUpRight className="h-3 w-3" />
                </Link>
              }
              bodyClassName="px-1 py-1"
            >
              {d?.low_stock && d.low_stock.length > 0 ? (
                <ul className="divide-y divide-line/60">
                  {d.low_stock.map((ing) => (
                    <li key={ing.id} className="flex items-center gap-3 px-4 py-2.5">
                      <PackageSearch className="h-4 w-4 text-brand-redSoft" />
                      <span className="flex-1 truncate text-xs font-semibold">{ing.name}</span>
                      <span className="text-[11px] text-txt-faint">
                        {num(ing.quantity, 2)} / {num(ing.min_stock, 2)} {ing.unit}
                      </span>
                      <Badge color="#E50E05">{t('inventory.lowStock')}</Badge>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="grid h-32 place-items-center text-xs text-txt-faint">{t('common.empty')}</div>
              )}
            </SectionCard>

            <SectionCard
              title={t('dashboard.chart.types')}
              actions={
                <div className="flex items-center gap-1.5 text-[11px] text-txt-faint">
                  <Users className="h-3.5 w-3.5" />
                  {num(d?.active_staff, 0)} {t('dashboard.activeStaff')}
                </div>
              }
              bodyClassName="p-4"
            >
              <div className="space-y-3">
                {(types.data ?? []).map((row, i) => {
                  const total = (types.data ?? []).reduce((s, r) => s + Number(r.amount), 0) || 1
                  const width = Math.max(4, Math.round((Number(row.amount) / total) * 100))
                  return (
                    <div key={row.type}>
                      <div className="mb-1 flex items-center justify-between text-[11px]">
                        <span className="font-semibold text-txt-dim">{labelOf(ORDER_TYPES, row.type, 'ar')}</span>
                        <span className="font-bold">{money(row.amount)}</span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-ink-500">
                        <div
                          className="h-full rounded-full"
                          style={{ width: `${width}%`, background: PIE_COLORS[i % PIE_COLORS.length] }}
                        />
                      </div>
                    </div>
                  )
                })}
                {(!types.data || types.data.length === 0) && (
                  <div className="grid h-24 place-items-center text-xs text-txt-faint">{t('common.empty')}</div>
                )}
              </div>
            </SectionCard>
          </div>

          <p className="mt-3 text-[10px] text-txt-faint">{t('dashboard.estimateNote')}</p>
        </>
      )}
    </div>
  )
}
