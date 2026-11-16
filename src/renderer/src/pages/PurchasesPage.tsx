import { useMemo, useState } from 'react'
import { CheckCheck, ClipboardList, Eye, Loader2, Plus, RefreshCw, Trash2, XCircle } from 'lucide-react'
import { useAuth, useDb } from '@/lib/auth'
import { useAsync } from '@/lib/hooks'
import { humanError } from '@/lib/errors'
import { fmtDateTime, money, num, parseNum } from '@/lib/format'
import type { Ingredient, PurchaseOrder, Supplier } from '@/lib/types'
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
  Select,
  TableWrap
} from '@/components/ui/primitives'
import { Dialog, ConfirmDialog } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/toast'

interface Line {
  ingredient_id: string
  quantity: string
  unit_cost: string
}

export default function PurchasesPage(): JSX.Element {
  const db = useDb()
  const { can, profile } = useAuth()
  const toast = useToast()
  const manage = can('purchases.manage')
  const [open, setOpen] = useState(false)
  const [supplierId, setSupplierId] = useState('')
  const [lines, setLines] = useState<Line[]>([{ ingredient_id: '', quantity: '', unit_cost: '' }])
  const [paid, setPaid] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [viewTarget, setViewTarget] = useState<PurchaseOrder | null>(null)
  const [receiveTarget, setReceiveTarget] = useState<PurchaseOrder | null>(null)
  const [cancelTarget, setCancelTarget] = useState<PurchaseOrder | null>(null)

  const list = useAsync(async () => {
    const { data, error } = await db
      .from('purchase_orders')
      .select('*, suppliers(name), purchase_order_items(*)')
      .order('created_at', { ascending: false })
      .limit(200)
    if (error) throw error
    return (data ?? []) as unknown as PurchaseOrder[]
  }, [db])

  const ingredients = useAsync(async () => {
    const { data } = await db.from('ingredients').select('*').eq('is_active', true).order('name_ar')
    return (data ?? []) as Ingredient[]
  }, [db])

  const suppliers = useAsync(async () => {
    const { data } = await db.from('suppliers').select('id, name, balance').order('name')
    return (data ?? []) as Pick<Supplier, 'id' | 'name' | 'balance'>[]
  }, [db])

  const total = useMemo(
    () => lines.reduce((s, l) => s + parseNum(l.quantity) * parseNum(l.unit_cost), 0),
    [lines]
  )

  const save = async (): Promise<void> => {
    const validLines = lines.filter((l) => l.ingredient_id && parseNum(l.quantity) > 0)
    if (!supplierId || validLines.length === 0) {
      toast.error(t('common.required'))
      return
    }
    setSaving(true)
    try {
      const { data, error } = await db
        .from('purchase_orders')
        .insert({
          supplier_id: supplierId,
          status: 'ordered',
          total: Math.round(total * 100) / 100,
          paid: parseNum(paid),
          notes: notes.trim() || null,
          created_by: profile?.id ?? null
        })
        .select('id')
        .single()
      if (error) throw error
      const { error: itemsErr } = await db.from('purchase_order_items').insert(
        validLines.map((l) => ({
          purchase_order_id: data.id,
          ingredient_id: l.ingredient_id,
          quantity: parseNum(l.quantity),
          unit_cost: parseNum(l.unit_cost),
          total: Math.round(parseNum(l.quantity) * parseNum(l.unit_cost) * 100) / 100
        }))
      )
      if (itemsErr) throw itemsErr
      toast.success(t('purchases.created'))
      setOpen(false)
      setSupplierId('')
      setLines([{ ingredient_id: '', quantity: '', unit_cost: '' }])
      setPaid('')
      setNotes('')
      void list.reload()
    } catch (err) {
      toast.error(humanError(err))
    } finally {
      setSaving(false)
    }
  }

  const receive = async (po: PurchaseOrder): Promise<void> => {
    try {
      const { error } = await db.rpc('receive_purchase', { p_po: po.id })
      if (error) throw error
      toast.success(t('purchases.received'))
      setReceiveTarget(null)
      void list.reload()
      void ingredients.reload()
      void suppliers.reload()
    } catch (err) {
      toast.error(humanError(err))
    }
  }

  return (
    <div>
      <PageHeader
        title={t('purchases.title')}
        actions={
          <>
            {manage && (
              <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setOpen(true)}>
                {t('purchases.new')}
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
                <th>{t('purchases.number')}</th>
                <th>{t('common.supplier')}</th>
                <th>{t('common.date')}</th>
                <th>{t('common.items')}</th>
                <th>{t('common.total')}</th>
                <th>{t('purchases.paid')}</th>
                <th>{t('common.status')}</th>
                <th className="w-10"></th>
              </tr>
            </thead>
            <tbody>
              {(list.data ?? []).map((po) => {
                const itemCount = (po.purchase_order_items ?? []).length
                return (
                  <tr key={po.id}>
                    <td className="font-black text-brand-gold">#{po.number}</td>
                    <td className="font-semibold">{po.suppliers?.name ?? '—'}</td>
                    <td className="text-[11px] text-txt-faint">{fmtDateTime(po.created_at)}</td>
                    <td className="text-xs">{num(itemCount, 0)}</td>
                    <td className="font-bold">{money(po.total)}</td>
                    <td className="text-xs">{money(po.paid)}</td>
                    <td>
                      <Badge color={colorOf(PURCHASE_STATUS, po.status)}>{labelOf(PURCHASE_STATUS, po.status, 'ar')}</Badge>
                    </td>
                    <td>
                      <RowMenu
                        items={[
                          {
                            label: t('orders.details'),
                            icon: <Eye className="h-3.5 w-3.5" />,
                            onClick: () => setViewTarget(po)
                          },
                          ...(manage && (po.status === 'ordered' || po.status === 'draft')
                            ? [
                                {
                                  label: t('purchases.receive'),
                                  icon: <CheckCheck className="h-3.5 w-3.5" />,
                                  onClick: () => setReceiveTarget(po)
                                },
                                {
                                  label: t('purchases.cancel'),
                                  icon: <XCircle className="h-3.5 w-3.5" />,
                                  danger: true,
                                  onClick: () => setCancelTarget(po)
                                }
                              ]
                            : [])
                        ]}
                      />
                    </td>
                  </tr>
                )
              })}
              {(list.data ?? []).length === 0 && (
                <tr>
                  <td colSpan={8} className="py-10 text-center text-xs text-txt-faint">
                    {t('purchases.noOrders')}
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
        title={t('purchases.new')}
        size="lg"
        footer={
          <>
            <div className="me-auto text-xs text-txt-faint">
              {t('common.total')}: <span className="font-black text-brand-gold">{money(total)}</span>
            </div>
            <Button variant="ghost" onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : t('purchases.create')}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="grid gap-3 md:grid-cols-2">
            <Field label={t('common.supplier')}>
              <Select
                value={supplierId}
                onChange={setSupplierId}
                options={(suppliers.data ?? []).map((s) => ({ value: s.id, ar: s.name }))}
              />
            </Field>
            <Field label={t('purchases.paid')}>
              <input className="input" inputMode="decimal" value={paid} onChange={(e) => setPaid(e.target.value)} placeholder="0" />
            </Field>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="label mb-0">{t('purchases.items')}</span>
              <Button
                size="sm"
                variant="ghost"
                icon={<Plus className="h-3.5 w-3.5" />}
                onClick={() => setLines([...lines, { ingredient_id: '', quantity: '', unit_cost: '' }])}
              >
                {t('purchases.addItem')}
              </Button>
            </div>
            <div className="space-y-2">
              {lines.map((line, idx) => (
                <div key={idx} className="grid grid-cols-[1fr_90px_100px_34px] items-center gap-2">
                  <Select
                    value={line.ingredient_id}
                    onChange={(v) => {
                      const ing = ingredients.data?.find((i) => i.id === v)
                      const copy = [...lines]
                      copy[idx] = {
                        ...line,
                        ingredient_id: v,
                        unit_cost: line.unit_cost || String(ing?.purchase_cost ?? '')
                      }
                      setLines(copy)
                    }}
                    options={(ingredients.data ?? []).map((i) => ({ value: i.id, ar: `${i.name_ar} (${i.unit})` }))}
                    placeholder={t('menu.ingredient')}
                  />
                  <input
                    className="input"
                    inputMode="decimal"
                    placeholder={t('common.qty')}
                    value={line.quantity}
                    onChange={(e) => {
                      const copy = [...lines]
                      copy[idx] = { ...line, quantity: e.target.value }
                      setLines(copy)
                    }}
                  />
                  <input
                    className="input"
                    inputMode="decimal"
                    placeholder={t('purchases.unitCost')}
                    value={line.unit_cost}
                    onChange={(e) => {
                      const copy = [...lines]
                      copy[idx] = { ...line, unit_cost: e.target.value }
                      setLines(copy)
                    }}
                  />
                  <button
                    type="button"
                    aria-label={t('common.delete')}
                    className="grid h-9 w-9 place-items-center rounded-lg text-txt-faint hover:bg-brand-red/10 hover:text-brand-redSoft"
                    onClick={() => setLines(lines.filter((_, i) => i !== idx))}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          </div>

          <Field label={t('common.notes')}>
            <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </div>
      </Dialog>

      <Dialog
        open={!!viewTarget}
        onClose={() => setViewTarget(null)}
        title={`${t('purchases.number')} #${viewTarget?.number ?? ''}`}
        subtitle={viewTarget?.suppliers?.name}
        size="lg"
      >
        <TableWrap>
          <thead>
            <tr>
              <th>{t('menu.ingredient')}</th>
              <th>{t('common.qty')}</th>
              <th>{t('purchases.unitCost')}</th>
              <th>{t('common.total')}</th>
            </tr>
          </thead>
          <tbody>
            {(viewTarget?.purchase_order_items ?? []).map((item) => (
              <tr key={item.id}>
                <td className="font-semibold">
                  {ingredients.data?.find((i) => i.id === item.ingredient_id)?.name_ar ?? item.ingredient_id}
                </td>
                <td>{num(item.quantity, 3)}</td>
                <td>{money(item.unit_cost)}</td>
                <td className="font-bold">{money(item.total)}</td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
        <div className="mt-3 flex justify-between rounded-xl bg-ink-800/60 p-3 text-xs">
          <span className="text-txt-faint">{t('purchases.paid')}: {money(viewTarget?.paid)}</span>
          <span className="font-black text-brand-gold">{money(viewTarget?.total)}</span>
        </div>
      </Dialog>

      <ConfirmDialog
        open={!!receiveTarget}
        onClose={() => setReceiveTarget(null)}
        title={t('purchases.receive')}
        message={t('purchases.receiveConfirm')}
        confirmLabel={t('purchases.receive')}
        danger={false}
        onConfirm={() => receiveTarget && void receive(receiveTarget)}
      />

      <ConfirmDialog
        open={!!cancelTarget}
        onClose={() => setCancelTarget(null)}
        title={t('purchases.cancel')}
        message={`${t('purchases.cancel')} #${cancelTarget?.number ?? ''}?`}
        confirmLabel={t('common.confirm')}
        onConfirm={async () => {
          if (!cancelTarget) return
          try {
            const { error } = await db.from('purchase_orders').update({ status: 'cancelled' }).eq('id', cancelTarget.id)
            if (error) throw error
            toast.success(t('purchases.cancelled'))
            setCancelTarget(null)
            void list.reload()
          } catch (err) {
            toast.error(humanError(err))
          }
        }}
      />
    </div>
  )
}
