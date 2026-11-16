import { useEffect, useMemo, useState } from 'react'
import {
  Building2,
  DownloadCloud,
  HardDriveDownload,
  Info,
  Loader2,
  Printer,
  ReceiptText,
  Save,
  ServerCog,
  Timer,
  UploadCloud
} from 'lucide-react'
import { useAuth, useDb } from '@/lib/auth'
import { humanError } from '@/lib/errors'
import { parseNum } from '@/lib/format'
import { t } from '@/i18n'
import { api } from '@/lib/ipc'
import { cn } from '@/lib/cn'
import {
  Button,
  Field,
  PageHeader,
  SectionCard,
  Select,
  Switch
} from '@/components/ui/primitives'
import { ConfirmDialog } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/toast'
import { logoDataUrl } from '@/lib/logo'
import { exportBackup, importBackup } from '@/lib/backup'
import { useAsync } from '@/lib/hooks'

type Tab = 'restaurant' | 'tax' | 'receipt' | 'printing' | 'session' | 'backup' | 'about'

export default function SettingsPage(): JSX.Element {
  const db = useDb()
  const { settings, refreshSettings, profile } = useAuth()
  const toast = useToast()
  const [tab, setTab] = useState<Tab>('restaurant')
  const [saving, setSaving] = useState(false)
  const [version, setVersion] = useState('')
  const [confirmRestore, setConfirmRestore] = useState(false)
  const [busyBackup, setBusyBackup] = useState(false)

  const [restaurant, setRestaurant] = useState({ name: 'SUSHI ROLLS', phone: '', address: '' })
  const [tax, setTax] = useState({ enabled: false, rate: '14', inclusive: false })
  const [receipt, setReceipt] = useState({ footer: '', show_logo: true, show_tax: true, show_cashier: true })
  const [printing, setPrinting] = useState({ width: '80', printer: '' })
  const [sessionMin, setSessionMin] = useState('480')

  useEffect(() => {
    if (!settings) return
    setRestaurant({
      name: settings.restaurant?.name ?? 'SUSHI ROLLS',
      phone: settings.restaurant?.phone ?? '',
      address: settings.restaurant?.address ?? ''
    })
    setTax({
      enabled: !!settings.tax?.enabled,
      rate: settings.tax?.rate != null ? String(settings.tax.rate) : '14',
      inclusive: !!settings.tax?.inclusive
    })
    setReceipt({
      footer: settings.receipt?.footer ?? '',
      show_logo: settings.receipt?.show_logo !== false,
      show_tax: settings.receipt?.show_tax !== false,
      show_cashier: settings.receipt?.show_cashier !== false
    })
    setPrinting({
      width: String(settings.printing?.width ?? 80),
      printer: settings.printing?.printer ?? ''
    })
    setSessionMin(String(settings.session?.timeout_minutes ?? 480))
  }, [settings])

  const printers = useAsync(async () => api.print.printers(), [])

  useEffect(() => {
    void api.app.version().then(setVersion)
  }, [])

  const saveKey = async (key: string, value: unknown): Promise<void> => {
    setSaving(true)
    try {
      const { error } = await db.from('settings').upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' })
      if (error) throw error
      await refreshSettings()
      toast.success(t('common.saved'))
    } catch (err) {
      toast.error(humanError(err))
    } finally {
      setSaving(false)
    }
  }

  const testPrint = async (): Promise<void> => {
    const logo = await logoDataUrl()
    const html = `<html dir="rtl"><head><style>
      @page{size:${printing.width}mm auto;margin:0}body{width:${printing.width}mm;padding:6mm;font-family:'Segoe UI',Tahoma,sans-serif;text-align:center}
      img{width:90px;border-radius:8px}h1{font-size:20px;margin:4px 0}p{font-size:12px;margin:2px 0;color:#333}
      .line{border-top:2px dashed #000;margin:4mm 0}</style></head><body>
      ${logo ? `<img src="${logo}">` : ''}
      <h1>${restaurant.name || 'SUSHI ROLLS'}</h1>
      <p>${t('settings.testPrint')}</p><div class="line"></div>
      <p>${new Date().toLocaleString('ar-EG-u-nu-latn')}</p>
      <p>80mm · 58mm · Thermal OK</p></body></html>`
    const printer = printing.printer || null
    const res = await api.print.receipt({ html, deviceName: printer, silent: !!printer })
    if (res.ok) toast.success(t('settings.testPrinted'))
    else if (res.error) toast.error(res.error)
  }

  const tabs: { value: Tab; label: string; icon: JSX.Element }[] = [
    { value: 'restaurant', label: t('settings.restaurant'), icon: <Building2 className="h-3.5 w-3.5" /> },
    { value: 'tax', label: t('settings.tax'), icon: <ReceiptText className="h-3.5 w-3.5" /> },
    { value: 'receipt', label: t('settings.receipt'), icon: <ReceiptText className="h-3.5 w-3.5" /> },
    { value: 'printing', label: t('settings.printing'), icon: <Printer className="h-3.5 w-3.5" /> },
    { value: 'session', label: t('settings.session'), icon: <Timer className="h-3.5 w-3.5" /> },
    { value: 'backup', label: t('settings.backup'), icon: <ServerCog className="h-3.5 w-3.5" /> },
    { value: 'about', label: t('settings.about'), icon: <Info className="h-3.5 w-3.5" /> }
  ]

  const printerOptions = useMemo(
    () => [{ value: '', ar: t('settings.noPrinter') }, ...(printers.data ?? []).map((p) => ({ value: p, ar: p }))],
    [printers.data]
  )

  return (
    <div>
      <PageHeader title={t('settings.title')} />

      <div className="mb-4 flex flex-wrap gap-1 rounded-2xl border border-white/[0.06] bg-white/[0.03] p-1 backdrop-blur-xl">
        {tabs.map((item) => (
          <button
            key={item.value}
            type="button"
            onClick={() => setTab(item.value)}
            className={cn(
              'flex items-center gap-1.5 rounded-xl px-3 py-2 text-[11px] font-semibold transition-all',
              tab === item.value
                ? 'bg-white/[0.08] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.07)]'
                : 'text-txt-faint hover:text-txt-dim'
            )}
          >
            {item.icon}
            {item.label}
          </button>
        ))}
      </div>

      {tab === 'restaurant' && (
        <SectionCard title={t('settings.restaurant')}>
          <div className="grid max-w-2xl gap-3 md:grid-cols-2">
            <Field label={t('settings.restaurantName')}>
              <input className="input" value={restaurant.name} onChange={(e) => setRestaurant({ ...restaurant, name: e.target.value })} />
            </Field>
            <Field label={t('settings.phone')}>
              <input className="input" dir="ltr" value={restaurant.phone} onChange={(e) => setRestaurant({ ...restaurant, phone: e.target.value })} />
            </Field>
            <Field label={t('settings.address')} className="md:col-span-2">
              <input className="input" value={restaurant.address} onChange={(e) => setRestaurant({ ...restaurant, address: e.target.value })} />
            </Field>
          </div>
          <div className="mt-4">
            <Button icon={saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} onClick={() => void saveKey('restaurant', restaurant)} disabled={saving}>
              {t('common.save')}
            </Button>
          </div>
        </SectionCard>
      )}

      {tab === 'tax' && (
        <SectionCard title={t('settings.tax')}>
          <div className="max-w-md space-y-4">
            <Switch checked={tax.enabled} onChange={(v) => setTax({ ...tax, enabled: v })} label={t('settings.taxEnabled')} />
            <Field label={t('settings.taxRate')}>
              <input className="input" inputMode="decimal" value={tax.rate} onChange={(e) => setTax({ ...tax, rate: e.target.value })} placeholder="0" />
            </Field>
            <Switch checked={tax.inclusive} onChange={(v) => setTax({ ...tax, inclusive: v })} label={t('settings.taxInclusive')} />
            <Button icon={saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} onClick={() => void saveKey('tax', { enabled: tax.enabled, rate: parseNum(tax.rate), inclusive: tax.inclusive })} disabled={saving}>
              {t('common.save')}
            </Button>
          </div>
        </SectionCard>
      )}

      {tab === 'receipt' && (
        <SectionCard title={t('settings.receipt')}>
          <div className="max-w-xl space-y-4">
            <Field label={t('settings.receiptFooter')}>
              <input className="input" value={receipt.footer} onChange={(e) => setReceipt({ ...receipt, footer: e.target.value })} />
            </Field>
            <div className="flex flex-wrap gap-6">
              <Switch checked={receipt.show_logo} onChange={(v) => setReceipt({ ...receipt, show_logo: v })} label={t('settings.showLogo')} />
              <Switch checked={receipt.show_tax} onChange={(v) => setReceipt({ ...receipt, show_tax: v })} label={t('settings.showTax')} />
              <Switch checked={receipt.show_cashier} onChange={(v) => setReceipt({ ...receipt, show_cashier: v })} label={t('settings.showCashier')} />
            </div>
            <Button icon={saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} onClick={() => void saveKey('receipt', receipt)} disabled={saving}>
              {t('common.save')}
            </Button>
          </div>
        </SectionCard>
      )}

      {tab === 'printing' && (
        <SectionCard title={t('settings.printing')}>
          <div className="max-w-xl space-y-4">
            <Field label={t('settings.printer')}>
              <Select value={printing.printer} onChange={(v) => setPrinting({ ...printing, printer: v })} options={printerOptions} />
            </Field>
            <Field label={t('settings.width')}>
              <Select
                value={printing.width}
                onChange={(v) => setPrinting({ ...printing, width: v })}
                options={[
                  { value: '80', ar: '80mm' },
                  { value: '58', ar: '58mm' }
                ]}
              />
            </Field>
            <div className="flex items-center gap-2">
              <Button icon={saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} onClick={() => void saveKey('printing', { width: Number(printing.width), printer: printing.printer })} disabled={saving}>
                {t('common.save')}
              </Button>
              <Button variant="ghost" icon={<Printer className="h-4 w-4" />} onClick={() => void testPrint()}>
                {t('settings.testPrint')}
              </Button>
            </div>
          </div>
        </SectionCard>
      )}

      {tab === 'session' && (
        <SectionCard title={t('settings.session')}>
          <div className="max-w-xs space-y-4">
            <Field label={t('settings.sessionTimeout')}>
              <input className="input" inputMode="numeric" value={sessionMin} onChange={(e) => setSessionMin(e.target.value)} placeholder="480" />
            </Field>
            <Button icon={saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} onClick={() => void saveKey('session', { timeout_minutes: Math.max(5, Math.round(parseNum(sessionMin))) })} disabled={saving}>
              {t('common.save')}
            </Button>
          </div>
        </SectionCard>
      )}


      {tab === 'backup' && (
        <SectionCard title={t('settings.backup')}>
          <div className="max-w-2xl space-y-3">
            <p className="rounded-xl bg-white/[0.03] p-3 text-[11px] leading-relaxed text-txt-faint">{t('settings.backupHint')}</p>
            <div className="flex flex-wrap gap-2">
              <Button
                icon={busyBackup ? <Loader2 className="h-4 w-4 animate-spin" /> : <DownloadCloud className="h-4 w-4" />}
                disabled={busyBackup}
                onClick={async () => {
                  setBusyBackup(true)
                  try {
                    const ok = await exportBackup(db, profile?.id ?? null)
                    if (ok) toast.success(t('settings.backupDone'))
                  } catch (err) {
                    toast.error(humanError(err))
                  } finally {
                    setBusyBackup(false)
                  }
                }}
              >
                {t('settings.backupExport')}
              </Button>
              <Button
                variant="ghost"
                icon={<UploadCloud className="h-4 w-4" />}
                disabled={busyBackup}
                onClick={() => setConfirmRestore(true)}
              >
                {t('settings.backupImport')}
              </Button>
            </div>
          </div>
        </SectionCard>
      )}

      {tab === 'about' && (
        <SectionCard title={t('settings.about')}>
          <div className="flex max-w-2xl flex-col gap-4 sm:flex-row sm:items-center">
            <LogoPreview />
            <div className="space-y-1 text-xs text-txt-dim">
              <div className="text-sm font-black">SUSHI ROLLS</div>
              <div>{t('settings.version')}: {version || '—'}</div>
            </div>
          </div>
        </SectionCard>
      )}

      <ConfirmDialog
        open={confirmRestore}
        onClose={() => setConfirmRestore(false)}
        title={t('settings.backupImport')}
        message={t('settings.backupConfirm')}
        confirmLabel={t('common.confirm')}
        onConfirm={async () => {
          setConfirmRestore(false)
          setBusyBackup(true)
          try {
            const res = await importBackup(db)
            if (res.ok) {
              toast.success(t('settings.restoreDone'))
              await refreshSettings()
            } else if (!res.canceled) {
              toast.error(res.error ?? t('settings.restoreBad'))
            }
          } finally {
            setBusyBackup(false)
          }
        }}
      />
    </div>
  )
}

function LogoPreview(): JSX.Element {
  const [logo, setLogo] = useState('')
  useEffect(() => {
    void logoDataUrl().then(setLogo)
  }, [])
  return (
    <div className="grid h-20 w-20 place-items-center rounded-2xl border border-line bg-ink-800/60 p-2">
      {logo ? <img src={logo} alt="SUSHI ROLLS" className="h-full w-full object-contain" /> : <HardDriveDownload className="h-6 w-6 text-txt-faint" />}
    </div>
  )
}
