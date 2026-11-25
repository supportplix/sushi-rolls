import logoUrl from '@/assets/logo-sm.png'
import printLogoUrl from '@/assets/logo-print.png'
import fontAr from '@/assets/fonts/cairo-arabic.woff2'

let cachedLogo: string | null = null
let cachedPrintLogo: string | null = null
let cachedFont: string | null = null

async function toDataUrl(url: string): Promise<string> {
  const res = await fetch(url)
  const blob = await res.blob()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

export async function logoDataUrl(): Promise<string> {
  if (cachedLogo) return cachedLogo
  try {
    cachedLogo = await toDataUrl(logoUrl)
  } catch {
    cachedLogo = ''
  }
  return cachedLogo
}

export async function printLogoDataUrl(): Promise<string> {
  if (cachedPrintLogo) return cachedPrintLogo
  try {
    cachedPrintLogo = await toDataUrl(printLogoUrl)
  } catch {
    cachedPrintLogo = ''
  }
  return cachedPrintLogo
}

export async function fontDataUrl(): Promise<string> {
  if (cachedFont) return cachedFont
  try {
    cachedFont = await toDataUrl(fontAr)
  } catch {
    cachedFont = ''
  }
  return cachedFont
}
