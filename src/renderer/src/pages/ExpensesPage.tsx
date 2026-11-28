import { useMemo, useState } from 'react'
import { Loader2, Pencil, Plus, ReceiptText, RefreshCw, Tags, Trash2, Wallet } from 'lucide-react'
import { useAuth, useDb } from '@/lib/auth'
import { useAsync } from '@/lib/hooks'
import { humanError } from '@/lib/errors'
import { fmtDate, money, num, parseNum, startOfMonth, toISODate } from '@/lib/format'
import type { Expense, ExpenseCategory } from '@/lib/types'
import { t } from '@/i18n'
import { PAYMENT_METHODS, labelOf } from '@/lib/constants'
import { cn } from '@/lib/cn'
import {
  Button,
  Field,
  PageHeader,
  PageLoader,
  RowMenu,
  SectionCard,
  Select,
  StatCard,
  TableWrap
} from '@/components/ui/primitives'
import { DatePicker } from '@/components/ui/datepicker'
import { Dialog, ConfirmDialog } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/toast'

export default function ExpensesPage(): JSX.Element {
  const db = useDb()
  const { can, profile } = useAuth()
  const toast = useToast()
  const manage = can('expenses.manage')
  const [from, setFrom] = useState(toISODate(startOfMonth()))
  const [to, setTo] = useState(toISODate(new Date()))
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ category_id: '', description: '', amount: '', expense_date: toISODate(new Date()), payment_method: 'cash' })
  const [saving, setSaving] = useState(false)
  const [catsOpen, setCatsOpen] = useState(false)
  const [newCat, setNewCat] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<Expense | null>(null)
  const [catDelete, setCatDelete] = useState<ExpenseCategory | null>(null)

  const list = useAsync(async () => {
    const { data, error } = await db
      .from('expenses')
      .select('*, expense_categories(name_ar)')
      .gte('expense_date', from)
      .lte('expense_date', to)
      .order('expense_date', { ascending: false })
    if (error) throw error
    return (data ?? []) as Expense[]
  }, [db, from, to])

  const cats = useAsync(async () => {
    const { data } = await db.from('expense_categories').select('*').order('name_ar')
    return (data ?? []) as ExpenseCategory[]
  }, [db])

  const total = useMemo(() => (list.data ?? []).reduce((s, e) => s + Number(e.amount), 0), [list.data])

  const save = async (): Promise<void> => {
    if (!form.description.trim() || parseNum(form.amount) <= 0) {
      toast.error(t('common.required'))
      return
    }
    setSaving(true)
    try {
      const { error } = await db.from('expenses').insert({
        category_id: form.category_id || null,
        description: form.description.trim(),
        amount: parseNum(form.amount),
        expense_date: form.expense_date,
        payment_method: form.payment_method,
        created_by: profile?.id ?? null
      })
      if (error) throw error
      toast.success(t('expenses.added'))
      setOpen(false)
      setForm({ category_id: '', description: '', amount: '', expense_date: toISODate(new Date()), payment_method: 'cash' })
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
        title={t('expenses.title')}
        actions={
          <>
            {manage && (
              <>
                <Button size="sm" variant="ghost" icon={<Tags className="h-4 w-4" />} onClick={() => setCatsOpen(true)}>
                  {t('expenses.categories')}
                </Button>
                <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setOpen(true)}>
                  {t('expenses.add')}
                </Button>
              </>
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

      <div className="mb-3 grid gap-3 md:grid-cols-[1fr_auto]">
        <div className="card flex flex-wrap items-center gap-3 p-3">
          <span className="text-[11px] font-semibold text-txt-faint">{t('common.range')}</span>
          <DatePicker value={from} onChange={setFrom} className="w-40" />
          <span className="text-txt-faint">—</span>
          <DatePicker value={to} onChange={setTo} className="w-40" />
        </div>
        <StatCard label={t('expenses.total')} value={money(total)} icon={<Wallet className="h-5 w-5" />} accent="red" />
      </div>

      <SectionCard bodyClassName="p-0">
        {list.loading && !list.data ? (
          <PageLoader />
        ) : (
          <TableWrap>
            <thead>
              <tr>
                <th>{t('expenses.description')}</th>
                <th>{t('expenses.category')}</th>
                <th>{t('common.amount')}</th>
                <th>{t('common.date')}</th>
                <th>{t('common.paymentMethod')}</th>
                <th className="w-10"></th>
              </tr>
            </thead>
            <tbody>
              {(list.data ?? []).map((e) => (
                <tr key={e.id}>
                  <td className="font-semibold">{e.description}</td>
                  <td className="text-xs text-txt-dim">{e.expense_categories?.name_ar ?? '—'}</td>
                  <td className="font-bold text-brand-redSoft">{money(e.amount)}</td>
                  <td className="text-[11px] text-txt-faint">{fmtDate(e.expense_date)}</td>
                  <td className="text-xs text-txt-dim">{labelOf(PAYMENT_METHODS, e.payment_method, 'ar')}</td>
                  <td>
                    {manage && (
                      <RowMenu
                        items={[
                          {
                            label: t('common.delete'),
                            icon: <Trash2 className="h-3.5 w-3.5" />,
                            danger: true,
                            onClick: () => setDeleteTarget(e)
                          }
                        ]}
                      />
                    )}
                  </td>
                </tr>
              ))}
              {(list.data ?? []).length === 0 && (
                <tr>
                  <td colSpan={6} className="py-10 text-center text-xs text-txt-faint">
                    {t('expenses.noExpenses')}
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
        title={t('expenses.add')}
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
          <Field label={t('expenses.description')} className="md:col-span-2">
            <input className="input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} autoFocus />
          </Field>
          <Field label={t('common.amount')}>
            <input className="input" inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} placeholder="0" />
          </Field>
          <Field label={t('expenses.category')}>
            <Select
              value={form.category_id}
              onChange={(v) => setForm({ ...form, category_id: v })}
              options={(cats.data ?? []).map((c) => ({ value: c.id, ar: c.name_ar }))}
              placeholder={t('common.none')}
            />
          </Field>
          <Field label={t('common.date')}>
            <DatePicker value={form.expense_date} onChange={(iso) => setForm({ ...form, expense_date: iso })} />
          </Field>
          <Field label={t('common.paymentMethod')}>
            <Select
              value={form.payment_method}
              onChange={(v) => setForm({ ...form, payment_method: v })}
              options={PAYMENT_METHODS}
            />
          </Field>
        </div>
      </Dialog>

      <Dialog
        open={catsOpen}
        onClose={() => setCatsOpen(false)}
        title={t('expenses.categories')}
        size="md"
      >
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <input
              className="input"
              placeholder={t('expenses.categoryName')}
              value={newCat}
              onChange={(e) => setNewCat(e.target.value)}
            />
            <Button
              size="sm"
              disabled={!newCat.trim()}
              onClick={async () => {
                try {
                  const { error } = await db.from('expense_categories').insert({ name_ar: newCat.trim() })
                  if (error) throw error
                  setNewCat('')
                  toast.success(t('expenses.categoryAdded'))
                  void cats.reload()
                } catch (err) {
                  toast.error(humanError(err))
                }
              }}
            >
              {t('common.add')}
            </Button>
          </div>
          <div className="space-y-1">
            {(cats.data ?? []).map((c) => (
              <div key={c.id} className="flex items-center justify-between rounded-lg border border-line px-3 py-2 text-xs">
                <span className="font-semibold">{c.name_ar}</span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="text-[10px] font-semibold text-txt-faint hover:text-txt"
                    onClick={async () => {
                      const { error } = await db.from('expense_categories').update({ is_active: !c.is_active }).eq('id', c.id)
                      if (error) toast.error(humanError(error))
                      void cats.reload()
                    }}
                  >
                    {c.is_active ? t('common.active') : t('common.inactive')}
                  </button>
                  {manage && (
                    <button
                      type="button"
                      aria-label={t('common.delete')}
                      className="grid h-6 w-6 place-items-center rounded-md text-txt-faint hover:bg-brand-red/10 hover:text-brand-redSoft"
                      onClick={() => setCatDelete(c)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </Dialog>

      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title={t('common.delete')}
        message={t('expenses.deleteConfirm')}
        confirmLabel={t('common.delete')}
        onConfirm={async () => {
          if (!deleteTarget) return
          try {
            const { error } = await db.from('expenses').delete().eq('id', deleteTarget.id)
            if (error) throw error
            toast.success(t('common.deleted'))
            setDeleteTarget(null)
            void list.reload()
          } catch (err) {
            toast.error(humanError(err))
          }
        }}
      />

      <ConfirmDialog
        open={!!catDelete}
        onClose={() => setCatDelete(null)}
        title={t('common.delete')}
        message={t('expenses.categoryDeleteConfirm')}
        confirmLabel={t('common.delete')}
        onConfirm={async () => {
          if (!catDelete) return
          try {
            const { error } = await db.from('expense_categories').delete().eq('id', catDelete.id)
            if (error) throw error
            toast.success(t('common.deleted'))
            setCatDelete(null)
            void cats.reload()
            void list.reload()
          } catch (err) {
            toast.error(humanError(err))
          }
        }}
      />
    </div>
  )
}
