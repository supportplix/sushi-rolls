import { t } from '@/i18n'

export function errorCode(err: unknown): string {
  const raw =
    (err as { message?: string })?.message ??
    (err as { error?: string })?.error ??
    (typeof err === 'string' ? err : '')
  const match = raw.match(/([A-Z][A-Z0-9_]{3,})(?::[^\s]*)?/)
  return match ? match[1] : ''
}

export function humanError(err: unknown, includeDetails = false): string {
  const raw =
    (err as { message?: string })?.message ??
    (err as { error?: string })?.error ??
    (typeof err === 'string' ? err : '')
  if (raw.startsWith('SERVICE_ACTION_FAILED:')) return raw.slice('SERVICE_ACTION_FAILED:'.length).trim()
  const code = errorCode(err)
  if (/^SERVICE_EXIT_\d+$/.test(code)) return t('error.SERVICE_EXIT', { code: code.slice('SERVICE_EXIT_'.length) })
  const translated = code ? t(`error.${code}`) : ''
  if (translated && translated !== `error.${code}`) return translated
  if (raw.includes('Failed to fetch') || raw.includes('fetch failed')) return t('error.CONNECTION')
  if (includeDetails && raw) return raw
  console.error('[sushi]', err)
  return t('common.error')
}

export function invokeError(err: unknown, body?: unknown): string {
  const data = body as { error?: string } | undefined
  if (data?.error) {
    const translated = t(`error.${data.error}`)
    if (translated !== `error.${data.error}`) return translated
  }
  console.error('[sushi]', err ?? body)
  return t('common.error')
}
