import { useRef, useState } from 'react'
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/cn'
import { fmtDate, fromISODate, toISODate } from '@/lib/format'
import { t } from '@/i18n'
import { Popover } from './popover'

const WEEKDAYS = ['س', 'ح', 'ن', 'ث', 'ر', 'خ', 'ج']

function monthLabel(year: number, month: number): string {
  return new Intl.DateTimeFormat('ar-EG-u-nu-latn', { month: 'long', year: 'numeric' }).format(
    new Date(year, month, 1)
  )
}

export function DatePicker({
  value,
  onChange,
  className,
  placeholder = t('common.date')
}: {
  value: string | null
  onChange: (iso: string) => void
  className?: string
  placeholder?: string
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const initial = value ? fromISODate(value) : new Date()
  const [view, setView] = useState({ year: initial.getFullYear(), month: initial.getMonth() })

  const today = new Date()
  const todayISO = toISODate(today)
  const firstDay = new Date(view.year, view.month, 1)
  const startOffset = firstDay.getDay()
  const daysInMonth = new Date(view.year, view.month + 1, 0).getDate()
  const cells: (number | null)[] = [
    ...Array.from({ length: startOffset }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1)
  ]

  const shift = (dir: number): void => {
    setView((v) => {
      const next = new Date(v.year, v.month + dir, 1)
      return { year: next.getFullYear(), month: next.getMonth() }
    })
  }

  return (
    <div ref={ref} className={cn('relative', className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn('input flex items-center justify-between gap-2 text-start', !value && 'text-txt-faint')}
      >
        <span>{value ? fmtDate(value) : placeholder}</span>
        <CalendarDays className="h-4 w-4 shrink-0 text-txt-faint" />
      </button>
      <Popover
        open={open}
        anchorRef={ref}
        onClose={() => setOpen(false)}
        width={290}
        className="animate-pop rounded-2xl border border-white/[0.08] bg-[#0F1013]/95 p-3 shadow-card backdrop-blur-2xl"
      >
        <div className="mb-2 flex items-center justify-between">
            <button
              type="button"
              onClick={() => shift(1)}
              aria-label={t('common.next')}
              className="grid h-8 w-8 place-items-center rounded-lg text-txt-dim hover:bg-white/[0.06] hover:text-txt"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <div className="text-xs font-bold">{monthLabel(view.year, view.month)}</div>
            <button
              type="button"
              onClick={() => shift(-1)}
              aria-label={t('common.prev')}
              className="grid h-8 w-8 place-items-center rounded-lg text-txt-dim hover:bg-white/[0.06] hover:text-txt"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
          <div className="grid grid-cols-7 gap-1 text-center">
            {WEEKDAYS.map((d) => (
              <div key={d} className="py-1 text-[10px] font-bold text-txt-faint">
                {d}
              </div>
            ))}
            {cells.map((day, idx) => {
              if (day === null) return <div key={`e${idx}`} />
              const iso = toISODate(new Date(view.year, view.month, day))
              const selected = iso === value
              const isToday = iso === todayISO
              return (
                <button
                  key={iso}
                  type="button"
                  onClick={() => {
                    onChange(iso)
                    setOpen(false)
                  }}
                  className={cn(
                    'grid h-8 place-items-center rounded-lg text-xs font-semibold transition',
                    selected
                      ? 'bg-brand-red text-white'
                      : isToday
                        ? 'text-brand-gold ring-1 ring-brand-gold/50'
                        : 'text-txt-dim hover:bg-white/[0.07] hover:text-txt'
                  )}
                >
                  {day}
                </button>
              )
            })}
          </div>
          <div className="mt-2 flex items-center justify-between border-t border-white/[0.06] pt-2">
            <button
              type="button"
              onClick={() => {
                onChange(todayISO)
                setView({ year: today.getFullYear(), month: today.getMonth() })
                setOpen(false)
              }}
              className="text-[11px] font-bold text-brand-gold hover:underline"
            >
              {t('common.today')}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-[11px] font-semibold text-txt-faint hover:text-txt"
            >
              {t('common.close')}
            </button>
          </div>
      </Popover>
    </div>
  )
}
