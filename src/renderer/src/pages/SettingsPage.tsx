import { useEffect, useMemo, useState } from 'react'
import {
  AlertCircle,
  Building2,
  CheckCircle2,
  DownloadCloud,
  HardDriveDownload,
  Info,
  Loader2,
  Printer,
  ReceiptText,
  RefreshCw,
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
import { checkForUpdates, installUpdate, useUpdateStatus } from '@/lib/updates'

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
        <div className="grid gap-3 lg:grid-cols-[1.05fr_1fr] lg:items-start">
          <SectionCard bodyClassName="p-0">
            <div className="relative flex flex-col items-center overflow-hidden px-6 py-8 text-center">
              <div
                aria-hidden
                className="pointer-events-none absolute inset-x-10 top-0 h-px bg-gradient-to-l from-transparent via-brand-gold/60 to-transparent"
              />
              <LogoPreview />
              <div className="mt-4">
                <div className="text-lg font-black tracking-tight">SUSHI ROLLS</div>
                <div className="mt-0.5 text-[11px] font-semibold text-txt-faint">{t('app.tagline')}</div>
              </div>
              <div className="mt-3 inline-flex items-center gap-2 rounded-full border border-white/[0.06] bg-white/[0.03] px-3 py-1.5 text-[10.5px] font-semibold text-txt-dim">
                {t('updates.current')}
                <span className="font-black text-brand-gold">v{version || '—'}</span>
              </div>
              <div className="mt-4 flex items-center gap-2 text-xs text-txt-dim">
                <span className="text-txt-faint">{t('updates.developer')}</span>
                <span className="font-black text-txt">{t('updates.developerName')}</span>
              </div>
              <div className="mt-1 text-[10px] text-txt-faint">{t('updates.copyright')}</div>
            </div>
          </SectionCard>
          <UpdatePanel version={version} />
        </div>
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

function UpdatePanel({ version }: { version: string }): JSX.Element {
  const update = useUpdateStatus()
  const toast = useToast()
  const percent = Math.max(0, Math.min(100, update.percent ?? 0))
  const displayVersion = version || update.currentVersion || '—'
  const checking = update.state === 'checking'
  const downloading = update.state === 'downloading' || update.state === 'available'
  const downloaded = update.state === 'downloaded'

  const statuses = {
    idle: { icon: <RefreshCw className="h-4 w-4" />, tone: 'dim', title: t('updates.idleTitle'), hint: t('updates.idleHint') },
    dev: { icon: <Info className="h-4 w-4" />, tone: 'dim', title: t('updates.dev'), hint: t('updates.devHint') },
    checking: { icon: <Loader2 className="h-4 w-4 animate-spin" />, tone: 'gold', title: t('updates.checking'), hint: t('updates.checkingHint') },
    available: { icon: <DownloadCloud className="h-4 w-4" />, tone: 'gold', title: t('updates.available'), hint: t('updates.availableHint') },
    downloading: { icon: <DownloadCloud className="h-4 w-4" />, tone: 'gold', title: t('updates.downloading'), hint: t('updates.downloadingHint') },
    downloaded: { icon: <CheckCircle2 className="h-4 w-4" />, tone: 'green', title: t('updates.readyTitle'), hint: t('updates.readyHint') },
    'up-to-date': { icon: <CheckCircle2 className="h-4 w-4" />, tone: 'green', title: t('updates.upToDate'), hint: t('updates.upToDateHint') },
    error: { icon: <AlertCircle className="h-4 w-4" />, tone: 'red', title: t('updates.error'), hint: t('updates.errorHint') }
  }
  const current = statuses[update.state]
  const tone =
    current.tone === 'green'
      ? 'border-emerald-400/20 bg-emerald-500/[0.08] text-emerald-400'
      : current.tone === 'gold'
        ? 'border-brand-gold/25 bg-brand-gold/[0.08] text-brand-gold'
        : current.tone === 'red'
          ? 'border-brand-red/[0.3] bg-brand-red/[0.1] text-brand-redSoft'
          : 'border-white/[0.06] bg-white/[0.03] text-txt-dim'

  const check = async (): Promise<void> => {
    const next = await checkForUpdates()
    if (next.state === 'dev') toast.info(t('updates.devHint'))
    else if (next.state === 'error') toast.error(t('updates.error'))
  }

  const restart = async (): Promise<void> => {
    const res = await installUpdate()
    if (!res.ok) toast.info(t('updates.notReady'))
  }

  return (
    <SectionCard title={t('updates.title')} subtitle={t('updates.subtitle')} bodyClassName="p-4">
      <div className="space-y-4">
        <div className="flex items-start gap-3 rounded-2xl border border-white/[0.06] bg-white/[0.025] p-4">
          <span className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-xl border', tone)}>{current.icon}</span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-bold">{current.title}</div>
            <div className="mt-0.5 text-[11px] leading-relaxed text-txt-faint">{current.hint}</div>
            {downloading && (
              <div className="mt-3">
                <div className="mb-1 flex items-center justify-between text-[10px] text-txt-faint">
                  <span>{update.version ? `v${update.version}` : ''}</span>
                  <span>{percent}%</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
                  <div className="h-full rounded-full bg-brand-gold transition-all duration-500" style={{ width: `${Math.max(2, percent)}%` }} />
                </div>
              </div>
            )}
            {downloaded && update.version && (
              <div className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-emerald-400/20 bg-emerald-500/[0.08] px-2.5 py-1 text-[10px] font-bold text-emerald-400">
                v{update.version}
              </div>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {downloaded ? (
            <Button variant="gold" icon={<RefreshCw className="h-4 w-4" />} onClick={() => void restart()}>
              {t('updates.restart')}
            </Button>
          ) : (
            <Button
              variant="ghost"
              icon={checking ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              disabled={checking || downloading}
              onClick={() => void check()}
            >
              {checking ? t('updates.checking') : update.state === 'error' ? t('updates.retry') : t('updates.check')}
            </Button>
          )}
        </div>
        <div className="flex items-center justify-between border-t border-white/[0.06] pt-3 text-[10px] text-txt-faint">
          <span>{t('updates.channel')}</span>
          <span className="font-semibold text-txt-dim">{t('updates.current')} · v{displayVersion}</span>
        </div>
      </div>
    </SectionCard>
  )
}
