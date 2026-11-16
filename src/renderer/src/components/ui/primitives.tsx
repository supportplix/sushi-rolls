import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowRight,
  Check,
  ChevronDown,
  Loader2,
  MoreVertical,
  Search,
  X
} from 'lucide-react'
import { cn } from '@/lib/cn'
import { t } from '@/i18n'
import type { Option } from '@/lib/constants'
import { Popover } from './popover'

/* ---------------------------------- Button --------------------------------- */

type ButtonVariant = 'primary' | 'gold' | 'ghost' | 'danger' | 'plain'
type ButtonSize = 'sm' | 'md' | 'lg'

export function Button({
  children,
  variant = 'primary',
  size = 'md',
  icon,
  className,
  type = 'button',
  ...rest
}: {
  children?: ReactNode
  variant?: ButtonVariant
  size?: ButtonSize
  icon?: ReactNode
} & React.ButtonHTMLAttributes<HTMLButtonElement>): JSX.Element {
  const variantClass =
    variant === 'primary'
      ? 'btn-primary'
      : variant === 'gold'
        ? 'btn-gold'
        : variant === 'danger'
          ? 'btn-danger-ghost'
          : variant === 'plain'
            ? 'text-txt-dim hover:text-txt hover:bg-white/[0.05]'
            : 'btn-ghost'
  const sizeClass = size === 'sm' ? 'btn-sm' : size === 'lg' ? 'btn-lg' : 'btn-md'
  return (
    <button type={type} className={cn('btn', sizeClass, variantClass, className)} {...rest}>
      {icon}
      {children}
    </button>
  )
}

export function IconButton({
  children,
  label,
  className,
  ...rest
}: { children: ReactNode; label: string } & React.ButtonHTMLAttributes<HTMLButtonElement>): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      className={cn(
        'grid h-9 w-9 place-items-center rounded-lg text-txt-dim transition hover:bg-white/[0.06] hover:text-txt',
        className
      )}
      {...rest}
    >
      {children}
    </button>
  )
}

/* ---------------------------------- Badge ---------------------------------- */

export function Badge({
  children,
  color,
  className
}: {
  children: ReactNode
  color?: string
  className?: string
}): JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border border-white/[0.06] bg-white/[0.04] px-2.5 py-1 text-[10.5px] font-bold leading-none backdrop-blur-sm',
        className
      )}
      style={
        color
          ? { color, backgroundColor: `${color}16`, borderColor: `${color}38` }
          : undefined
      }
    >
      {color && <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />}
      {children}
    </span>
  )
}

/* --------------------------------- Spinner --------------------------------- */

export function Spinner({ className }: { className?: string }): JSX.Element {
  return <Loader2 className={cn('h-5 w-5 animate-spin text-txt-dim', className)} />
}

export function PageLoader(): JSX.Element {
  return (
    <div className="grid h-64 place-items-center">
      <Spinner className="h-7 w-7" />
    </div>
  )
}

/* --------------------------------- Empty ---------------------------------- */

export function EmptyState({
  title,
  hint,
  icon,
  action
}: {
  title: string
  hint?: string
  icon?: ReactNode
  action?: ReactNode
}): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-14 text-center">
      {icon && <div className="grid h-14 w-14 place-items-center rounded-2xl border border-white/[0.06] bg-white/[0.03] text-txt-faint">{icon}</div>}
      <div className="text-sm font-semibold text-txt-dim">{title}</div>
      {hint && <div className="max-w-sm text-xs text-txt-faint">{hint}</div>}
      {action}
    </div>
  )
}

/* ---------------------------------- Field ---------------------------------- */

export function Field({
  label,
  children,
  className,
  hint
}: {
  label: string
  children: ReactNode
  className?: string
  hint?: string
}): JSX.Element {
  return (
    <div className={className}>
      <label className="label">{label}</label>
      {children}
      {hint && <p className="mt-1 text-[11px] text-txt-faint">{hint}</p>}
    </div>
  )
}

export function SearchInput({
  value,
  onChange,
  placeholder,
  className
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  className?: string
}): JSX.Element {
  return (
    <div className={cn('relative', className)}>
      <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-txt-faint" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="input ps-9"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label={t('common.close')}
          className="absolute end-2 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-md text-txt-faint hover:bg-white/[0.06] hover:text-txt"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  )
}

/* --------------------------------- Switch ---------------------------------- */

export function Switch({
  checked,
  onChange,
  label
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label?: string
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex items-center gap-2.5 text-sm text-txt"
    >
      <span
        className={cn(
          'relative h-6 w-11 rounded-full transition-colors',
          checked ? 'bg-brand-red' : 'bg-line-2'
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all',
            checked ? 'start-[22px]' : 'start-0.5'
          )}
        />
      </span>
      {label && <span>{label}</span>}
    </button>
  )
}

/* ---------------------------------- Tabs ----------------------------------- */

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  className
}: {
  tabs: { value: T; label: string; icon?: ReactNode }[]
  value: T
  onChange: (v: T) => void
  className?: string
}): JSX.Element {
  return (
    <div className={cn('flex flex-wrap items-center gap-1 rounded-2xl border border-white/[0.06] bg-white/[0.03] p-1 backdrop-blur-xl', className)}>
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          onClick={() => onChange(tab.value)}
          className={cn(
            'flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold transition-all',
            value === tab.value
              ? 'bg-white/[0.08] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.07)]'
              : 'text-txt-faint hover:text-txt-dim'
          )}
        >
          {tab.icon}
          {tab.label}
        </button>
      ))}
    </div>
  )
}

/* -------------------------------- Skeleton --------------------------------- */

export function Skeleton({ className }: { className?: string }): JSX.Element {
  return (
    <div
      className={cn(
        'animate-pulse rounded-2xl border border-white/[0.04] bg-gradient-to-r from-white/[0.04] via-white/[0.07] to-white/[0.04]',
        className
      )}
    />
  )
}

/* --------------------------------- Layout ---------------------------------- */

export function PageHeader({
  title,
  subtitle,
  actions
}: {
  title: string
  subtitle?: string
  actions?: ReactNode
}): JSX.Element {
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 className="page-title">{title}</h1>
        {subtitle && <p className="page-sub">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

export function SectionCard({
  title,
  subtitle,
  actions,
  children,
  className,
  bodyClassName
}: {
  title?: string
  subtitle?: string
  actions?: ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
}): JSX.Element {
  return (
    <section className={cn('card overflow-hidden', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-white/[0.06] px-5 py-4">
          <div>
            {title && <h2 className="text-sm font-bold tracking-tight">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-[11px] text-txt-faint">{subtitle}</p>}
          </div>
          {actions}
        </header>
      )}
      <div className={cn(bodyClassName)}>{children}</div>
    </section>
  )
}

export function StatCard({
  label,
  value,
  icon,
  hint,
  accent = 'red'
}: {
  label: string
  value: string
  icon: ReactNode
  hint?: string
  accent?: 'red' | 'gold' | 'green' | 'dim'
}): JSX.Element {
  const tone =
    accent === 'red'
      ? 'bg-brand-red/[0.12] text-brand-redSoft'
      : accent === 'gold'
        ? 'bg-brand-gold/[0.12] text-brand-gold'
        : accent === 'green'
          ? 'bg-emerald-500/[0.12] text-emerald-400'
          : 'bg-white/[0.05] text-txt-dim'
  return (
    <div className="card group flex items-center gap-4 overflow-hidden p-4 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-lift">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-6 top-0 h-px bg-gradient-to-l from-transparent via-white/20 to-transparent"
      />
      <div className={cn('grid h-12 w-12 shrink-0 place-items-center rounded-2xl border border-white/[0.06]', tone)}>{icon}</div>
      <div className="min-w-0">
        <div className="text-[11px] font-semibold tracking-wide text-txt-faint">{label}</div>
        <div className="kpi-value truncate">{value}</div>
        {hint && <div className="mt-0.5 truncate text-[11px] text-txt-faint">{hint}</div>}
      </div>
    </div>
  )
}

export function TableWrap({ children, className }: { children: ReactNode; className?: string }): JSX.Element {
  return (
    <div className={cn('overflow-x-auto', className)}>
      <table className="table-base">{children}</table>
    </div>
  )
}

/* --------------------------------- RowMenu --------------------------------- */

export interface MenuItemDef {
  label: string
  icon?: ReactNode
  onClick: () => void
  danger?: boolean
  disabled?: boolean
}

export function RowMenu({ items, label = t('common.actions') }: { items: MenuItemDef[]; label?: string }): JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  return (
    <div ref={ref} className="relative inline-block">
      <IconButton label={label} onClick={() => setOpen((v) => !v)}>
        <MoreVertical className="h-4 w-4" />
      </IconButton>
      <Popover
        open={open}
        anchorRef={ref}
        onClose={() => setOpen(false)}
        width={208}
        className="animate-pop overflow-hidden rounded-2xl border border-white/[0.08] bg-[#0F1013]/95 p-1 shadow-card backdrop-blur-2xl"
      >
        {items.map((item) => (
          <button
            key={item.label}
            type="button"
            disabled={item.disabled}
            onClick={() => {
              setOpen(false)
              item.onClick()
            }}
            className={cn(
              'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-start text-xs font-semibold transition disabled:opacity-40',
              item.danger
                ? 'text-brand-redSoft hover:bg-brand-red/10'
                : 'text-txt hover:bg-white/[0.06]'
            )}
          >
            {item.icon}
            {item.label}
          </button>
        ))}
      </Popover>
    </div>
  )
}

/* --------------------------------- Select ---------------------------------- */

export function Select({
  value,
  onChange,
  options,
  placeholder = t('common.select'),
  className,
  disabled,
  compact
}: {
  value: string
  onChange: (v: string) => void
  options: Option[] | { value: string; ar: string }[]
  placeholder?: string
  className?: string
  disabled?: boolean
  compact?: boolean
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const selected = options.find((o) => o.value === value)

  return (
    <div ref={ref} className={cn('relative', className)}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'input flex items-center justify-between gap-2 text-start disabled:opacity-50',
          compact && 'px-3 py-2 text-xs',
          !selected && 'text-txt-faint'
        )}
      >
        <span className="truncate">{selected ? selected.ar : placeholder}</span>
        <ChevronDown className={cn('h-4 w-4 shrink-0 text-txt-faint transition', open && 'rotate-180')} />
      </button>
      <Popover
        open={open}
        anchorRef={ref}
        onClose={() => setOpen(false)}
        matchWidth
        className="animate-pop max-h-64 overflow-y-auto rounded-2xl border border-white/[0.08] bg-[#0F1013]/95 p-1 shadow-card backdrop-blur-2xl"
      >
        {options.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => {
              onChange(opt.value)
              setOpen(false)
            }}
            className={cn(
              'flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-start text-xs font-semibold transition',
              opt.value === value ? 'bg-brand-red/[0.12] text-brand-redSoft' : 'text-txt hover:bg-white/[0.06]'
            )}
          >
            <span className="truncate">{opt.ar}</span>
            {opt.value === value && <Check className="h-3.5 w-3.5" />}
          </button>
        ))}
      </Popover>
    </div>
  )
}

export { ArrowRight }
