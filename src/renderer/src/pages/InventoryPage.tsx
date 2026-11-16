import { useMemo, useState } from 'react'
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Boxes,
  CircleAlert,
  History,
  Loader2,
  PackagePlus,
  Pencil,
  Plus,
  RefreshCw,
  Trash2
} from 'lucide-react'
import { useDb, useAuth } from '@/lib/auth'
import { useAsync } from '@/lib/hooks'
import { humanError } from '@/lib/errors'
import { fmtDateTime, money, num, parseNum, toISODate } from '@/lib/format'
import type { Ingredient, Supplier } from '@/lib/types'
import { t } from '@/i18n'
import { labelOf, STOCK_TYPES } from '@/lib/constants'
import { cn } from '@/lib/cn'
import {
  Badge,
  Button,
  Field,
  PageHeader,
  PageLoader,
  RowMenu,
  SearchInput,
  SectionCard,
  Select,
  StatCard,
  TableWrap,
  Tabs
} from '@/components/ui/primitives'
import { Dialog, ConfirmDialog } from '@/components/ui/dialog'
import { DatePicker } from '@/components/ui/datepicker'
import { useToast } from '@/components/ui/toast'

interface IngredientForm {
  id?: string
  name_ar: string
  sku: string
  category: string
  unit: string
  min_stock: string
  purchase_cost: string
  supplier_id: string
  expiry_date: string | null
  storage_location: string
  initial_qty: string
}

const emptyForm: IngredientForm = {
  name_ar: '',
  sku: '',
  category: '',
  unit: 'كجم',
  min_stock: '',
  purchase_cost: '',
  supplier_id: '',
  expiry_date: null,
  storage_location: '',
  initial_qty: ''
}

const MANUAL_TYPES = STOCK_TYPES.filter((s) => !['sale', 'purchase', 'reversal'].includes(s.value))

export default function InventoryPage(): JSX.Element {
  const db = useDb()
  const { can } = useAuth()
  const toast = useToast()
  const manage = can('inventory.manage')
  const [tab, setTab] = useState<'ingredients' | 'movements'>('ingredients')
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<IngredientForm>(emptyForm)
  const [saving, setSaving] = useState(false)
  const [adjustTarget, setAdjustTarget] = useState<Ingredient | null>(null)
  const [adjType, setAdjType] = useState('in')
  const [adjQty, setAdjQty] = useState('')
  const [adjNote, setAdjNote] = useState('')
  const [adjCost, setAdjCost] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<Ingredient | null>(null)

  const list = useAsync(async () => {
    const { data, error } = await db.from('ingredients').select('*').order('name_ar')
    if (error) throw error
    return (data ?? []) as Ingredient[]
  }, [db])

  const movements = useAsync(async () => {
    const { data, error } = await db
      .from('stock_movements')
      .select('*, ingredients(name_ar, unit)')
      .order('created_at', { ascending: false })
      .limit(120)
    if (error) throw error
    return (data ?? []) as {
      id: number
      delta: number
      type: string
      note: string | null
      created_at: string
      unit_cost: number | null
      ingredients: { name_ar: string; unit: string } | null
    }[]
  }, [db])

  const suppliers = useAsync(async () => {
    const { data } = await db.from('suppliers').select('id, name').order('name')
    return (data ?? []) as Pick<Supplier, 'id' | 'name'>[]
  }, [db])

  const stats = useMemo(() => {
    const items = list.data ?? []
    const value = items.reduce((s, i) => s + Number(i.quantity) * Number(i.purchase_cost), 0)
    const low = items.filter((i) => Number(i.quantity) <= Number(i.min_stock)).length
    const soon = new Date()
    soon.setDate(soon.getDate() + 7)
    const expiring = items.filter((i) => i.expiry_date && new Date(i.expiry_date) <= soon).length
    return { value, low, expiring, count: items.length }
  }, [list.data])

  const filtered = (list.data ?? []).filter(
    (i) =>
      !search ||
      i.name_ar.includes(search) ||
      (i.sku ?? '').toLowerCase().includes(search.toLowerCase()) ||
      (i.category ?? '').includes(search)
  )

  const save = async (): Promise<void> => {
    if (!form.name_ar.trim()) return
    setSaving(true)
    try {
      const payload = {
        name_ar: form.name_ar.trim(),
        sku: form.sku.trim() || null,
        category: form.category.trim() || null,
        unit: form.unit.trim() || 'كجم',
        min_stock: parseNum(form.min_stock),
        purchase_cost: parseNum(form.purchase_cost),
        supplier_id: form.supplier_id || null,
        expiry_date: form.expiry_date || null,
        storage_location: form.storage_location.trim() || null
      }
      let id = form.id
      if (id) {
        const { error } = await db.from('ingredients').update(payload).eq('id', id)
        if (error) throw error
      } else {
        const { data, error } = await db.from('ingredients').insert({ ...payload, quantity: 0 }).select('id').single()
        if (error) throw error
        id = data.id
        const initial = parseNum(form.initial_qty)
        if (initial > 0 && id) {
          const { error: adjErr } = await db.rpc('adjust_stock', {
            p_ingredient: id,
            p_delta: initial,
            p_type: 'in',
            p_note: 'رصيد افتتاحي',
            p_unit_cost: parseNum(form.purchase_cost) || null
          })
          if (adjErr) throw adjErr
        }
      }
      toast.success(t('inventory.added'))
      setOpen(false)
      void list.reload()
      void movements.reload()
    } catch (err) {
      toast.error(humanError(err))
    } finally {
      setSaving(false)
    }
  }

  const applyAdjust = async (): Promise<void> => {
    if (!adjustTarget) return
    const qty = parseNum(adjQty)
    if (qty === 0) return
    const signed = adjType === 'adjustment' ? qty : adjType === 'in' ? Math.abs(qty) : -Math.abs(qty)
    try {
      const { error } = await db.rpc('adjust_stock', {
        p_ingredient: adjustTarget.id,
        p_delta: signed,
        p_type: adjType,
        p_note: adjNote.trim() || null,
        p_unit_cost: parseNum(adjCost) || null
      })
      if (error) throw error
      toast.success(t('inventory.adjusted'))
      setAdjustTarget(null)
      setAdjQty('')
      setAdjNote('')
      setAdjCost('')
      void list.reload()
      void movements.reload()
    } catch (err) {
      toast.error(humanError(err))
    }
  }

  return (
    <div>
      <PageHeader
        title={t('inventory.title')}
        actions={
          <>
            <Tabs
              value={tab}
              onChange={setTab}
              tabs={[
                { value: 'ingredients', label: t('inventory.ingredients'), icon: <Boxes className="h-3.5 w-3.5" /> },
                { value: 'movements', label: t('inventory.movements'), icon: <History className="h-3.5 w-3.5" /> }
              ]}
            />
            {manage && (
              <Button
                size="sm"
                icon={<Plus className="h-4 w-4" />}
                onClick={() => {
                  setForm(emptyForm)
                  setOpen(true)
                }}
              >
                {t('inventory.addIngredient')}
              </Button>
            )}
            <button
              type="button"
              onClick={() => {
                void list.reload()
                void movements.reload()
              }}
              aria-label={t('common.refresh')}
              className="grid h-9 w-9 place-items-center rounded-lg border border-line bg-ink-800 text-txt-dim hover:text-txt"
            >
              <RefreshCw className={cn('h-4 w-4', list.loading && 'animate-spin')} />
            </button>
          </>
        }
      />

      <div className="mb-3 grid gap-3 sm:grid-cols-3">
        <StatCard label={t('inventory.value')} value={money(stats.value)} icon={<Boxes className="h-5 w-5" />} accent="gold" />
        <StatCard label={t('inventory.lowStock')} value={num(stats.low, 0)} icon={<CircleAlert className="h-5 w-5" />} accent="red" />
        <StatCard label={t('inventory.expiring')} value={num(stats.expiring, 0)} icon={<ArrowDownToLine className="h-5 w-5" />} accent="dim" />
      </div>

      {tab === 'ingredients' && (
        <SectionCard bodyClassName="p-0">
          <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
            <SearchInput value={search} onChange={setSearch} placeholder={t('inventory.search')} className="w-72 max-w-full" />
            <span className="text-[11px] text-txt-faint">{num(filtered.length, 0)} مكون</span>
          </div>
          {list.loading && !list.data ? (
            <PageLoader />
          ) : (
            <TableWrap>
              <thead>
                <tr>
                  <th>{t('inventory.name')}</th>
                  <th>{t('common.category')}</th>
                  <th>{t('inventory.stock')}</th>
                  <th>{t('inventory.min')}</th>
                  <th>{t('inventory.unitCost')}</th>
                  <th>{t('common.supplier')}</th>
                  <th>{t('inventory.expiry')}</th>
                  <th className="w-10"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((ing) => {
                  const low = Number(ing.quantity) <= Number(ing.min_stock)
                  const soon = ing.expiry_date && new Date(ing.expiry_date) <= new Date(Date.now() + 7 * 86400000)
                  return (
                    <tr key={ing.id} className={cn(low && 'bg-brand-red/[0.035]')}>
                      <td>
                        <div className="font-semibold">{ing.name_ar}</div>
                        <div className="text-[10px] text-txt-faint">{ing.sku ?? ''}</div>
                      </td>
                      <td className="text-xs text-txt-dim">{ing.category ?? '—'}</td>
                      <td>
                        <div className="flex items-center gap-2">
                          <span className={cn('font-black', low ? 'text-brand-redSoft' : 'text-txt')}>
                            {num(ing.quantity, 2)}
                          </span>
                          <span className="text-[10px] text-txt-faint">{ing.unit}</span>
                        </div>
                        <div className="mt-1 h-1 w-24 overflow-hidden rounded-full bg-ink-500">
                          <div
                            className={cn('h-full rounded-full', low ? 'bg-brand-red' : 'bg-emerald-500')}
                            style={{
                              width: `${Math.min(100, Math.max(3, (Number(ing.quantity) / Math.max(Number(ing.min_stock) * 2, 0.001)) * 100))}%`
                            }}
                          />
                        </div>
                      </td>
                      <td className="text-xs text-txt-dim">{num(ing.min_stock, 2)}</td>
                      <td className="text-xs">{money(ing.purchase_cost)}</td>
                      <td className="text-xs text-txt-dim">
                        {suppliers.data?.find((s) => s.id === ing.supplier_id)?.name ?? '—'}
                      </td>
                      <td>
                        {ing.expiry_date ? (
                          <span className={cn('text-[11px]', soon ? 'font-bold text-brand-redSoft' : 'text-txt-dim')}>
                            {ing.expiry_date}
                          </span>
                        ) : (
                          <span className="text-[11px] text-txt-faint">—</span>
                        )}
                      </td>
                      <td>
                        {manage && (
                          <RowMenu
                            items={[
                              {
                                label: t('inventory.adjust'),
                                icon: <ArrowUpFromLine className="h-3.5 w-3.5" />,
                                onClick: () => {
                                  setAdjustTarget(ing)
                                  setAdjType('in')
                                  setAdjQty('')
                                  setAdjNote('')
                                  setAdjCost('')
                                }
                              },
                              {
                                label: t('common.edit'),
                                icon: <Pencil className="h-3.5 w-3.5" />,
                                onClick: () => {
                                  setForm({
                                    id: ing.id,
                                    name_ar: ing.name_ar,
                                    sku: ing.sku ?? '',
                                    category: ing.category ?? '',
                                    unit: ing.unit,
                                    min_stock: String(ing.min_stock ?? ''),
                                    purchase_cost: String(ing.purchase_cost ?? ''),
                                    supplier_id: ing.supplier_id ?? '',
                                    expiry_date: ing.expiry_date,
                                    storage_location: ing.storage_location ?? '',
                                    initial_qty: ''
                                  })
                                  setOpen(true)
                                }
                              },
                              {
                                label: t('common.delete'),
                                icon: <Trash2 className="h-3.5 w-3.5" />,
                                danger: true,
                                onClick: () => setDeleteTarget(ing)
                              }
                            ]}
                          />
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </TableWrap>
          )}
        </SectionCard>
      )}

      {tab === 'movements' && (
        <SectionCard bodyClassName="p-0">
          {movements.loading && !movements.data ? (
            <PageLoader />
          ) : (
            <TableWrap>
              <thead>
                <tr>
                  <th>{t('common.date')}</th>
                  <th>{t('inventory.name')}</th>
                  <th>{t('inventory.adjustType')}</th>
                  <th>{t('inventory.delta')}</th>
                  <th>{t('common.notes')}</th>
                </tr>
              </thead>
              <tbody>
                {(movements.data ?? []).map((m) => (
                  <tr key={m.id}>
                    <td className="text-[11px] text-txt-faint">{fmtDateTime(m.created_at)}</td>
                    <td className="font-semibold">{m.ingredients?.name_ar ?? '—'}</td>
                    <td>
                      <Badge>{labelOf(STOCK_TYPES, m.type, 'ar')}</Badge>
                    </td>
                    <td>
                      <span className={cn('font-black', Number(m.delta) >= 0 ? 'text-emerald-400' : 'text-brand-redSoft')}>
                        {Number(m.delta) > 0 ? '+' : ''}
                        {num(m.delta, 3)} {m.ingredients?.unit ?? ''}
                      </span>
                    </td>
                    <td className="max-w-[280px] truncate text-xs text-txt-dim">{m.note ?? '—'}</td>
                  </tr>
                ))}
                {(movements.data ?? []).length === 0 && (
                  <tr>
                    <td colSpan={5} className="py-10 text-center text-xs text-txt-faint">
                      {t('inventory.noMovements')}
                    </td>
                  </tr>
                )}
              </tbody>
            </TableWrap>
          )}
        </SectionCard>
      )}

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={form.id ? t('common.edit') : t('inventory.addIngredient')}
        size="lg"
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
          <Field label={t('inventory.name')}>
            <input className="input" value={form.name_ar} onChange={(e) => setForm({ ...form, name_ar: e.target.value })} autoFocus />
          </Field>
          <Field label={t('inventory.sku')}>
            <input className="input" value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} />
          </Field>
          <Field label={t('common.category')}>
            <input className="input" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
          </Field>
          <Field label={t('inventory.unit')}>
            <input className="input" value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} />
          </Field>
          <Field label={t('inventory.min')}>
            <input className="input" inputMode="decimal" value={form.min_stock} onChange={(e) => setForm({ ...form, min_stock: e.target.value })} placeholder="0" />
          </Field>
          <Field label={t('inventory.unitCost')}>
            <input className="input" inputMode="decimal" value={form.purchase_cost} onChange={(e) => setForm({ ...form, purchase_cost: e.target.value })} placeholder="0" />
          </Field>
          {!form.id && (
            <Field label="رصيد افتتاحي">
              <input className="input" inputMode="decimal" value={form.initial_qty} onChange={(e) => setForm({ ...form, initial_qty: e.target.value })} placeholder="0" />
            </Field>
          )}
          <Field label={t('common.supplier')}>
            <Select
              value={form.supplier_id}
              onChange={(v) => setForm({ ...form, supplier_id: v })}
              options={(suppliers.data ?? []).map((s) => ({ value: s.id, ar: s.name }))}
              placeholder={t('common.none')}
            />
          </Field>
          <Field label={t('inventory.expiry')}>
            <DatePicker value={form.expiry_date} onChange={(iso) => setForm({ ...form, expiry_date: iso })} />
          </Field>
          <Field label={t('inventory.location')}>
            <input className="input" value={form.storage_location} onChange={(e) => setForm({ ...form, storage_location: e.target.value })} />
          </Field>
        </div>
      </Dialog>

      <Dialog
        open={!!adjustTarget}
        onClose={() => setAdjustTarget(null)}
        title={`${t('inventory.adjust')} · ${adjustTarget?.name_ar ?? ''}`}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setAdjustTarget(null)}>{t('common.cancel')}</Button>
            <Button onClick={() => void applyAdjust()} disabled={!parseNum(adjQty)}>
              {t('common.confirm')}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label={t('inventory.adjustType')}>
            <Select
              value={adjType}
              onChange={setAdjType}
              options={MANUAL_TYPES.map((s) => ({ value: s.value, ar: s.ar }))}
            />
          </Field>
          <Field
            label={t('inventory.adjustQty')}
            hint={adjType === 'adjustment' ? 'موجب لزيادة الرصيد، سالب لنقصه' : undefined}
          >
            <input className="input" inputMode="decimal" value={adjQty} onChange={(e) => setAdjQty(e.target.value)} placeholder="0" autoFocus />
          </Field>
          <Field label={t('inventory.adjustNote')}>
            <input className="input" value={adjNote} onChange={(e) => setAdjNote(e.target.value)} />
          </Field>
          <Field label={t('inventory.unitCost')}>
            <input className="input" inputMode="decimal" value={adjCost} onChange={(e) => setAdjCost(e.target.value)} placeholder="0" />
          </Field>
        </div>
      </Dialog>

      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title={t('common.delete')}
        message={t('inventory.deleteConfirm')}
        confirmLabel={t('common.delete')}
        onConfirm={async () => {
          if (!deleteTarget) return
          try {
            const { error } = await db.from('ingredients').delete().eq('id', deleteTarget.id)
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
