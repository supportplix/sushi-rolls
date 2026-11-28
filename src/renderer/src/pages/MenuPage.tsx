import { useState } from 'react'
import {
  Archive,
  BookOpen,
  ImagePlus,
  Layers,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  Tags,
  Trash2,
  UtensilsCrossed
} from 'lucide-react'
import { useAuth, useDb } from '@/lib/auth'
import { useAsync } from '@/lib/hooks'
import { humanError } from '@/lib/errors'
import { money, num, parseNum } from '@/lib/format'
import type { Category, Ingredient, Product, ProductExtra, ProductVariant } from '@/lib/types'
import { t } from '@/i18n'
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
  Switch,
  TableWrap,
  Tabs
} from '@/components/ui/primitives'
import { Dialog, ConfirmDialog } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/toast'
import { cn } from '@/lib/cn'

type Tab = 'products' | 'categories' | 'extras'

interface ProductForm {
  id?: string
  name_ar: string
  category_id: string
  price: string
  cost: string
  sku: string
  description_ar: string
  image_url: string
  is_available: boolean
  is_popular: boolean
  // `id` is kept for rows loaded from the database so saving can diff instead
  // of deleting and reinserting every variant/recipe item.
  variants: { id?: string; name_ar: string; price_delta: string }[]
  recipe: { id?: string; ingredient_id: string; quantity: string }[]
}

const emptyProduct: ProductForm = {
  name_ar: '',
  category_id: '',
  price: '',
  cost: '',
  sku: '',
  description_ar: '',
  image_url: '',
  is_available: true,
  is_popular: false,
  variants: [],
  recipe: []
}

export default function MenuPage(): JSX.Element {
  const db = useDb()
  const { can, profile } = useAuth()
  const toast = useToast()
  const manage = can('menu.manage')
  const isSuper = profile?.role === 'super_admin'
  const canRecipe = can('menu.manage') || can('inventory.manage')
  const [tab, setTab] = useState<Tab>('products')
  const [search, setSearch] = useState('')

  const cats = useAsync(async () => {
    const { data, error } = await db.from('categories').select('*').order('sort_order')
    if (error) throw error
    return (data ?? []) as Category[]
  }, [db])

  const prods = useAsync(async () => {
    const { data, error } = await db
      .from('products')
      .select('*, product_variants(*)')
      .eq('is_archived', false)
      .order('sort_order')
      .order('name_ar')
    if (error) throw error
    return (data ?? []) as (Product & { product_variants: ProductVariant[] })[]
  }, [db])

  const extras = useAsync(async () => {
    const { data, error } = await db.from('product_extras').select('*').order('sort_order')
    if (error) throw error
    return (data ?? []) as ProductExtra[]
  }, [db])

  const ingredients = useAsync(async () => {
    const { data } = await db.from('ingredients').select('id, name_ar, unit').eq('is_active', true).order('name_ar')
    return (data ?? []) as Pick<Ingredient, 'id' | 'name_ar' | 'unit'>[]
  }, [db])

  const [productOpen, setProductOpen] = useState(false)
  const [form, setForm] = useState<ProductForm>(emptyProduct)
  // A failed recipe fetch must never be interpreted as "no recipe" on save.
  const [recipeLoadFailed, setRecipeLoadFailed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [categoryOpen, setCategoryOpen] = useState(false)
  const [catForm, setCatForm] = useState<{ id?: string; name_ar: string }>({ name_ar: '' })
  const [extraOpen, setExtraOpen] = useState(false)
  const [extraForm, setExtraForm] = useState<{
    id?: string
    name_ar: string
    price: string
    ingredient_id: string
    ingredient_qty: string
  }>({ name_ar: '', price: '', ingredient_id: '', ingredient_qty: '' })
  const [archiveTarget, setArchiveTarget] = useState<Product | null>(null)
  const [catToggle, setCatToggle] = useState<Category | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<{
    kind: 'product' | 'category' | 'extra'
    id: string
    name: string
    image?: string | null
  } | null>(null)

  const openNew = (): void => {
    setRecipeLoadFailed(false)
    setForm({ ...emptyProduct, category_id: cats.data?.[0]?.id ?? '' })
    setProductOpen(true)
  }

  const openEdit = async (product: Product & { product_variants?: ProductVariant[] }): Promise<void> => {
    setRecipeLoadFailed(false)
    setProductOpen(true)
    setForm({
      id: product.id,
      name_ar: product.name_ar,
      category_id: product.category_id ?? '',
      price: String(product.price ?? ''),
      cost: String(product.cost ?? ''),
      sku: product.sku ?? '',
      description_ar: product.description_ar ?? '',
      image_url: product.image_url ?? '',
      is_available: product.is_available,
      is_popular: product.is_popular,
      variants: (product.product_variants ?? []).map((v) => ({ id: v.id, name_ar: v.name_ar, price_delta: String(v.price_delta) })),
      recipe: []
    })
    const { data: recipe, error } = await db
      .from('recipes')
      .select('id, recipe_items(id, ingredient_id, quantity)')
      .eq('product_id', product.id)
      .maybeSingle()
    if (error) {
      setRecipeLoadFailed(true)
      toast.error(humanError(error))
      return
    }
    const items = (recipe?.recipe_items ?? []) as { id: string; ingredient_id: string; quantity: number }[]
    setForm((f) => ({
      ...f,
      recipe: items.map((r) => ({ id: r.id, ingredient_id: r.ingredient_id, quantity: String(r.quantity) }))
    }))
  }

  const uploadImage = async (file: File): Promise<void> => {
    setUploading(true)
    try {
      const ext = file.name.split('.').pop() || 'png'
      const path = `menu/${crypto.randomUUID()}.${ext}`
      const { error } = await db.storage.from('product-images').upload(path, file, { upsert: true, contentType: file.type })
      if (error) throw error
      const { data } = db.storage.from('product-images').getPublicUrl(path)
      setForm((f) => ({ ...f, image_url: data.publicUrl }))
      toast.success(t('common.saved'))
    } catch (err) {
      toast.error(t('menu.imageFailed'))
      void err
    } finally {
      setUploading(false)
    }
  }

  const saveProduct = async (): Promise<void> => {
    if (!form.name_ar.trim() || parseNum(form.price) <= 0) {
      toast.error(t('common.required'))
      return
    }
    if (recipeLoadFailed && canRecipe) {
      toast.error(t('menu.recipeLoadFailed'))
      return
    }
    setSaving(true)
    try {
      const payload = {
        name_ar: form.name_ar.trim(),
        category_id: form.category_id || null,
        price: parseNum(form.price),
        cost: parseNum(form.cost),
        sku: form.sku.trim() || null,
        description_ar: form.description_ar.trim() || null,
        image_url: form.image_url || null,
        is_available: form.is_available,
        is_popular: form.is_popular
      }
      let productId = form.id
      if (productId) {
        const { error } = await db.from('products').update(payload).eq('id', productId)
        if (error) throw error
        await db.from('product_variants').delete().eq('product_id', productId)
      } else {
        const { data, error } = await db.from('products').insert(payload).select('id').single()
        if (error) throw error
        productId = data.id
      }

      // Variants: delete only rows the user removed, update rows that already
      // existed (keeping their IDs), and insert genuinely new rows. All fetches
      // are error-checked so a network failure cannot masquerade as an empty
      // list and wipe the menu.
      const variants = form.variants.filter((v) => v.name_ar.trim())
      const { data: existingVariants, error: variantsFetchError } = await db
        .from('product_variants')
        .select('id')
        .eq('product_id', productId)
      if (variantsFetchError) throw variantsFetchError

      const wantedVariantIds = new Set(variants.map((v) => v.id).filter((id): id is string => !!id))
      const staleVariantIds = (existingVariants ?? [])
        .map((v) => v.id as string)
        .filter((id) => !wantedVariantIds.has(id))
      const variantRow = (v: ProductForm['variants'][number]) => ({
        product_id: productId,
        name_ar: v.name_ar.trim(),
        price_delta: parseNum(v.price_delta),
        is_default: false
      })
      const changedVariants = variants.filter((v) => v.id).map((v) => ({ id: v.id as string, ...variantRow(v) }))
      if (changedVariants.length > 0) {
        const { error } = await db.from('product_variants').upsert(changedVariants, { onConflict: 'id' })
        if (error) throw error
      }
      const addedVariants = variants.filter((v) => !v.id).map(variantRow)
      if (addedVariants.length > 0) {
        const { error } = await db.from('product_variants').insert(addedVariants)
        if (error) throw error
      }
      // Deletions come last: a failed write leaves extra rows, never fewer.
      if (staleVariantIds.length > 0) {
        const { error } = await db.from('product_variants').delete().in('id', staleVariantIds)
        if (error) throw error
      }

      if (canRecipe && productId) {
        // recipe_items has no unique constraint on ingredient_id; without a
        // dedup here a repeated row would deduct the ingredient twice on sale.
        const recipeRows = form.recipe
          .filter((r) => r.ingredient_id && parseNum(r.quantity) > 0)
          .filter((r, index, all) => all.findIndex((other) => other.ingredient_id === r.ingredient_id) === index)
        // Re-read the recipe at save time rather than trusting the form loaded
        // when the dialog opened. An error aborts the save before any delete.
        const { data: existingRecipe, error: recipeFetchError } = await db
          .from('recipes')
          .select('id, recipe_items(id)')
          .eq('product_id', productId)
          .maybeSingle()
        if (recipeFetchError) throw recipeFetchError

        let recipeId = existingRecipe?.id as string | undefined
        if (recipeRows.length === 0) {
          if (recipeId) {
            const { error } = await db.from('recipes').delete().eq('id', recipeId)
            if (error) throw error
          }
        } else {
          if (!recipeId) {
            const { data, error } = await db.from('recipes').insert({ product_id: productId }).select('id').single()
            if (error) throw error
            recipeId = data.id
          }
          const existingItems = (existingRecipe?.recipe_items ?? []) as { id: string }[]
          const wantedItemIds = new Set(recipeRows.map((r) => r.id).filter((id): id is string => !!id))
          const staleItemIds = existingItems.map((i) => i.id).filter((id) => !wantedItemIds.has(id))
          const itemRow = (r: ProductForm['recipe'][number]) => ({
            recipe_id: recipeId as string,
            ingredient_id: r.ingredient_id,
            quantity: parseNum(r.quantity)
          })
          const changedItems = recipeRows.filter((r) => r.id).map((r) => ({ id: r.id as string, ...itemRow(r) }))
          if (changedItems.length > 0) {
            const { error } = await db.from('recipe_items').upsert(changedItems, { onConflict: 'id' })
            if (error) throw error
          }
          const addedItems = recipeRows.filter((r) => !r.id).map(itemRow)
          if (addedItems.length > 0) {
            const { error } = await db.from('recipe_items').insert(addedItems)
            if (error) throw error
          }
          if (staleItemIds.length > 0) {
            const { error } = await db.from('recipe_items').delete().in('id', staleItemIds)
            if (error) throw error
          }
        }
      }

      toast.success(t('menu.saved'))
      setProductOpen(false)
      void prods.reload()
    } catch (err) {
      toast.error(humanError(err))
    } finally {
      setSaving(false)
    }
  }

  const saveCategory = async (): Promise<void> => {
    if (!catForm.name_ar.trim()) return
    try {
      const payload = { name_ar: catForm.name_ar.trim(), sort_order: (cats.data?.length ?? 0) + 1 }
      if (catForm.id) {
        const { error } = await db.from('categories').update(payload).eq('id', catForm.id)
        if (error) throw error
      } else {
        const { error } = await db.from('categories').insert(payload)
        if (error) throw error
      }
      toast.success(t('menu.addedCategory'))
      setCategoryOpen(false)
      void cats.reload()
    } catch (err) {
      toast.error(humanError(err))
    }
  }

  const saveExtra = async (): Promise<void> => {
    if (!extraForm.name_ar.trim()) return
    try {
      const payload = {
        name_ar: extraForm.name_ar.trim(),
        price: parseNum(extraForm.price),
        ingredient_id: extraForm.ingredient_id || null,
        ingredient_qty: parseNum(extraForm.ingredient_qty)
      }
      if (extraForm.id) {
        const { error } = await db.from('product_extras').update(payload).eq('id', extraForm.id)
        if (error) throw error
      } else {
        const { error } = await db.from('product_extras').insert(payload)
        if (error) throw error
      }
      toast.success(t('common.saved'))
      setExtraOpen(false)
      void extras.reload()
    } catch (err) {
      toast.error(humanError(err))
    }
  }

  const removeItem = async (): Promise<void> => {
    if (!deleteTarget) return
    try {
      if (deleteTarget.kind === 'product') {
        const { error } = await db.from('products').delete().eq('id', deleteTarget.id)
        if (error) throw error
        if (deleteTarget.image) {
          const marker = '/product-images/'
          const idx = deleteTarget.image.indexOf(marker)
          if (idx >= 0) {
            const path = decodeURIComponent(deleteTarget.image.slice(idx + marker.length).split('?')[0])
            await db.storage.from('product-images').remove([path])
          }
        }
      } else if (deleteTarget.kind === 'category') {
        const { error } = await db.from('categories').delete().eq('id', deleteTarget.id)
        if (error) throw error
      } else {
        const { error } = await db.from('product_extras').delete().eq('id', deleteTarget.id)
        if (error) throw error
      }
      toast.success(t('common.deleted'))
      const kind = deleteTarget.kind
      setDeleteTarget(null)
      if (kind === 'product') void prods.reload()
      if (kind === 'category') {
        void cats.reload()
        void prods.reload()
      }
      if (kind === 'extra') void extras.reload()
    } catch (err) {
      toast.error(humanError(err))
    }
  }

  const filtered = (prods.data ?? []).filter(
    (p) =>
      !search ||
      p.name_ar.includes(search) ||
      (p.name_en ?? '').toLowerCase().includes(search.toLowerCase())
  )

  const catOptions = (cats.data ?? []).map((c) => ({ value: c.id, ar: c.name_ar }))
  const ingOptions = (ingredients.data ?? []).map((i) => ({ value: i.id, ar: `${i.name_ar} (${i.unit})` }))

  return (
    <div>
      <PageHeader
        title={t('menu.title')}
        actions={
          <>
            <Tabs
              value={tab}
              onChange={setTab}
              tabs={[
                { value: 'products', label: t('menu.products'), icon: <BookOpen className="h-3.5 w-3.5" /> },
                { value: 'categories', label: t('menu.categories'), icon: <Tags className="h-3.5 w-3.5" /> },
                { value: 'extras', label: t('menu.extras'), icon: <Layers className="h-3.5 w-3.5" /> }
              ]}
            />
            {manage && tab === 'products' && (
              <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={openNew}>
                {t('menu.addProduct')}
              </Button>
            )}
            {manage && tab === 'categories' && (
              <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => { setCatForm({ name_ar: '' }); setCategoryOpen(true) }}>
                {t('menu.addCategory')}
              </Button>
            )}
            {manage && tab === 'extras' && (
              <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => { setExtraForm({ name_ar: '', price: '', ingredient_id: '', ingredient_qty: '' }); setExtraOpen(true) }}>
                {t('menu.addExtra')}
              </Button>
            )}
          </>
        }
      />

      {tab === 'products' && (
        <SectionCard bodyClassName="p-0">
          <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
            <SearchInput value={search} onChange={setSearch} placeholder={t('menu.search')} className="w-72 max-w-full" />
            <span className="text-[11px] text-txt-faint">{num(filtered.length, 0)} صنف</span>
          </div>
          {prods.loading ? (
            <PageLoader />
          ) : (
            <TableWrap>
              <thead>
                <tr>
                  <th>{t('common.name')}</th>
                  <th>{t('common.category')}</th>
                  <th>{t('common.price')}</th>
                  <th>{t('common.cost')}</th>
                  <th>{t('common.status')}</th>
                  <th className="w-10"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <div className="flex items-center gap-3">
                        <div className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-lg bg-ink-800">
                          {p.image_url ? (
                            <img src={p.image_url} alt="" className="h-full w-full object-cover" />
                          ) : (
                            <UtensilsCrossed className="h-4 w-4 text-txt-faint" />
                          )}
                        </div>
                        <div>
                          <div className="flex items-center gap-2 font-semibold">
                            {p.name_ar}
                            {p.is_popular && <Badge color="#E4BE54">{t('menu.popular')}</Badge>}
                          </div>
                          {p.product_variants?.length > 0 && (
                            <div className="text-[10px] text-txt-faint">
                              {p.product_variants.map((v) => v.name_ar).join(' · ')}
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="text-xs text-txt-dim">
                      {cats.data?.find((c) => c.id === p.category_id)?.name_ar ?? '—'}
                    </td>
                    <td className="font-bold">{money(p.price)}</td>
                    <td className="text-xs text-txt-dim">{money(p.cost)}</td>
                    <td>
                      <Badge color={p.is_available ? '#3DBE7A' : '#6B7176'}>
                        {p.is_available ? t('menu.available') : t('common.inactive')}
                      </Badge>
                    </td>
                    <td>
                      {manage && (
                        <RowMenu
                          items={[
                            { label: t('common.edit'), icon: <Pencil className="h-3.5 w-3.5" />, onClick: () => void openEdit(p) },
                            {
                              label: t('menu.archive'),
                              icon: <Archive className="h-3.5 w-3.5" />,
                              danger: true,
                              onClick: () => setArchiveTarget(p)
                            },
                            ...(isSuper
                              ? [{
                                  label: t('common.delete'),
                                  icon: <Trash2 className="h-3.5 w-3.5" />,
                                  danger: true,
                                  onClick: () => setDeleteTarget({ kind: 'product', id: p.id, name: p.name_ar, image: p.image_url })
                                }]
                              : [])
                          ]}
                        />
                      )}
                    </td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={6} className="py-10 text-center text-xs text-txt-faint">
                      {t('menu.noProducts')}
                    </td>
                  </tr>
                )}
              </tbody>
            </TableWrap>
          )}
        </SectionCard>
      )}

      {tab === 'categories' && (
        <SectionCard bodyClassName="p-0">
          <TableWrap>
            <thead>
              <tr>
                <th>{t('menu.categoryName')}</th>
                <th>{t('common.status')}</th>
                <th>الترتيب</th>
                <th className="w-10"></th>
              </tr>
            </thead>
            <tbody>
              {(cats.data ?? []).map((c) => (
                <tr key={c.id}>
                  <td className="font-semibold">{c.name_ar}</td>
                  <td>
                    <Badge color={c.is_active ? '#3DBE7A' : '#6B7176'}>{c.is_active ? t('common.active') : t('common.inactive')}</Badge>
                  </td>
                  <td className="text-xs text-txt-dim">{c.sort_order}</td>
                  <td>
                    {manage && (
                      <RowMenu
                        items={[
                          {
                            label: t('common.edit'),
                            icon: <Pencil className="h-3.5 w-3.5" />,
                            onClick: () => {
                              setCatForm({ id: c.id, name_ar: c.name_ar })
                              setCategoryOpen(true)
                            }
                          },
                          {
                            label: c.is_active ? t('common.inactive') : t('common.active'),
                            icon: <RotateCcw className="h-3.5 w-3.5" />,
                            onClick: () => setCatToggle(c)
                          },
                          ...(isSuper
                            ? [{
                                label: t('common.delete'),
                                icon: <Trash2 className="h-3.5 w-3.5" />,
                                danger: true,
                                onClick: () => setDeleteTarget({ kind: 'category', id: c.id, name: c.name_ar })
                              }]
                            : [])
                        ]}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </SectionCard>
      )}

      {tab === 'extras' && (
        <SectionCard bodyClassName="p-0">
          <TableWrap>
            <thead>
              <tr>
                <th>{t('menu.extraName')}</th>
                <th>{t('menu.extraPrice')}</th>
                <th>{t('menu.ingredient')}</th>
                <th className="w-10"></th>
              </tr>
            </thead>
            <tbody>
              {(extras.data ?? []).map((ex) => (
                <tr key={ex.id}>
                  <td className="font-semibold">{ex.name_ar}</td>
                  <td className="font-bold">{money(ex.price)}</td>
                  <td className="text-xs text-txt-dim">
                    {ex.ingredient_id
                      ? `${ingredients.data?.find((i) => i.id === ex.ingredient_id)?.name_ar ?? '—'} · ${num(ex.ingredient_qty, 3)}`
                      : '—'}
                  </td>
                  <td>
                    {manage && (
                      <RowMenu
                        items={[
                          {
                            label: t('common.edit'),
                            icon: <Pencil className="h-3.5 w-3.5" />,
                            onClick: () => {
                              setExtraForm({
                                id: ex.id,
                                name_ar: ex.name_ar,
                                price: String(ex.price),
                                ingredient_id: ex.ingredient_id ?? '',
                                ingredient_qty: String(ex.ingredient_qty || '')
                              })
                              setExtraOpen(true)
                            }
                          },
                          ...(isSuper
                            ? [{
                                label: t('common.delete'),
                                icon: <Trash2 className="h-3.5 w-3.5" />,
                                danger: true,
                                onClick: () => setDeleteTarget({ kind: 'extra', id: ex.id, name: ex.name_ar })
                              }]
                            : [])
                        ]}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </SectionCard>
      )}

      <Dialog
        open={productOpen}
        onClose={() => setProductOpen(false)}
        title={form.id ? t('menu.editProduct') : t('menu.addProduct')}
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setProductOpen(false)}>{t('common.cancel')}</Button>
            <Button onClick={() => void saveProduct()} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : t('common.save')}
            </Button>
          </>
        }
      >
        <div className="grid gap-4 md:grid-cols-2">
          <Field label={t('menu.nameAr')}>
            <input className="input" value={form.name_ar} onChange={(e) => setForm({ ...form, name_ar: e.target.value })} />
          </Field>
          <Field label={t('common.category')}>
            <Select value={form.category_id} onChange={(v) => setForm({ ...form, category_id: v })} options={catOptions} />
          </Field>
          <Field label={t('menu.price')}>
            <input className="input" inputMode="decimal" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} placeholder="0" />
          </Field>
          <Field label={t('menu.cost')}>
            <input className="input" inputMode="decimal" value={form.cost} onChange={(e) => setForm({ ...form, cost: e.target.value })} placeholder="0" />
          </Field>
          <Field label={t('menu.sku')}>
            <input className="input" value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} />
          </Field>
          <Field label={t('menu.description')}>
            <input className="input" value={form.description_ar} onChange={(e) => setForm({ ...form, description_ar: e.target.value })} />
          </Field>

          <div className="md:col-span-2">
            <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-ink-800/50 p-3">
              <div className="grid h-14 w-14 place-items-center overflow-hidden rounded-lg bg-ink-800">
                {form.image_url ? <img src={form.image_url} alt="" className="h-full w-full object-cover" /> : <ImagePlus className="h-5 w-5 text-txt-faint" />}
              </div>
              <label className={cn('btn btn-sm btn-ghost cursor-pointer', uploading && 'pointer-events-none opacity-50')}>
                {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ImagePlus className="h-3.5 w-3.5" />}
                {uploading ? t('menu.uploading') : t('menu.uploadImage')}
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    if (file) void uploadImage(file)
                    e.target.value = ''
                  }}
                />
              </label>
              <div className="flex items-center gap-4">
                <Switch checked={form.is_available} onChange={(v) => setForm({ ...form, is_available: v })} label={t('menu.available')} />
                <Switch checked={form.is_popular} onChange={(v) => setForm({ ...form, is_popular: v })} label={t('menu.popular')} />
              </div>
            </div>
          </div>

          <div className="md:col-span-2">
            <div className="mb-2 flex items-center justify-between">
              <span className="label mb-0">{t('menu.variants')}</span>
              <Button size="sm" variant="ghost" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setForm({ ...form, variants: [...form.variants, { name_ar: '', price_delta: '' }] })}>
                {t('menu.addVariant')}
              </Button>
            </div>
            <div className="space-y-2">
              {form.variants.map((v, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <input
                    className="input"
                    value={v.name_ar}
                    placeholder={t('menu.variantName')}
                    onChange={(e) => {
                      const variants = [...form.variants]
                      variants[idx] = { ...v, name_ar: e.target.value }
                      setForm({ ...form, variants })
                    }}
                  />
                  <input
                    className="input w-32"
                    inputMode="decimal"
                    value={v.price_delta}
                    placeholder={t('menu.priceDelta')}
                    onChange={(e) => {
                      const variants = [...form.variants]
                      variants[idx] = { ...v, price_delta: e.target.value }
                      setForm({ ...form, variants })
                    }}
                  />
                  <button
                    type="button"
                    aria-label={t('common.delete')}
                    className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-txt-faint hover:bg-brand-red/10 hover:text-brand-redSoft"
                    onClick={() => setForm({ ...form, variants: form.variants.filter((_, i) => i !== idx) })}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
              {form.variants.length === 0 && <p className="text-[11px] text-txt-faint">بدون أحجام — سعر واحد.</p>}
            </div>
          </div>

          {canRecipe && (
            <div className="md:col-span-2">
              <div className="mb-1 flex items-center justify-between">
                <span className="label mb-0">{t('menu.recipe')}</span>
                <Button size="sm" variant="ghost" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setForm({ ...form, recipe: [...form.recipe, { ingredient_id: '', quantity: '' }] })}>
                  {t('menu.addIngredientRow') ?? 'إضافة مكون'}
                </Button>
              </div>
              <p className="mb-2 text-[10.5px] text-txt-faint">{t('menu.recipeHint')}</p>
              <div className="space-y-2">
                {form.recipe.map((r, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <Select
                      className="flex-1"
                      value={r.ingredient_id}
                      onChange={(v) => {
                        const recipe = [...form.recipe]
                        recipe[idx] = { ...r, ingredient_id: v }
                        setForm({ ...form, recipe })
                      }}
                      options={ingOptions}
                      placeholder={t('menu.ingredient')}
                    />
                    <input
                      className="input w-32"
                      inputMode="decimal"
                      value={r.quantity}
                      placeholder={t('menu.recipeQty')}
                      onChange={(e) => {
                        const recipe = [...form.recipe]
                        recipe[idx] = { ...r, quantity: e.target.value }
                        setForm({ ...form, recipe })
                      }}
                    />
                    <button
                      type="button"
                      aria-label={t('common.delete')}
                      className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-txt-faint hover:bg-brand-red/10 hover:text-brand-redSoft"
                      onClick={() => setForm({ ...form, recipe: form.recipe.filter((_, i) => i !== idx) })}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}
                {form.recipe.length === 0 && <p className="text-[11px] text-txt-faint">مفيش وصفة — المخزون مش هيتخصم تلقائي للصنف ده.</p>}
              </div>
            </div>
          )}
        </div>
      </Dialog>

      <Dialog
        open={categoryOpen}
        onClose={() => setCategoryOpen(false)}
        title={t('menu.addCategory')}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setCategoryOpen(false)}>{t('common.cancel')}</Button>
            <Button onClick={() => void saveCategory()}>{t('common.save')}</Button>
          </>
        }
      >
        <Field label={t('menu.categoryName')}>
          <input autoFocus className="input" value={catForm.name_ar} onChange={(e) => setCatForm({ ...catForm, name_ar: e.target.value })} />
        </Field>
      </Dialog>

      <Dialog
        open={extraOpen}
        onClose={() => setExtraOpen(false)}
        title={t('menu.addExtra')}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setExtraOpen(false)}>{t('common.cancel')}</Button>
            <Button onClick={() => void saveExtra()}>{t('common.save')}</Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label={t('menu.extraName')}>
            <input autoFocus className="input" value={extraForm.name_ar} onChange={(e) => setExtraForm({ ...extraForm, name_ar: e.target.value })} />
          </Field>
          <Field label={t('menu.extraPrice')}>
            <input className="input" inputMode="decimal" value={extraForm.price} placeholder="0" onChange={(e) => setExtraForm({ ...extraForm, price: e.target.value })} />
          </Field>
          <Field label={t('menu.ingredient')} hint="لو الإضافة بتستهلك من مكون، اربطها هنا">
            <Select
              value={extraForm.ingredient_id}
              onChange={(v) => setExtraForm({ ...extraForm, ingredient_id: v })}
              options={ingOptions}
              placeholder={t('common.none')}
            />
          </Field>
          <Field label={t('menu.recipeQty')}>
            <input className="input" inputMode="decimal" value={extraForm.ingredient_qty} placeholder="0" onChange={(e) => setExtraForm({ ...extraForm, ingredient_qty: e.target.value })} />
          </Field>
        </div>
      </Dialog>

      <ConfirmDialog
        open={!!archiveTarget}
        onClose={() => setArchiveTarget(null)}
        title={t('menu.archive')}
        message={`${t('menu.archive')}: ${archiveTarget?.name_ar ?? ''}?`}
        confirmLabel={t('menu.archive')}
        onConfirm={async () => {
          if (!archiveTarget) return
          const { error } = await db.from('products').update({ is_archived: true }).eq('id', archiveTarget.id)
          if (error) {
            toast.error(humanError(error))
            return
          }
          setArchiveTarget(null)
          toast.success(t('common.saved'))
          void prods.reload()
        }}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title={t('common.delete')}
        message={`${t('common.delete')} "${deleteTarget?.name ?? ''}" نهائي؟`}
        confirmLabel={t('common.delete')}
        onConfirm={() => void removeItem()}
      />

      <ConfirmDialog
        open={!!catToggle}
        onClose={() => setCatToggle(null)}
        title={t('common.status')}
        message={t('menu.categoryToggleConfirm', { name: catToggle?.name_ar ?? '' })}
        confirmLabel={t('common.confirm')}
        danger={false}
        onConfirm={async () => {
          if (!catToggle) return
          const { error } = await db.from('categories').update({ is_active: !catToggle.is_active }).eq('id', catToggle.id)
          if (error) {
            toast.error(humanError(error))
            return
          }
          setCatToggle(null)
          void cats.reload()
        }}
      />
    </div>
  )
}
