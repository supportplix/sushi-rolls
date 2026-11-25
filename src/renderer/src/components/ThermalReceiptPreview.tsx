import { useEffect, useRef, useState } from 'react'
import { Printer, ZoomIn, ZoomOut, Check } from 'lucide-react'
import { buildThermalReceiptHtml, printThermalReceipt, type ReceiptData } from '@/lib/receipt'
import { cn } from '@/lib/cn'
import { t } from '@/i18n'

interface ThermalReceiptPreviewProps {
  data: ReceiptData
  initialWidth?: 58 | 80
  onWidthChange?: (width: 58 | 80) => void
  onPrint?: () => void
  showActions?: boolean
  className?: string
}

export function ThermalReceiptPreview({
  data,
  initialWidth,
  onWidthChange,
  onPrint,
  showActions = true,
  className
}: ThermalReceiptPreviewProps): JSX.Element {
  const [width, setWidth] = useState<58 | 80>(initialWidth ?? (data.settings.printing?.width === 58 ? 58 : 80))
  const [html, setHtml] = useState<string>('')
  const [iframeHeight, setIframeHeight] = useState<number>(500)
  const [printing, setPrinting] = useState<boolean>(false)
  const [scale, setScale] = useState<number>(1)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  useEffect(() => {
    if (initialWidth && initialWidth !== width) {
      setWidth(initialWidth)
    }
  }, [initialWidth])

  const handleWidthChange = (newWidth: 58 | 80): void => {
    setWidth(newWidth)
    onWidthChange?.(newWidth)
  }

  useEffect(() => {
    let canceled = false
    const previewSettings = {
      ...data.settings,
      printing: {
        ...data.settings.printing,
        width
      }
    }

    void buildThermalReceiptHtml({ ...data, settings: previewSettings }).then((res) => {
      if (!canceled) {
        setHtml(res)
      }
    })

    return () => {
      canceled = true
    }
  }, [data, width])

  const handleIframeLoad = (): void => {
    const doc = iframeRef.current?.contentDocument
    if (!doc) return

    const updateHeight = (): void => {
      try {
        const height = Math.ceil(
          Math.max(
            doc.documentElement.scrollHeight,
            doc.body.scrollHeight,
            doc.body.getBoundingClientRect().height,
            doc.documentElement.getBoundingClientRect().height
          )
        )
        if (height > 0) {
          setIframeHeight(height + 10)
        }
      } catch {
        // fallback
      }
    }

    updateHeight()
    if (doc.fonts) {
      void doc.fonts.ready.then(updateHeight)
    }
    const images = Array.from(doc.images)
    if (images.length > 0) {
      let loaded = 0
      images.forEach((img) => {
        if (img.complete) {
          loaded++
        } else {
          img.onload = () => {
            loaded++
            if (loaded === images.length) updateHeight()
          }
        }
      })
      if (loaded === images.length) updateHeight()
    }
    setTimeout(updateHeight, 250)
  }

  const handlePrint = async (): Promise<void> => {
    if (onPrint) {
      onPrint()
      return
    }
    setPrinting(true)
    try {
      const printData = {
        ...data,
        settings: {
          ...data.settings,
          printing: {
            ...data.settings.printing,
            width
          }
        }
      }
      await printThermalReceipt(printData)
    } finally {
      setPrinting(false)
    }
  }

  // Paper width styles:
  // 58mm = ~220px @ 96 DPI, 80mm = ~302px @ 96 DPI
  const paperPx = width === 58 ? 220 : 304

  return (
    <div className={cn('flex flex-col items-center gap-3', className)}>
      {showActions && (
        <div className="flex w-full flex-wrap items-center justify-between gap-2 rounded-xl border border-white/[0.08] bg-white/[0.03] p-2">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] font-semibold text-txt-dim">{t('settings.width')}:</span>
            <button
              type="button"
              onClick={() => handleWidthChange(58)}
              className={cn(
                'flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-bold transition-all',
                width === 58
                  ? 'bg-brand-red text-white shadow-sm'
                  : 'bg-white/[0.06] text-txt-dim hover:bg-white/[0.1] hover:text-white'
              )}
            >
              {width === 58 && <Check className="h-3 w-3" />}
              58mm
            </button>
            <button
              type="button"
              onClick={() => handleWidthChange(80)}
              className={cn(
                'flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-bold transition-all',
                width === 80
                  ? 'bg-brand-red text-white shadow-sm'
                  : 'bg-white/[0.06] text-txt-dim hover:bg-white/[0.1] hover:text-white'
              )}
            >
              {width === 80 && <Check className="h-3 w-3" />}
              80mm
            </button>
          </div>

          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setScale((s) => Math.max(0.7, Number((s - 0.1).toFixed(1))))}
                disabled={scale <= 0.7}
                className="rounded-lg p-1 text-txt-dim hover:bg-white/[0.08] hover:text-white disabled:opacity-30"
                title="تصغير"
              >
                <ZoomOut className="h-3.5 w-3.5" />
              </button>
              <span className="text-[10px] tabular-nums text-txt-faint">{Math.round(scale * 100)}%</span>
              <button
                type="button"
                onClick={() => setScale((s) => Math.min(1.4, Number((s + 0.1).toFixed(1))))}
                disabled={scale >= 1.4}
                className="rounded-lg p-1 text-txt-dim hover:bg-white/[0.08] hover:text-white disabled:opacity-30"
                title="تكبير"
              >
                <ZoomIn className="h-3.5 w-3.5" />
              </button>
            </div>

            <button
              type="button"
              onClick={() => void handlePrint()}
              disabled={printing}
              className="flex items-center gap-1.5 rounded-lg bg-white/[0.08] px-3 py-1 text-xs font-bold text-white transition-all hover:bg-white/[0.14] disabled:opacity-50"
            >
              <Printer className="h-3.5 w-3.5" />
              {t('orders.reprint')}
            </button>
          </div>
        </div>
      )}

      {/* Simulated Thermal Paper Roll with realistic paper aesthetics */}
      <div className="flex w-full justify-center overflow-x-auto py-2">
        <div
          className="relative transition-all duration-200"
          style={{
            width: paperPx,
            transform: scale !== 1 ? `scale(${scale})` : undefined,
            transformOrigin: 'top center'
          }}
        >
          {/* Paper top edge cut indicator */}
          <div className="h-1.5 w-full rounded-t-sm bg-gradient-to-r from-neutral-300 via-neutral-100 to-neutral-300 shadow-inner" />

          {/* Paper body */}
          <div className="relative rounded-b-sm bg-white shadow-[0_12px_36px_rgba(0,0,0,0.55),0_2px_8px_rgba(0,0,0,0.25)] ring-1 ring-black/5">
            <iframe
              ref={iframeRef}
              srcDoc={html}
              onLoad={handleIframeLoad}
              title="Thermal Receipt Preview"
              style={{
                width: '100%',
                height: `${iframeHeight}px`,
                border: 'none',
                display: 'block',
                background: '#ffffff'
              }}
              sandbox="allow-same-origin"
            />
          </div>

          {/* Paper bottom cut serration */}
          <div className="mt-0.5 flex h-1.5 w-full items-center justify-between overflow-hidden opacity-60">
            {Array.from({ length: 30 }).map((_, i) => (
              <span key={i} className="inline-block h-1 w-1 rotate-45 bg-neutral-400/40" />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
