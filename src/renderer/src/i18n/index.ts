import { ar, type DictKey } from './ar'

export function t(key: DictKey | string, vars?: Record<string, string | number>): string {
  let text = (ar as Record<string, string>)[key] ?? key
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      text = text.replaceAll(`{${k}}`, String(v))
    }
  }
  return text
}

export { ar }
export type { DictKey }
