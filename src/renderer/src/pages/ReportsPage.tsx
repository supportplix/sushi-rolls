import { useMemo, useState } from 'react'
import {
  BarChart3,
  CalendarRange,
  FileSpreadsheet,
  FileText,
  Printer,
  RefreshCw
} from 'lucide-react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts'
import { useDb } from '@/lib/auth'
import { useAsync } from '@/lib/hooks'
import { fmtDate, money, num, startOfMonth, toISODate } from '@/lib/format'
import { t } from '@/i18n'
import { ORDER_TYPES, PAYMENT_METHODS, labelOf } from '@/lib/constants'
import { cn } from '@/lib/cn'
import {
  Badge,
  Button,
  EmptyState,
  PageHeader,
  PageLoader,
  SectionCard,
  TableWrap,
  Tabs
} from '@/components/ui/primitives'
import { DatePicker } from '@/components/ui/datepicker'
import { useToast } from '@/components/ui/toast'
import { buildSimpleReportHtml, exportCsv, exportPdf, exportXlsx } from '@/lib/export'
import { logoDataUrl } from '@/lib/logo'

type Tab =
  | 'sales'
  | 'products'
  | 'profit'
  | 'expenses'
  | 'inventory'
  | 'cashiers'
  | 'customers'
  | 'payments'
  | 'types'

interface ReportData {
  title: string
  headers: string[]
  rows: (string | number)[][]
  cards?: { label: string; value: string }[]
  note?: string
  chart?: { date: string; sales: number; orders: number }[]
  empty?: { title: string; hint?: string }
}

const tooltipStyle = {
  background: 'rgba(15,16,19,0.96)',
  border: '1px solid rgba(255,255,255,0.09)',
  borderRadius: 14,
  fontSize: 12,
  color: '#F7F7F5',
  backdropFilter: 'blur(12px)'
}

export default function ReportsPage(): JSX.Element {
  const db = useDb()
  const toast = useToast()
  const [tab, setTab] = useState<Tab>('sales')
  const [from, setFrom] = useState(toISODate(startOfMonth()))
  const [to, setTo] = useState(toISODate(new Date()))

  const range = useMemo(
    () => ({
      fromISO: new Date(`${from}T00:00:00`).toISOString(),
      toISO: new Date(`${to}T23:59:59`).toISOString()
    }),
    [from, to]
  )

  const report = useAsync(async (): Promise<ReportData> => {
    if (tab === 'sales') {
      const [profit, days] = await Promise.all([
        db.rpc('report_profit', { p_from: range.fromISO, p_to: range.toISO }),
        db.rpc('report_sales_by_day', { p_from: from, p_to: to, p_tz: 'Africa/Cairo' })
      ])
      if (profit.error) throw profit.error
      if (days.error) throw days.error
      const p = profit.data as { gross_sales: number; net_sales: number; tax: number; discounts: number }
      const dayRows = (days.data ?? []) as { date: string; sales: number; orders: number }[]
      const orders = dayRows.reduce((s, d) => s + Number(d.orders), 0)
      const total = dayRows.reduce((s, d) => s + Number(d.sales), 0)
      return {
        title: t('reports.sales'),
        cards: [
          { label: t('reports.gross'), value: money(p.gross_sales) },
          { label: t('reports.net'), value: money(p.net_sales) },
          { label: t('reports.ordersCount'), value: num(orders, 0) },
          { label: t('dashboard.avg'), value: money(orders ? total / orders : 0) }
        ],
        headers: [t('common.date'), t('reports.ordersCount'), t('reports.periodSales')],
        rows: dayRows.map((d) => [fmtDate(d.date), num(d.orders, 0), money(d.sales)]),
        chart: dayRows,
        empty:
          orders === 0 && total === 0
            ? { title: t('reports.noData'), hint: t('reports.noDataHint') }
            : undefined
      }
    }

    if (tab === 'products') {
      const { data, error } = await db.rpc('report_products_sold', { p_from: range.fromISO, p_to: range.toISO })
      if (error) throw error
      const rows = (data ?? []) as { name: string; qty: number; sales: number; cost: number; profit: number }[]
      return {
        title: t('reports.products'),
        headers: [t('common.name'), t('reports.qty'), t('reports.salesCol'), t('reports.costCol'), t('reports.profitCol'), t('reports.margin')],
        rows: rows.map((r) => [
          r.name,
          num(r.qty, 0),
          money(r.sales),
          money(r.cost),
          money(r.profit),
          r.sales ? `${num((Number(r.profit) / Number(r.sales)) * 100, 1)}%` : '—'
        ])
      }
    }

    if (tab === 'profit') {
      const { data, error } = await db.rpc('report_profit', { p_from: range.fromISO, p_to: range.toISO })
      if (error) throw error
      const p = data as Record<string, number>
      const noActivity = [
        p.gross_sales,
        p.tax,
        p.net_sales,
        p.cogs,
        p.expenses,
        p.profit_estimate,
        p.discounts
      ].every((v) => Number(v) === 0)
      return {
        title: t('reports.profit'),
        note: t('reports.estimate'),
        cards: [
          { label: t('reports.gross'), value: money(p.gross_sales) },
          { label: t('reports.tax'), value: money(p.tax) },
          { label: t('reports.net'), value: money(p.net_sales) },
          { label: t('reports.cogs'), value: money(p.cogs) },
          { label: t('reports.opex'), value: money(p.expenses) },
          { label: t('reports.profitEstimate'), value: money(p.profit_estimate) }
        ],
        headers: [t('reports.titleField'), t('reports.valueCol')],
        rows: [
          [t('reports.gross'), money(p.gross_sales)],
          [t('reports.discounts'), money(p.discounts)],
          [t('reports.tax'), money(p.tax)],
          [t('reports.net'), money(p.net_sales)],
          [t('reports.cogs'), money(p.cogs)],
          [t('reports.opex'), money(p.expenses)],
          [t('reports.profitEstimate'), money(p.profit_estimate)]
        ],
        empty: noActivity ? { title: t('reports.noData'), hint: t('reports.noDataHint') } : undefined
      }
    }

    if (tab === 'expenses') {
      const { data, error } = await db.rpc('report_expenses_by_category', { p_from: from, p_to: to })
      if (error) throw error
      const rows = (data ?? []) as { category: string; amount: number; count: number }[]
      return {
        title: t('reports.expenses'),
        headers: [t('expenses.category'), t('reports.countCol'), t('common.amount')],
        rows: rows.map((r) => [r.category, num(r.count, 0), money(r.amount)])
      }
    }

    if (tab === 'inventory') {
      const { data, error } = await db.rpc('report_inventory_value')
      if (error) throw error
      const p = data as {
        total_value: number
        items_count: number
        low_stock_count: number
        expiring_count: number
        low_stock: { name: string; quantity: number; min_stock: number; unit: string }[]
      }
      const lowStock = p.low_stock ?? []
      return {
        title: t('reports.inventory'),
        cards: [
          { label: t('reports.stockValue'), value: money(p.total_value) },
          { label: t('inventory.ingredients'), value: num(p.items_count, 0) },
          { label: t('reports.lowStockCount'), value: num(p.low_stock_count, 0) },
          { label: t('reports.expiringCount'), value: num(p.expiring_count, 0) }
        ],
        headers: [t('inventory.name'), t('inventory.stock'), t('inventory.min'), t('inventory.unit')],
        rows: lowStock.map((r) => [r.name, num(r.quantity, 2), num(r.min_stock, 2), r.unit]),
        empty:
          Number(p.items_count) === 0
            ? { title: t('reports.inventoryEmpty'), hint: t('reports.inventoryEmptyHint') }
            : lowStock.length === 0
              ? { title: t('reports.noLowStock'), hint: t('reports.noLowStockHint') }
              : undefined
      }
    }

    if (tab === 'cashiers') {
      const { data, error } = await db.rpc('report_cashier_sales', { p_from: range.fromISO, p_to: range.toISO })
      if (error) throw error
      const rows = (data ?? []) as { cashier: string; amount: number; count: number }[]
      return {
        title: t('reports.cashiers'),
        headers: [t('common.cashier'), t('reports.ordersCount'), t('reports.periodSales')],
        rows: rows.map((r) => [r.cashier, num(r.count, 0), money(r.amount)])
      }
    }

    if (tab === 'customers') {
      const { data, error } = await db.rpc('report_customers', { p_limit: 50 })
      if (error) throw error
      const rows = (data ?? []) as { name: string; phone: string | null; orders: number; spending: number }[]
      return {
        title: t('reports.customers'),
        headers: [t('common.name'), t('common.phone'), t('reports.ordersCount'), t('customers.spending')],
        rows: rows.map((r) => [r.name, r.phone ?? '—', num(r.orders, 0), money(r.spending)]),
        empty:
          rows.length === 0
            ? { title: t('reports.customersEmpty'), hint: t('reports.customersEmptyHint') }
            : undefined
      }
    }

    if (tab === 'payments') {
      const { data, error } = await db.rpc('report_payment_methods', { p_from: range.fromISO, p_to: range.toISO })
      if (error) throw error
      const rows = (data ?? []) as { method: string; amount: number; count: number }[]
      return {
        title: t('reports.payments'),
        headers: [t('common.type'), t('reports.countCol'), t('common.amount')],
        rows: rows.map((r) => [labelOf(PAYMENT_METHODS, r.method, 'ar'), num(r.count, 0), money(r.amount)])
      }
    }

    const { data, error } = await db.rpc('report_order_types', { p_from: range.fromISO, p_to: range.toISO })
    if (error) throw error
    const rows = (data ?? []) as { type: string; amount: number; count: number }[]
    return {
      title: t('reports.orderTypes'),
      headers: [t('common.type'), t('reports.countCol'), t('common.amount')],
      rows: rows.map((r) => [labelOf(ORDER_TYPES, r.type, 'ar'), num(r.count, 0), money(r.amount)])
    }
  }, [db, tab, range.fromISO, range.toISO, from, to])

  const doExport = async (kind: 'csv' | 'xlsx' | 'pdf'): Promise<void> => {
    if (!report.data) return
    const name = `${report.data.title}-${from}_${to}`
    const subtitle = `${fmtDate(from)} — ${fmtDate(to)}`
    try {
      let ok = false
      if (kind === 'csv') ok = await exportCsv(name, report.data.headers, report.data.rows)
      else if (kind === 'xlsx') ok = await exportXlsx(name, report.data.title, report.data.headers, report.data.rows)
      else ok = await exportPdf(name, buildSimpleReportHtml(report.data.title, subtitle, report.data.headers, report.data.rows, await logoDataUrl()))
      if (ok) toast.success(t('reports.exported'))
    } catch {
      toast.error(t('common.error'))
    }
  }

  const tabs: { value: Tab; label: string }[] = [
    { value: 'sales', label: t('reports.sales') },
    { value: 'products', label: t('reports.products') },
    { value: 'profit', label: t('reports.profit') },
    { value: 'expenses', label: t('reports.expenses') },
    { value: 'inventory', label: t('reports.inventory') },
    { value: 'cashiers', label: t('reports.cashiers') },
    { value: 'customers', label: t('reports.customers') },
    { value: 'payments', label: t('reports.payments') },
    { value: 'types', label: t('reports.orderTypes') }
  ]

  const periodTab = tab !== 'inventory' && tab !== 'customers'
  const isEmpty = !!report.data && (!!report.data.empty || report.data.rows.length === 0)
  const emptyInfo = report.data?.empty ?? { title: t('reports.noData'), hint: t('reports.noDataHint') }
  const canExport = !!report.data && !report.loading && !isEmpty

  return (
    <div>
      <PageHeader
        title={t('reports.title')}
        actions={
          <>
            <Button size="sm" variant="ghost" icon={<FileText className="h-4 w-4" />} disabled={!canExport} onClick={() => void doExport('csv')}>
              CSV
            </Button>
            <Button size="sm" variant="ghost" icon={<FileSpreadsheet className="h-4 w-4" />} disabled={!canExport} onClick={() => void doExport('xlsx')}>
              Excel
            </Button>
            <Button size="sm" variant="ghost" icon={<Printer className="h-4 w-4" />} disabled={!canExport} onClick={() => void doExport('pdf')}>
              PDF
            </Button>
            <button
              type="button"
              onClick={() => void report.reload()}
              aria-label={t('common.refresh')}
              className="grid h-9 w-9 place-items-center rounded-lg border border-line bg-ink-800 text-txt-dim hover:text-txt"
            >
              <RefreshCw className={cn('h-4 w-4', report.loading && 'animate-spin')} />
            </button>
          </>
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="min-w-0 max-w-full overflow-x-auto no-scrollbar">
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={tabs}
            className="flex-nowrap [&>button]:px-2.5"
          />
        </div>
        {periodTab ? (
          <div className="ms-auto flex items-center gap-2 rounded-xl border border-white/[0.06] bg-white/[0.03] px-2 py-1.5">
            <span className="flex items-center gap-1.5 text-[10px] font-bold text-txt-faint">
              <CalendarRange className="h-3.5 w-3.5" />
              {t('reports.period')}
            </span>
            <DatePicker value={from} onChange={setFrom} className="w-36" />
            <span className="text-xs text-txt-faint">—</span>
            <DatePicker value={to} onChange={setTo} className="w-36" />
          </div>
        ) : (
          <span className="ms-auto rounded-full border border-white/[0.06] bg-white/[0.03] px-3 py-1.5 text-[10.5px] font-bold text-txt-faint">
            {tab === 'inventory' ? t('reports.snapshot') : t('reports.topCustomers')}
          </span>
        )}
      </div>

      {!report.loading && report.data?.cards && (
        <div
          className={cn(
            'mb-3 grid gap-3',
            report.data.cards.length > 4 ? 'grid-cols-2 md:grid-cols-3' : 'grid-cols-2 xl:grid-cols-4'
          )}
        >
          {report.data.cards.map((c) => (
            <div key={c.label} className="card relative overflow-hidden p-4">
              <div aria-hidden className="pointer-events-none absolute inset-x-5 top-0 h-px bg-gradient-to-l from-transparent via-white/15 to-transparent" />
              <div className="text-[10.5px] font-semibold text-txt-faint">{c.label}</div>
              <div className="mt-1 text-xl font-black tabular-nums tracking-tight">{c.value}</div>
            </div>
          ))}
        </div>
      )}

      <SectionCard
        title={tabs.find((x) => x.value === tab)?.label ?? t('reports.title')}
        actions={report.data?.note ? <Badge color="#E4BE54">{report.data.note}</Badge> : undefined}
        bodyClassName="p-0"
      >
        {report.loading ? (
          <PageLoader />
        ) : isEmpty ? (
          <EmptyState icon={<BarChart3 className="h-6 w-6" />} title={emptyInfo.title} hint={emptyInfo.hint} />
        ) : (
          <>
            {tab === 'sales' && report.data?.chart && report.data.chart.some((d) => Number(d.sales) > 0) && (
              <div className="border-b border-white/[0.06] px-3 pb-1 pt-4">
                <div className="mb-1 px-1 text-[11px] font-bold text-txt-dim">{t('reports.dailySales')}</div>
                <ResponsiveContainer width="100%" height={220}>
                  <AreaChart data={report.data.chart} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="reportSalesFill" x1="0" y1="0" x2="0" y2="1">
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
                      formatter={(v: number) => [money(v), t('reports.salesCol')]}
                    />
                    <Area type="monotone" dataKey="sales" stroke="#E50E05" strokeWidth={2.2} fill="url(#reportSalesFill)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}
            <TableWrap>
              <thead>
                <tr>
                  {report.data?.headers.map((h) => <th key={h}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {report.data?.rows.map((row, i) => (
                  <tr key={i}>
                    {row.map((cell, j) => (
                      <td key={j} className={j === 0 ? 'font-semibold' : 'text-xs'}>
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          </>
        )}
      </SectionCard>
    </div>
  )
}
