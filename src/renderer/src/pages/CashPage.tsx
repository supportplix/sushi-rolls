import { useMemo, useState } from 'react'
import {
  ArrowDownLeft,
  ArrowUpRight,
  Banknote,
  CalendarClock,
  Lock,
  RefreshCw,
  Wallet
} from 'lucide-react'
import { useAuth, useDb } from '@/lib/auth'
import { useAsync } from '@/lib/hooks'
import { humanError } from '@/lib/errors'
import { fmtDateTime, money, num, parseNum } from '@/lib/format'
import type { CashShift, CashTransaction } from '@/lib/types'
import { t } from '@/i18n'
import { CASH_TX_TYPES, labelOf } from '@/lib/constants'
import { cn } from '@/lib/cn'
import {
  Badge,
  Button,
  Field,
  PageHeader,
  PageLoader,
  SectionCard,
  Select,
  StatCard,
  TableWrap
} from '@/components/ui/primitives'
import { Dialog } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/toast'
import { notifyShiftChanged } from '@/lib/shift'

export default function CashPage(): JSX.Element {
  const db = useDb()
  const { profile, can } = useAuth()
  const toast = useToast()
  const manage = can('cash.manage')
  const review = can('cash.review')

  const [openBalance, setOpenBalance] = useState('')
  const [openNote, setOpenNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [closeOpen, setCloseOpen] = useState(false)
  const [actual, setActual] = useState('')
  const [closeNote, setCloseNote] = useState('')
  const [adjustOpen, setAdjustOpen] = useState(false)
  const [adjType, setAdjType] = useState('withdrawal')
  const [adjAmount, setAdjAmount] = useState('')
  const [adjNote, setAdjNote] = useState('')
  const [detailShift, setDetailShift] = useState<CashShift | null>(null)

  const current = useAsync(async () => {
    if (!profile) return null
    const { data } = await db
      .from('cash_shifts')
      .select('*')
      .eq('user_id', profile.id)
      .eq('status', 'open')
      .maybeSingle()
    return (data ?? null) as CashShift | null
  }, [db, profile?.id])

  const tx = useAsync(async () => {
    if (!current.data) return [] as CashTransaction[]
    const { data } = await db
      .from('cash_transactions')
      .select('*')
      .eq('shift_id', current.data.id)
      .order('created_at', { ascending: false })
    return (data ?? []) as CashTransaction[]
  }, [db, current.data?.id])

  const shifts = useAsync(async () => {
    const { data, error } = await db
      .from('cash_shifts')
      .select('*, profiles:profiles(full_name)')
      .order('opened_at', { ascending: false })
      .limit(60)
    if (error) throw error
    return (data ?? []) as CashShift[]
  }, [db])

  const detailTx = useAsync(async () => {
    if (!detailShift) return [] as CashTransaction[]
    const { data } = await db
      .from('cash_transactions')
      .select('*')
      .eq('shift_id', detailShift.id)
      .order('created_at', { ascending: false })
    return (data ?? []) as CashTransaction[]
  }, [db, detailShift?.id])

  const expected = useMemo(() => {
    if (!current.data) return 0
    return (tx.data ?? []).reduce((s, tr) => s + Number(tr.amount), 0)
  }, [current.data, tx.data])

  const cashSales = useMemo(
    () => (tx.data ?? []).filter((tr) => tr.type === 'sale').reduce((s, tr) => s + Number(tr.amount), 0),
    [tx.data]
  )
  const withdrawals = useMemo(
    () => (tx.data ?? []).filter((tr) => tr.type === 'withdrawal').reduce((s, tr) => s + Math.abs(Number(tr.amount)), 0),
    [tx.data]
  )

  const reloadAll = (): void => {
    void current.reload()
    void tx.reload()
    void shifts.reload()
    notifyShiftChanged()
  }

  const openShift = async (): Promise<void> => {
    setBusy(true)
    try {
      const { error } = await db.rpc('open_shift', {
        p_opening_balance: parseNum(openBalance),
        p_note: openNote.trim() || null
      })
      if (error) throw error
      toast.success(t('cash.opened'))
      setOpenBalance('')
      setOpenNote('')
      reloadAll()
    } catch (err) {
      toast.error(humanError(err))
    } finally {
      setBusy(false)
    }
  }

  const closeShift = async (): Promise<void> => {
    setBusy(true)
    try {
      const { error } = await db.rpc('close_shift', {
        p_actual: parseNum(actual),
        p_note: closeNote.trim() || null
      })
      if (error) throw error
      toast.success(t('cash.shiftClosed'))
      setCloseOpen(false)
      setActual('')
      setCloseNote('')
      reloadAll()
    } catch (err) {
      toast.error(humanError(err))
    } finally {
      setBusy(false)
    }
  }

  const adjust = async (): Promise<void> => {
    setBusy(true)
    try {
      const { error } = await db.rpc('cash_adjust', {
        p_type: adjType,
        p_amount: parseNum(adjAmount),
        p_note: adjNote.trim() || null
      })
      if (error) throw error
      toast.success(t('cash.added'))
      setAdjustOpen(false)
      setAdjAmount('')
      setAdjNote('')
      void tx.reload()
      void current.reload()
    } catch (err) {
      toast.error(humanError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <PageHeader
        title={t('cash.title')}
        actions={
          <>
            {manage && current.data && (
              <>
                <Button size="sm" variant="ghost" icon={<ArrowDownLeft className="h-4 w-4" />} onClick={() => { setAdjType('addition'); setAdjustOpen(true) }}>
                  {t('cash.addCash')}
                </Button>
                <Button size="sm" variant="ghost" icon={<ArrowUpRight className="h-4 w-4" />} onClick={() => { setAdjType('withdrawal'); setAdjustOpen(true) }}>
                  {t('cash.withdraw')}
                </Button>
                <Button size="sm" variant="danger" icon={<Lock className="h-4 w-4" />} onClick={() => { setActual(''); setCloseNote(''); setCloseOpen(true) }}>
                  {t('cash.closeShift')}
                </Button>
              </>
            )}
            <button
              type="button"
              onClick={reloadAll}
              aria-label={t('common.refresh')}
              className="grid h-9 w-9 place-items-center rounded-lg border border-line bg-ink-800 text-txt-dim hover:text-txt"
            >
              <RefreshCw className={cn('h-4 w-4', current.loading && 'animate-spin')} />
            </button>
          </>
        }
      />

      {current.loading && !current.data ? (
        <PageLoader />
      ) : current.data ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label={t('cash.opening')} value={money(current.data.opening_balance)} icon={<Wallet className="h-5 w-5" />} accent="gold" />
            <StatCard label={t('cash.totalSales')} value={money(cashSales)} icon={<Banknote className="h-5 w-5" />} accent="green" />
            <StatCard label={t('cash.expected')} value={money(expected)} icon={<CalendarClock className="h-5 w-5" />} accent="red" />
            <StatCard label={t('cash.withdraw')} value={money(withdrawals)} icon={<ArrowUpRight className="h-5 w-5" />} accent="dim" />
          </div>

          <SectionCard className="mt-3" title={t('cash.tx')} bodyClassName="p-0">
            <TableWrap>
              <thead>
                <tr>
                  <th>{t('common.time')}</th>
                  <th>{t('common.type')}</th>
                  <th>{t('common.amount')}</th>
                  <th>{t('common.notes')}</th>
                </tr>
              </thead>
              <tbody>
                {(tx.data ?? []).map((tr) => (
                  <tr key={tr.id}>
                    <td className="text-[11px] text-txt-faint">{fmtDateTime(tr.created_at)}</td>
                    <td>
                      <Badge>{labelOf(CASH_TX_TYPES, tr.type, 'ar')}</Badge>
                    </td>
                    <td className={cn('font-black', Number(tr.amount) >= 0 ? 'text-emerald-400' : 'text-brand-redSoft')}>
                      {money(tr.amount)}
                    </td>
                    <td className="text-xs text-txt-dim">{tr.note ?? '—'}</td>
                  </tr>
                ))}
                {(tx.data ?? []).length === 0 && (
                  <tr>
                    <td colSpan={4} className="py-8 text-center text-xs text-txt-faint">{t('cash.noTx')}</td>
                  </tr>
                )}
              </tbody>
            </TableWrap>
          </SectionCard>
        </>
      ) : manage ? (
        <div className="card mx-auto max-w-md p-6">
          <h2 className="text-sm font-bold">{t('cash.openShift')}</h2>
          <p className="mt-1 text-[11px] text-txt-faint">{t('cash.noShift')}</p>
          <div className="mt-4 space-y-3">
            <Field label={t('cash.openingBalance')}>
              <input className="input" inputMode="decimal" value={openBalance} onChange={(e) => setOpenBalance(e.target.value)} placeholder="0" />
            </Field>
            <Field label={t('cash.note')}>
              <input className="input" value={openNote} onChange={(e) => setOpenNote(e.target.value)} />
            </Field>
            <Button className="w-full" disabled={busy} onClick={() => void openShift()}>
              {t('cash.openShift')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="card p-6 text-center text-xs text-txt-faint">{t('cash.noShift')}</div>
      )}

      <SectionCard className="mt-3" title={t('cash.history')} bodyClassName="p-0">
        <TableWrap>
          <thead>
            <tr>
              <th>{t('cash.cashier')}</th>
              <th>{t('cash.openSince')}</th>
              <th>{t('cash.closing')}</th>
              <th>{t('cash.expected')}</th>
              <th>{t('common.amount')}</th>
              <th>{t('cash.difference')}</th>
              <th>{t('common.status')}</th>
            </tr>
          </thead>
          <tbody>
            {(shifts.data ?? []).map((s) => (
              <tr key={s.id} className="cursor-pointer" onClick={() => setDetailShift(s)}>
                <td className="font-semibold">{s.profiles?.full_name ?? '—'}</td>
                <td className="text-[11px] text-txt-faint">{fmtDateTime(s.opened_at)}</td>
                <td className="text-xs">{s.closing_balance != null ? money(s.closing_balance) : '—'}</td>
                <td className="text-xs">{s.expected_balance != null ? money(s.expected_balance) : '—'}</td>
                <td className="font-bold">{money(s.total_sales)}</td>
                <td className={cn('text-xs font-bold', Number(s.difference ?? 0) < 0 ? 'text-brand-redSoft' : 'text-emerald-400')}>
                  {s.difference != null ? money(s.difference) : '—'}
                </td>
                <td>
                  <Badge color={s.status === 'open' ? '#3DBE7A' : '#6B7176'}>
                    {s.status === 'open' ? t('shift.open') : t('shift.closed')}
                  </Badge>
                </td>
              </tr>
            ))}
            {(shifts.data ?? []).length === 0 && (
              <tr>
                <td colSpan={7} className="py-8 text-center text-xs text-txt-faint">{t('common.empty')}</td>
              </tr>
            )}
          </tbody>
        </TableWrap>
      </SectionCard>

      <Dialog
        open={closeOpen}
        onClose={() => setCloseOpen(false)}
        title={t('cash.closeShift')}
        subtitle={`${t('cash.expected')}: ${money(expected)}`}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setCloseOpen(false)}>{t('common.cancel')}</Button>
            <Button variant="danger" disabled={busy} onClick={() => void closeShift()}>
              {t('common.confirm')}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label={t('cash.actual')}>
            <input autoFocus className="input" inputMode="decimal" value={actual} onChange={(e) => setActual(e.target.value)} placeholder="0" />
          </Field>
          {actual.trim() && (
            <p className={cn('text-[11px] font-bold', parseNum(actual) >= expected ? 'text-emerald-400' : 'text-brand-redSoft')}>
              {t('cash.difference')}: {money(parseNum(actual) - expected)}
            </p>
          )}
          <Field label={t('cash.note')}>
            <input className="input" value={closeNote} onChange={(e) => setCloseNote(e.target.value)} />
          </Field>
        </div>
      </Dialog>

      <Dialog
        open={adjustOpen}
        onClose={() => setAdjustOpen(false)}
        title={adjType === 'addition' ? t('cash.addCash') : t('cash.withdraw')}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setAdjustOpen(false)}>{t('common.cancel')}</Button>
            <Button disabled={busy || !parseNum(adjAmount)} onClick={() => void adjust()}>
              {t('common.confirm')}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label={t('common.type')}>
            <Select
              value={adjType}
              onChange={setAdjType}
              options={[
                { value: 'addition', ar: t('cash.addCash') },
                { value: 'withdrawal', ar: t('cash.withdraw') }
              ]}
            />
          </Field>
          <Field label={t('common.amount')}>
            <input autoFocus className="input" inputMode="decimal" value={adjAmount} onChange={(e) => setAdjAmount(e.target.value)} placeholder="0" />
          </Field>
          <Field label={t('cash.note')}>
            <input className="input" value={adjNote} onChange={(e) => setAdjNote(e.target.value)} />
          </Field>
        </div>
      </Dialog>

      <Dialog
        open={!!detailShift}
        onClose={() => setDetailShift(null)}
        title={`${t('cash.tx')} · ${detailShift?.profiles?.full_name ?? ''}`}
        subtitle={detailShift ? `${fmtDateTime(detailShift.opened_at)} — ${detailShift.closed_at ? fmtDateTime(detailShift.closed_at) : t('shift.open')}` : undefined}
        size="md"
      >
        {detailTx.loading ? (
          <PageLoader />
        ) : (
          <TableWrap>
            <thead>
              <tr>
                <th>{t('common.time')}</th>
                <th>{t('common.type')}</th>
                <th>{t('common.amount')}</th>
                <th>{t('common.notes')}</th>
              </tr>
            </thead>
            <tbody>
              {(detailTx.data ?? []).map((tr) => (
                <tr key={tr.id}>
                  <td className="text-[11px] text-txt-faint">{fmtDateTime(tr.created_at)}</td>
                  <td><Badge>{labelOf(CASH_TX_TYPES, tr.type, 'ar')}</Badge></td>
                  <td className={cn('font-black', Number(tr.amount) >= 0 ? 'text-emerald-400' : 'text-brand-redSoft')}>
                    {money(tr.amount)}
                  </td>
                  <td className="text-xs text-txt-dim">{tr.note ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
        {detailShift && (
          <div className="mt-3 grid grid-cols-3 gap-2 text-center text-[11px]">
            <div className="rounded-lg bg-ink-800/60 p-2">
              <div className="text-txt-faint">{t('cash.opening')}</div>
              <div className="font-black">{money(detailShift.opening_balance)}</div>
            </div>
            <div className="rounded-lg bg-ink-800/60 p-2">
              <div className="text-txt-faint">{t('cash.expected')}</div>
              <div className="font-black">{money(detailShift.expected_balance ?? 0)}</div>
            </div>
            <div className="rounded-lg bg-ink-800/60 p-2">
              <div className="text-txt-faint">{t('cash.difference')}</div>
              <div className={cn('font-black', Number(detailShift.difference ?? 0) < 0 ? 'text-brand-redSoft' : 'text-emerald-400')}>
                {money(detailShift.difference ?? 0)}
              </div>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  )
}
