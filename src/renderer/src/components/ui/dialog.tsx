import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from './primitives'
import { t } from '@/i18n'

export function Dialog({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  size = 'md'
}: {
  open: boolean
  onClose: () => void
  title: string
  subtitle?: string
  children: ReactNode
  footer?: ReactNode
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full'
}): JSX.Element | null {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const width =
    size === 'sm'
      ? 'max-w-md'
      : size === 'lg'
        ? 'max-w-3xl'
        : size === 'xl'
          ? 'max-w-5xl'
          : size === 'full'
            ? 'max-w-[95vw]'
            : 'max-w-xl'

  return createPortal(
    <div className="fixed inset-0 z-[150] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-md"
        onClick={onClose}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          'relative flex max-h-[92vh] w-full flex-col overflow-hidden rounded-[28px] border border-white/[0.08] bg-[#0C0D10]/[0.92] shadow-card backdrop-blur-2xl animate-pop',
          width
        )}
      >
        <header className="flex items-start justify-between gap-4 border-b border-white/[0.06] px-5 py-4">
          <div>
            <h2 className="text-base font-bold tracking-tight">{title}</h2>
            {subtitle && <p className="mt-0.5 text-xs text-txt-faint">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="grid h-8 w-8 place-items-center rounded-lg text-txt-dim transition hover:bg-white/[0.07] hover:text-txt"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="scroll-area flex-1 px-5 py-4">{children}</div>
        {footer && <footer className="flex items-center justify-end gap-2 border-t border-white/[0.06] bg-white/[0.015] px-5 py-3.5">{footer}</footer>}
      </div>
    </div>,
    document.body
  )
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel = t('common.confirm'),
  danger = true,
  loading
}: {
  open: boolean
  onClose: () => void
  onConfirm: () => void
  title: string
  message: string
  confirmLabel?: string
  danger?: boolean
  loading?: boolean
}): JSX.Element {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={loading}>
            {t('common.cancel')}
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            onClick={onConfirm}
            disabled={loading}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-sm leading-relaxed text-txt-dim">{message}</p>
    </Dialog>
  )
}
