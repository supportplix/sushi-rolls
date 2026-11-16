import * as XLSX from 'xlsx'
import { api } from './ipc'

function download(dataBase64: string, fileName: string, filters: { name: string; extensions: string[] }[]): Promise<boolean> {
  return api.file.save({ dataBase64, fileName, filters }).then((r) => r.ok)
}

export function toCsv(headers: string[], rows: (string | number)[][]): string {
  const escape = (v: string | number): string => {
    const s = String(v ?? '')
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
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

export function buildSimpleReportHtml(title: string, subtitle: string, headers: string[], rows: (string | number)[][], logo: string): string {
  const th = headers.map((h) => `<th>${h}</th>`).join('')
  const tr = rows
    .map((r) => `<tr>${r.map((c) => `<td>${String(c ?? '')}</td>`).join('')}</tr>`)
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
  <div class="head"><div><h1>${title}</h1><div class="sub">${subtitle}</div></div>${logo ? `<img src="${logo}">` : ''}</div>
  <table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>
  <div class="foot">SUSHI ROLLS — ${new Date().toLocaleString('ar-EG-u-nu-latn')}</div>
  </body></html>`
}

export async function exportPdf(name: string, html: string): Promise<boolean> {
  const res = await api.print.pdf({ html, fileName: `${name}.pdf` })
  return res.ok
}
