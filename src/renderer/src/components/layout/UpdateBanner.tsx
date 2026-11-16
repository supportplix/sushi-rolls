import { CheckCircle2, Download, RefreshCw } from 'lucide-react'
import { t } from '@/i18n'
import { Button } from '@/components/ui/primitives'
import { useToast } from '@/components/ui/toast'
import { installUpdate, useUpdateStatus } from '@/lib/updates'

export function UpdateBanner(): JSX.Element | null {
  const update = useUpdateStatus()
  const toast = useToast()

  if (update.state !== 'downloaded' && update.state !== 'downloading' && update.state !== 'available') {
    return null
  }

  const ready = update.state === 'downloaded'
  const percent = Math.max(0, Math.min(100, update.percent ?? 0))

  const restart = async (): Promise<void> => {
    const res = await installUpdate()
    if (!res.ok) toast.info(t('updates.notReady'))
  }

  return (
    <div className="mx-3 mt-2 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-brand-gold/25 bg-gradient-to-l from-brand-gold/[0.12] via-white/[0.04] to-transparent px-4 py-2.5">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-brand-gold/[0.12] text-brand-gold">
          {ready ? <CheckCircle2 className="h-4 w-4" /> : <Download className="h-4 w-4" />}
        </span>
        <div className="min-w-0">
          <div className="text-xs font-bold">
            {ready ? t('updates.readyBanner') : t('updates.downloadingTitle')}
          </div>
          <div className="mt-0.5 truncate text-[10.5px] text-txt-faint">
            {ready
              ? `${t('updates.readyHint')}${update.version ? ` · v${update.version}` : ''}`
              : `${update.version ? `v${update.version} · ` : ''}${percent}%`}
          </div>
        </div>
      </div>

      {ready ? (
        <Button size="sm" variant="gold" icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => void restart()}>
          {t('updates.restart')}
        </Button>
      ) : (
        <div className="h-1.5 min-w-[140px] flex-1 overflow-hidden rounded-full bg-white/[0.06]">
          <div className="h-full rounded-full bg-brand-gold transition-all duration-500" style={{ width: `${Math.max(2, percent)}%` }} />
        </div>
      )}
    </div>
  )
}
