import * as XLSX from 'xlsx'
import { api } from './ipc'

function download(dataBase64: string, fileName: string, filters: { name: string; extensions: string[] }[]): Promise<boolean> {
  return api.file.save({ dataBase64, fileName, filters }).then((r) => r.ok)
}

// Excel/Sheets evaluate cells beginning with these characters as formulas.
// Leading whitespace is included because spreadsheet apps trim before parsing.
const CSV_FORMULA_PREFIX = /^\s*[=+\-@]|^[\t\r]/

export function toCsv(headers: string[], rows: (string | number)[][]): string {
  const escape = (v: string | number): string => {
    if (typeof v !== 'string') return String(v ?? '')
    const s = String(v ?? '')
    // A leading apostrophe keeps the visible text unchanged while forcing the
    // cell to be imported as text. Numeric cells are safe and left untouched.
    const safe = CSV_FORMULA_PREFIX.test(s) ? `'${s}` : s
    return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe
  }
  return [headers, ...rows].map((r) => r.map(escape).join(',')).join('\r\n')
}

export async function exportCsv(name: string, headers: string[], rows: (string | number)[][]): Promise<boolean> {
  const csv = '\uFEFF' + toCsv(headers, rows)
  const b64 = btoa(unescape(encodeURIComponent(csv)))
  return download(b64, `${name}.csv`, [{ name: 'CSV', extensions: ['csv'] }])
}

export async function exportXlsx(name: string, sheet: string, headers: string[], rows: (string | number)[][]): Promise<boolean> {
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows])
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, sheet.slice(0, 30))
  const b64 = XLSX.write(wb, { type: 'base64', bookType: 'xlsx' }) as string
  return download(b64, `${name}.xlsx`, [{ name: 'Excel', extensions: ['xlsx'] }])
}

// Row and header values come from user-entered DB records; unescaped markup
// would corrupt the printed report and is an injection sink in the PDF window.
function esc(v: string | number): string {
  return String(v ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

export function buildSimpleReportHtml(title: string, subtitle: string, headers: string[], rows: (string | number)[][], logo: string): string {
  const th = headers.map((h) => `<th>${esc(h)}</th>`).join('')
  const tr = rows
    .map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`)
    .join('')
  return `<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8">
  <style>
    @page { size: A4; margin: 14mm; }
    * { box-sizing: border-box; }
    body { font-family: 'Segoe UI', Tahoma, sans-serif; color: #111; margin: 0; }
    .head { display: flex; align-items: center; justify-content: space-between; border-bottom: 3px solid #E50E05; padding-bottom: 12px; margin-bottom: 16px; }
    .head img { width: 74px; border-radius: 10px; }
    h1 { font-size: 20px; margin: 0 0 4px; }
    .sub { color: #666; font-size: 12px; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th { background: #111; color: #fff; text-align: right; padding: 9px 10px; }
    td { border-bottom: 1px solid #e5e5e5; padding: 8px 10px; text-align: right; }
    tr:nth-child(even) td { background: #fafafa; }
    .foot { margin-top: 18px; color: #999; font-size: 10px; text-align: center; }
  </style></head><body>
  <div class="head"><div><h1>${esc(title)}</h1><div class="sub">${esc(subtitle)}</div></div>${logo ? `<img src="${esc(logo)}">` : ''}</div>
  <table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>
  <div class="foot">SUSHI ROLLS — ${new Date().toLocaleString('ar-EG-u-nu-latn')}</div>
  </body></html>`
}

export async function exportPdf(name: string, html: string): Promise<boolean> {
  const res = await api.print.pdf({ html, fileName: `${name}.pdf` })
  return res.ok
}
