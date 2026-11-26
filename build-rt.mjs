import { build } from 'esbuild'
import { readFileSync, writeFileSync } from 'fs'

const ROOT = '/sessions/optimistic-exciting-brahmagupta/mnt/SUSHI ROLLS'
const RT = '/sessions/optimistic-exciting-brahmagupta/tmp/rt'

const arSrc = readFileSync(ROOT + '/src/renderer/src/i18n/ar.ts', 'utf8')
const ar: Record<string, string> = {}
for (const m of arSrc.matchAll(/'([^']+)':\s*(?:'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`)/g)) {
  ar[m[1]] = m[2] ?? m[3] ?? ''
}

const logoShim = `import { readFileSync } from 'fs'
const R = '${ROOT}'
let _l = null, _f = null
export async function logoDataUrl(){ if(!_l) _l = 'data:image/png;base64,' + readFileSync(R + '/src/renderer/src/assets/logo-sm.png').toString('base64'); return _l }
export async function printLogoDataUrl(){ return logoDataUrl() }
export async function fontDataUrl(){ if(!_f) _f = 'data:font/woff2;base64,' + readFileSync(R + '/src/renderer/src/assets/fonts/cairo-arabic.woff2').toString('base64'); return _f }
`

writeFileSync(RT + '/shims/i18n.js', `const ar = ${JSON.stringify(ar)}; export function t(k){ return ar[k] ?? k }`)
writeFileSync(RT + '/shims/logo.js', logoShim)
writeFileSync(RT + '/shims/ipc.js', `export const api = { print: { receipt: async () => ({ ok: true }), pdf: async () => ({ ok: true }), printers: async () => [] } }`)

const entry = `export { buildThermalReceiptHtml, buildKitchenTicketHtml } from '${ROOT}/src/renderer/src/lib/receipt'`
writeFileSync(RT + '/entry.ts', entry)

const r = await build({
  entryPoints: [RT + '/entry.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  alias: {
    '@/lib/types': ROOT + '/src/renderer/src/lib/types.ts',
    '@/lib/format': ROOT + '/src/renderer/src/lib/format.ts',
    '@/lib/logo': RT + '/shims/logo.js',
    '@/lib/constants': ROOT + '/src/renderer/src/lib/constants.ts',
    '@/lib/ipc': RT + '/shims/ipc.js',
    '@/i18n': RT + '/shims/i18n.js'
  },
  logLevel: 'warning'
})

const code = r.outputFiles[0].text
writeFileSync(RT + '/receipt.bundle.mjs', code)
const mod = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))
console.log('OK exports:', Object.keys(mod).join(', '))