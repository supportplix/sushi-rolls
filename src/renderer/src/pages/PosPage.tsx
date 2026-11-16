import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  ChefHat,
  CirclePlus,
  Minus,
  Plus,
  Search,
  ShoppingCart,
  Star,
  Trash2,
  UtensilsCrossed,
  X
} from 'lucide-react'
import { useAuth, useDb } from '@/lib/auth'
import { useAsync } from '@/lib/hooks'
import { humanError } from '@/lib/errors'
import { money, num, parseNum } from '@/lib/format'
import type {
  CartItem,
  Category,
  Order,
  OrderType,
  Product,
  ProductExtra,
  ProductVariant,
  RTable
} from '@/lib/types'
import { calcTotals } from '@/lib/totals'
import { t } from '@/i18n'
import { ORDER_TYPES, PAYMENT_METHODS } from '@/lib/constants'
import { cn } from '@/lib/cn'
import {
  Badge,
  Button,
  Field,
  Select,
  Spinner
} from '@/components/ui/primitives'
import { Dialog, ConfirmDialog } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/toast'
import { fetchOrderFull } from '@/lib/orders'
import { printKitchenTicket, printThermalReceipt } from '@/lib/receipt'

type ProductWithVariants = Product & { product_variants: ProductVariant[] }

interface ItemDraft {
  product: ProductWithVariants
  qty: number
  variantId: string
  extraIds: string[]
  notes: string
}

export default function PosPage(): JSX.Element {
  const db = useDb()
  const { settings } = useAuth()
  const toast = useToast()

  const [catId, setCatId] = useState('all')
  const [search, setSearch] = useState('')
  const [cart, setCart] = useState<CartItem[]>([])
  const [orderType, setOrderType] = useState<OrderType>('dine_in')
  const [tableId, setTableId] = useState('')
  const [customerName, setCustomerName] = useState('')
  const [customerPhone, setCustomerPhone] = useState('')
  const [customerAddress, setCustomerAddress] = useState('')
  const [discountType, setDiscountType] = useState<'none' | 'percent' | 'fixed'>('none')
  const [discountValue, setDiscountValue] = useState('')
  const [orderNotes, setOrderNotes] = useState('')
  const [payMethod, setPayMethod] = useState('cash')
  const [paidInput, setPaidInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [shiftId, setShiftId] = useState<string | null>(null)
  const [draft, setDraft] = useState<ItemDraft | null>(null)
  const [clearOpen, setClearOpen] = useState(false)
  const [searchParams] = useSearchParams()

  useEffect(() => {
    const tableParam = searchParams.get('table')
    if (tableParam) {
      setOrderType('dine_in')
      setTableId(tableParam)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const products = useAsync(async () => {
    const { data, error } = await db
      .from('products')
      .select('*, product_variants(*)')
      .eq('is_archived', false)
      .eq('is_available', true)
      .order('sort_order')
    if (error) throw error
    return (data ?? []) as ProductWithVariants[]
  }, [db])

  const categories = useAsync(async () => {
    const { data } = await db.from('categories').select('*').eq('is_active', true).order('sort_order')
    return (data ?? []) as Category[]
  }, [db])

  const extras = useAsync(async () => {
    const { data } = await db
      .from('product_extras')
      .select('*')
      .eq('is_active', true)
      .order('sort_order')
    return (data ?? []) as ProductExtra[]
  }, [db])

  const tables = useAsync(async () => {
    const { data } = await db.from('restaurant_tables').select('*').order('number')
    return (data ?? []) as RTable[]
  }, [db])

  useEffect(() => {
    let alive = true
    const load = async (): Promise<void> => {
      const { data } = await db
        .from('cash_shifts')
        .select('id')
        .eq('status', 'open')
        .maybeSingle()
      if (alive) setShiftId(data?.id ?? null)
    }
    void load()
    return () => {
      alive = false
    }
  }, [db])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return (products.data ?? [])
      .filter((p) => (catId === 'all' ? true : p.category_id === catId))
      .filter((p) => !q || p.name_ar.toLowerCase().includes(q) || (p.name_en ?? '').toLowerCase().includes(q))
      .sort((a, b) => Number(b.is_popular) - Number(a.is_popular) || a.name_ar.localeCompare(b.name_ar, 'ar'))
  }, [products.data, catId, search])

  const subtotal = cart.reduce((s, i) => s + i.lineTotal, 0)
  const totals = calcTotals(subtotal, discountType, parseNum(discountValue), settings.tax)
  const paidValue = paidInput.trim() ? parseNum(paidInput) : totals.total
  const change = paidValue - totals.total

  const addDraftToCart = (): void => {
    if (!draft) return
    const variant = draft.product.product_variants?.find((v) => v.id === draft.variantId) ?? null
    const chosen = (extras.data ?? []).filter((e) => draft.extraIds.includes(e.id))
    const unitPrice =
      Number(draft.product.price) +
      Number(variant?.price_delta ?? 0) +
      chosen.reduce((s, e) => s + Number(e.price), 0)
    const qty = Math.max(1, draft.qty)
    const key = `${draft.product.id}|${variant?.id ?? ''}|${draft.extraIds.sort().join(',')}|${draft.notes.trim()}`
    const item: CartItem = {
      key,
      product: draft.product,
      variant,
      extras: chosen.map((extra) => ({ extra, quantity: 1 })),
      quantity: qty,
      notes: draft.notes.trim(),
      unitPrice,
      lineTotal: Math.round(unitPrice * qty * 100) / 100
    }
    setCart((prev) => {
      const idx = prev.findIndex((i) => i.key === key)
      if (idx >= 0) {
        const copy = [...prev]
        const merged = { ...copy[idx], quantity: copy[idx].quantity + qty }
        merged.lineTotal = Math.round(merged.unitPrice * merged.quantity * 100) / 100
        copy[idx] = merged
        return copy
      }
      return [...prev, item]
    })
    setDraft(null)
  }

  const changeQty = (key: string, delta: number): void => {
    setCart((prev) =>
      prev
        .map((i) => {
          if (i.key !== key) return i
          const quantity = i.quantity + delta
          return { ...i, quantity, lineTotal: Math.round(i.unitPrice * quantity * 100) / 100 }
        })
        .filter((i) => i.quantity > 0)
    )
  }

  const reset = (): void => {
    setCart([])
    setDiscountType('none')
    setDiscountValue('')
    setOrderNotes('')
    setPaidInput('')
    setCustomerName('')
    setCustomerPhone('')
    setCustomerAddress('')
    setTableId('')
  }

  const submit = async (send: boolean): Promise<void> => {
    if (cart.length === 0) {
      toast.error(t('common.addFirst'))
      return
    }
    if (orderType === 'dine_in' && !tableId) {
      toast.error(t('pos.selectTableFirst'))
      return
    }
    setBusy(true)
    try {
      const payload = {
        order_type: orderType,
        table_id: orderType === 'dine_in' ? tableId : null,
        customer_name: customerName.trim() || null,
        customer_phone: customerPhone.trim() || null,
        customer_address: orderType === 'delivery' ? customerAddress.trim() || null : null,
        discount_type: discountType === 'none' ? null : discountType,
        discount_value: discountType === 'none' ? 0 : parseNum(discountValue),
        notes: orderNotes.trim() || null,
        items: cart.map((i) => ({
          product_id: i.product.id,
          quantity: i.quantity,
          variant_id: i.variant?.id ?? null,
          notes: i.notes || null,
          extras: i.extras.map((e) => ({ extra_id: e.extra.id, quantity: e.quantity }))
        }))
      }
      const options = {
        payment_method: send ? payMethod : null,
        paid_amount: send ? paidValue : 0,
        send_to_kitchen: send
      }
      const { data, error } = await db.rpc('submit_order', { p_payload: payload, p_options: options })
      if (error) throw error
      const created = data as Order
      toast.success(`${t('pos.success')} — #${created.order_number}`)
      if (send && settings.printing?.printer) {
        try {
          const full = await fetchOrderFull(db, created.id)
          if (full) {
            await printThermalReceipt({ ...full, settings })
            await printKitchenTicket({ ...full, settings })
          }
        } catch {
          void 0
        }
      }
      reset()
      void tables.reload()
    } catch (err) {
      toast.error(humanError(err))
    } finally {
      setBusy(false)
    }
  }

  const tableOptions = (tables.data ?? [])
    .filter((tb) => tb.status !== 'occupied' || tb.id === tableId)
    .map((tb) => ({ value: tb.id, ar: `${tb.number} · ${tb.zone} (${tb.capacity})` }))

  const draftUnit = draft
    ? Number(draft.product.price) +
      Number(draft.product.product_variants?.find((v) => v.id === draft.variantId)?.price_delta ?? 0) +
      (extras.data ?? []).filter((e) => draft.extraIds.includes(e.id)).reduce((s, e) => s + Number(e.price), 0)
    : 0

  return (
    <div className="flex h-[calc(100vh-130px)] min-h-[560px] gap-3">
      <aside className="hidden w-[168px] shrink-0 space-y-1 overflow-y-auto lg:block">
        <button
          type="button"
          onClick={() => setCatId('all')}
          className={cn(
            'flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-xs font-bold transition',
            catId === 'all'
              ? 'bg-gradient-to-l from-brand-red/[0.22] to-transparent text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]'
              : 'text-txt-dim hover:bg-white/[0.04] hover:text-txt'
          )}
        >
          {t('pos.all')}
          <span className="text-[10px] opacity-60">{num(products.data?.length ?? 0, 0)}</span>
        </button>
        {(categories.data ?? []).map((c) => {
          const count = (products.data ?? []).filter((p) => p.category_id === c.id).length
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => setCatId(c.id)}
              className={cn(
                'flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-xs font-bold transition',
                catId === c.id
                  ? 'bg-gradient-to-l from-brand-red/[0.22] to-transparent text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]'
                  : 'text-txt-dim hover:bg-white/[0.04] hover:text-txt'
              )}
            >
              <span className="truncate">{c.name_ar}</span>
              <span className="text-[10px] opacity-60">{num(count, 0)}</span>
            </button>
          )
        })}
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <div className="relative mb-3">
          <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-txt-faint" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('pos.search')}
            className="input ps-9"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              aria-label={t('common.close')}
              className="absolute end-2 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-md text-txt-faint hover:bg-white/[0.06]"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        <div className="scroll-area grid flex-1 auto-rows-max content-start gap-2.5 pb-2 pe-1 sm:grid-cols-[repeat(auto-fill,minmax(148px,1fr))]">
          {filtered.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() =>
                setDraft({
                  product: p,
                  qty: 1,
                  variantId: p.product_variants?.find((v) => v.is_default)?.id ?? p.product_variants?.[0]?.id ?? '',
                  extraIds: [],
                  notes: ''
                })
              }
              className="group card relative overflow-hidden text-start transition hover:border-brand-red/40"
            >
              <div className="relative h-[92px] w-full overflow-hidden bg-ink-800">
                {p.image_url ? (
                  <img src={p.image_url} alt="" className="h-full w-full object-cover transition duration-300 group-hover:scale-105" />
                ) : (
                  <div className="grid h-full w-full place-items-center">
                    <UtensilsCrossed className="h-7 w-7 text-txt-faint/50" />
                  </div>
                )}
                {p.is_popular && (
                  <span className="absolute end-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-full bg-brand-gold text-ink">
                    <Star className="h-3.5 w-3.5 fill-current" />
                  </span>
                )}
              </div>
              <div className="p-2.5">
                <div className="line-clamp-2 min-h-[32px] text-[11.5px] font-bold leading-4">{p.name_ar}</div>
                <div className="mt-1 flex items-center justify-between">
                  <span className="text-xs font-black text-brand-gold">{money(p.price)}</span>
                  <span className="grid h-6 w-6 place-items-center rounded-md bg-brand-red/10 text-brand-redSoft transition group-hover:bg-brand-red group-hover:text-white">
                    <Plus className="h-3.5 w-3.5" />
                  </span>
                </div>
              </div>
            </button>
          ))}
          {filtered.length === 0 && !products.loading && (
            <div className="col-span-full grid h-40 place-items-center text-xs text-txt-faint">{t('common.noResults')}</div>
          )}
          {products.loading && (
            <div className="col-span-full grid h-40 place-items-center">
              <Spinner />
            </div>
          )}
        </div>
      </section>

      <aside className="card flex w-[372px] shrink-0 flex-col overflow-hidden">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="flex items-center gap-2 text-sm font-bold">
            <ShoppingCart className="h-4 w-4 text-brand-gold" />
            {t('pos.cart')}
            {cart.length > 0 && <Badge color="#E4BE54">{num(cart.reduce((s, i) => s + i.quantity, 0), 0)}</Badge>}
          </h2>
          {cart.length > 0 && (
            <button type="button" onClick={() => setClearOpen(true)} className="text-[11px] font-semibold text-txt-faint hover:text-brand-redSoft">
              {t('pos.clear')}
            </button>
          )}
        </div>

        <div className="space-y-2.5 px-3.5 py-3">
          <div className="grid grid-cols-3 gap-1 rounded-2xl border border-white/[0.06] bg-white/[0.03] p-1">
            {ORDER_TYPES.map((ty) => (
              <button
                key={ty.value}
                type="button"
                onClick={() => setOrderType(ty.value as OrderType)}
                className={cn(
                  'rounded-xl py-2 text-[11px] font-bold transition-all',
                  orderType === ty.value
                    ? 'bg-white/[0.08] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.07)]'
                    : 'text-txt-faint hover:text-txt-dim'
                )}
              >
                {ty.ar}
              </button>
            ))}
          </div>

          {orderType === 'dine_in' && (
            <Select value={tableId} onChange={setTableId} options={tableOptions} placeholder={t('pos.chooseTable')} compact />
          )}
          {orderType !== 'dine_in' && (
            <div className="grid grid-cols-2 gap-2">
              <input className="input" value={customerName} onChange={(e) => setCustomerName(e.target.value)} placeholder={t('pos.customerName')} />
              <input className="input" inputMode="tel" value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)} placeholder={t('pos.customerPhone')} />
              {orderType === 'delivery' && (
                <input className="input col-span-2" value={customerAddress} onChange={(e) => setCustomerAddress(e.target.value)} placeholder={t('pos.customerAddress')} />
              )}
            </div>
          )}
        </div>

        <div className="scroll-area min-h-[140px] flex-1 space-y-2 px-3.5">
          {cart.length === 0 && (
            <div className="grid h-full min-h-[140px] place-items-center px-6 text-center text-[11px] leading-relaxed text-txt-faint">
              {t('pos.emptyCart')}
            </div>
          )}
          {cart.map((item) => (
            <div key={item.key} className="rounded-xl border border-line bg-ink-800/70 p-2.5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-[11.5px] font-bold leading-4">
                    {item.product.name_ar}
                    {item.variant ? <span className="text-txt-faint"> · {item.variant.name_ar}</span> : null}
                  </div>
                  {item.extras.length > 0 && (
                    <div className="mt-0.5 text-[10px] text-brand-gold/90">{item.extras.map((e) => e.extra.name_ar).join(' · ')}</div>
                  )}
                  {item.notes && <div className="mt-0.5 text-[10px] text-txt-faint">✎ {item.notes}</div>}
                </div>
                <button
                  type="button"
                  onClick={() => setCart((prev) => prev.filter((i) => i.key !== item.key))}
                  aria-label={t('common.delete')}
                  className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-txt-faint hover:bg-brand-red/10 hover:text-brand-redSoft"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="mt-2 flex items-center justify-between">
                <div className="flex items-center gap-1 rounded-lg border border-line bg-ink p-0.5">
                  <button
                    type="button"
                    onClick={() => changeQty(item.key, -1)}
                    aria-label={t('common.qty')}
                    className="grid h-6 w-6 place-items-center rounded-md text-txt-dim hover:bg-white/[0.06]"
                  >
                    <Minus className="h-3 w-3" />
                  </button>
                  <span className="min-w-[22px] text-center text-[11px] font-black">{item.quantity}</span>
                  <button
                    type="button"
                    onClick={() => changeQty(item.key, 1)}
                    aria-label={t('common.qty')}
                    className="grid h-6 w-6 place-items-center rounded-md text-txt-dim hover:bg-white/[0.06]"
                  >
                    <Plus className="h-3 w-3" />
                  </button>
                </div>
                <span className="text-xs font-black">{money(item.lineTotal)}</span>
              </div>
            </div>
          ))}
        </div>

        <div className="space-y-2.5 border-t border-line px-3.5 py-3">
          <div className="flex items-center gap-2">
            <Select
              compact
              className="w-[118px] shrink-0"
              value={discountType}
              onChange={(v) => setDiscountType(v as typeof discountType)}
              options={[
                { value: 'none', ar: t('pos.noDiscount') },
                { value: 'percent', ar: t('pos.discountPercent') },
                { value: 'fixed', ar: t('pos.discountFixed') }
              ]}
            />
            <input
              className="input"
              inputMode="decimal"
              value={discountValue}
              onChange={(e) => setDiscountValue(e.target.value)}
              disabled={discountType === 'none'}
              placeholder={t('common.discount')}
            />
            <input
              className="input"
              value={orderNotes}
              onChange={(e) => setOrderNotes(e.target.value)}
              placeholder={t('pos.orderNotes')}
            />
          </div>

          <div className="space-y-1 rounded-2xl border border-white/[0.06] bg-white/[0.03] p-3 text-[11.5px]">
            <div className="flex justify-between text-txt-dim">
              <span>{t('common.subtotal')}</span>
              <span>{money(subtotal)}</span>
            </div>
            {totals.discount > 0 && (
              <div className="flex justify-between text-brand-gold">
                <span>{t('common.discount')}</span>
                <span>- {money(totals.discount)}</span>
              </div>
            )}
            {totals.tax > 0 && (
              <div className="flex justify-between text-txt-dim">
                <span>
                  {t('common.tax')} {settings.tax?.rate ?? 0}%
                </span>
                <span>{money(totals.tax)}</span>
              </div>
            )}
            <div className="flex items-center justify-between border-t border-line pt-1.5 text-sm font-black">
              <span>{t('pos.total')}</span>
              <span className="text-brand-gold">{money(totals.total)}</span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Select
              compact
              value={payMethod}
              onChange={setPayMethod}
              options={PAYMENT_METHODS}
            />
            <input
              className="input"
              inputMode="decimal"
              value={paidInput}
              onChange={(e) => setPaidInput(e.target.value)}
              placeholder={t('pos.tendered')}
            />
          </div>
          {paidInput.trim() && change !== 0 && (
            <div className="flex justify-between px-1 text-[11px] font-bold">
              <span className="text-txt-faint">{change > 0 ? t('pos.change') : t('pos.remaining')}</span>
              <span className={change > 0 ? 'text-emerald-400' : 'text-brand-redSoft'}>{money(Math.abs(change))}</span>
            </div>
          )}
          {payMethod === 'cash' && !shiftId && (
            <p className="rounded-lg bg-brand-gold/10 px-2.5 py-1.5 text-[10px] font-semibold text-brand-gold">
              {t('pos.noShiftCash')}
            </p>
          )}

          <Button
            size="lg"
            className="w-full"
            disabled={busy || cart.length === 0}
            onClick={() => void submit(true)}
            icon={busy ? <Spinner className="h-4 w-4" /> : <ChefHat className="h-4 w-4" />}
          >
            {t('pos.checkout')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="w-full"
            disabled={busy || cart.length === 0}
            onClick={() => void submit(false)}
          >
            {t('pos.saveDraft')}
          </Button>
        </div>
      </aside>

      <ConfirmDialog
        open={clearOpen}
        onClose={() => setClearOpen(false)}
        title={t('common.clearCart')}
        message={t('common.clearCartConfirm')}
        confirmLabel={t('common.clearCart')}
        onConfirm={() => {
          setCart([])
          setClearOpen(false)
        }}
      />

      <Dialog
        open={!!draft}
        onClose={() => setDraft(null)}
        title={draft?.product.name_ar ?? t('pos.configureItem')}
        subtitle={draft ? money(draft.product.price) : undefined}
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDraft(null)}>{t('common.cancel')}</Button>
            <Button
              icon={<CirclePlus className="h-4 w-4" />}
              onClick={addDraftToCart}
            >
              {t('pos.addToCart')} · {money(draftUnit * (draft?.qty ?? 1))}
            </Button>
          </>
        }
      >
        {draft && (
          <div className="space-y-4">
            <div className="flex items-center justify-between rounded-xl border border-line bg-ink-800/60 p-3">
              <span className="text-xs font-bold text-txt-dim">{t('common.qty')}</span>
              <div className="flex items-center gap-2 rounded-lg border border-line bg-ink p-1">
                <button
                  type="button"
                  aria-label={t('common.qty')}
                  onClick={() => setDraft({ ...draft, qty: Math.max(1, draft.qty - 1) })}
                  className="grid h-8 w-8 place-items-center rounded-md text-txt-dim hover:bg-white/[0.06]"
                >
                  <Minus className="h-4 w-4" />
                </button>
                <span className="min-w-[26px] text-center text-sm font-black">{draft.qty}</span>
                <button
                  type="button"
                  aria-label={t('common.qty')}
                  onClick={() => setDraft({ ...draft, qty: draft.qty + 1 })}
                  className="grid h-8 w-8 place-items-center rounded-md text-txt-dim hover:bg-white/[0.06]"
                >
                  <Plus className="h-4 w-4" />
                </button>
              </div>
            </div>

            {(draft.product.product_variants?.length ?? 0) > 0 && (
              <Field label={t('pos.variant')}>
                <div className="flex flex-wrap gap-2">
                  {draft.product.product_variants.map((v) => (
                    <button
                      key={v.id}
                      type="button"
                      onClick={() => setDraft({ ...draft, variantId: v.id })}
                      className={cn(
                        'rounded-lg border px-3 py-2 text-[11px] font-bold transition',
                        draft.variantId === v.id
                          ? 'border-brand-red bg-brand-red/[0.12] text-brand-redSoft'
                          : 'border-line text-txt-dim hover:border-line-2'
                      )}
                    >
                      {v.name_ar}
                      {Number(v.price_delta) !== 0 && (
                        <span className="ms-1 text-[10px] opacity-70">
                          {Number(v.price_delta) > 0 ? '+' : ''}
                          {money(v.price_delta)}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </Field>
            )}

            {(extras.data ?? []).length > 0 && (
              <Field label={t('pos.extras')}>
                <div className="space-y-1.5">
                  {extras.data?.map((ex) => {
                    const checked = draft.extraIds.includes(ex.id)
                    return (
                      <button
                        key={ex.id}
                        type="button"
                        onClick={() =>
                          setDraft({
                            ...draft,
                            extraIds: checked ? draft.extraIds.filter((id) => id !== ex.id) : [...draft.extraIds, ex.id]
                          })
                        }
                        className={cn(
                          'flex w-full items-center justify-between rounded-lg border px-3 py-2 text-[11.5px] font-semibold transition',
                          checked ? 'border-brand-gold/50 bg-brand-gold/10 text-brand-gold' : 'border-line text-txt-dim hover:border-line-2'
                        )}
                      >
                        <span>{ex.name_ar}</span>
                        <span>+ {money(ex.price)}</span>
                      </button>
                    )
                  })}
                </div>
              </Field>
            )}

            <Field label={t('pos.itemNotes')}>
              <input className="input" value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
            </Field>
          </div>
        )}
      </Dialog>
    </div>
  )
}
