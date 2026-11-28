export type Lang = 'ar' | 'en'

export function money(value: number | string | null | undefined, lang: Lang = 'ar'): string {
  const n = Number(value ?? 0)
  const neg = n < 0
  const abs = Math.abs(n)
  const rounded = Math.round(abs * 100) / 100
  let text = Number.isInteger(rounded)
    ? String(rounded)
    : rounded.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
  if (rounded >= 1000) {
    text = Number(rounded).toLocaleString('en-US', { maximumFractionDigits: 2 })
  }
  const suffix = lang === 'ar' ? 'ج.م.' : 'EGP'
  return `${neg ? '-' : ''}${text} ${suffix}`
}

export function num(value: number | string | null | undefined, maxFrac = 2): string {
  const n = Number(value ?? 0)
  return n.toLocaleString('en-US', { maximumFractionDigits: maxFrac })
}

const ARABIC_INDIC_DIGITS = '٠١٢٣٤٥٦٧٨٩'
const EXTENDED_ARABIC_DIGITS = '۰۱۲۳۴۵۶۷۸۹'

/** Money inputs may contain Arabic-Indic digits and Arabic decimal separators. */
function normalizeNumeric(value: string): string {
  let out = ''
  for (const char of String(value)) {
    const arabic = ARABIC_INDIC_DIGITS.indexOf(char)
    if (arabic !== -1) {
      out += String(arabic)
      continue
    }
    const extended = EXTENDED_ARABIC_DIGITS.indexOf(char)
    if (extended !== -1) {
      out += String(extended)
      continue
    }
    out += char
  }
  return out
    .replace(/٫/g, '.') // Arabic decimal separator
    .replace(/[٬،,]/g, ',') // Arabic/Persian/Latin thousands separators
    .replace(/−/g, '-') // Unicode minus
}

export function parseNum(value: string): number {
  if (!value) return 0
  const normalized = normalizeNumeric(value).replace(/,/g, '')
  const match = normalized.match(/-?\d*\.?\d+/)
  if (!match) return 0
  const n = Number(match[0])
  return Number.isFinite(n) ? n : 0
}

export function pct(n: number): string {
  return `${num(n, 1)}%`
}

const locale = (lang: Lang): string => (lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB')

export function fmtDate(d: string | Date, lang: Lang = 'ar'): string {
  const date = typeof d === 'string' ? new Date(d) : d
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat(locale(lang), {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  }).format(date)
}

export function fmtTime(d: string | Date, lang: Lang = 'ar'): string {
  const date = typeof d === 'string' ? new Date(d) : d
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat(locale(lang), {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  }).format(date)
}

export function fmtDateTime(d: string | Date, lang: Lang = 'ar'): string {
  return `${fmtDate(d, lang)} · ${fmtTime(d, lang)}`
}

export function startOfDay(d: Date = new Date()): Date {
  const c = new Date(d)
  c.setHours(0, 0, 0, 0)
  return c
}

export function endOfDay(d: Date = new Date()): Date {
  const c = new Date(d)
  c.setHours(23, 59, 59, 999)
  return c
}

export function addDays(d: Date, days: number): Date {
  const c = new Date(d)
  c.setDate(c.getDate() + days)
  return c
}

export function startOfWeek(d: Date = new Date()): Date {
  const c = startOfDay(d)
  const day = c.getDay()
  c.setDate(c.getDate() - day)
  return c
}

export function startOfMonth(d: Date = new Date()): Date {
  const c = startOfDay(d)
  c.setDate(1)
  return c
}

export type Period = 'today' | 'yesterday' | 'week' | 'month'

export function rangeFor(period: Period): { from: Date; to: Date } {
  const now = new Date()
  if (period === 'today') return { from: startOfDay(now), to: endOfDay(now) }
  if (period === 'yesterday') {
    const y = addDays(now, -1)
    return { from: startOfDay(y), to: endOfDay(y) }
  }
  if (period === 'week') return { from: startOfWeek(now), to: endOfDay(now) }
  return { from: startOfMonth(now), to: endOfDay(now) }
}

export function toISODate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function fromISODate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, (m ?? 1) - 1, d ?? 1)
}

export function fmtHour(d: string | Date, lang: Lang = 'ar'): string {
  const date = typeof d === 'string' ? new Date(d) : d
  return new Intl.DateTimeFormat(locale(lang), { hour: '2-digit', hour12: true }).format(date)
}

export function elapsedSince(iso: string, now: number = Date.now()): { minutes: number; text: string } {
  const start = new Date(iso).getTime()
  const minutes = Math.max(0, Math.floor((now - start) / 60000))
  if (minutes < 60) return { minutes, text: `${minutes} د` }
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return { minutes, text: `${h} س ${m} د` }
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/)
  return (parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')
}
