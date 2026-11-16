import type { AppSettings, Order, OrderItem, Payment } from './types'
import { fmtDate, fmtTime, money } from './format'
import { fontDataUrl, logoDataUrl } from './logo'
import { labelOf, ORDER_STATUS, ORDER_TYPES, PAYMENT_METHODS } from './constants'
import { api } from './ipc'
import { t } from '@/i18n'

function esc(v: string | number | null | undefined): string {
  return String(v ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

interface ReceiptData {
  order: Order
  items: OrderItem[]
  payments: Payment[]
  settings: AppSettings
}

function itemsRows(items: OrderItem[]): string {
  return items
    .map((item) => {
      const extras = (item.order_item_extras ?? [])
        .map((ex) => `+ ${esc(ex.name_snapshot)} ×${ex.quantity}`)
        .join('<br>')
      const note = item.notes ? `<div class="muted">✎ ${esc(item.notes)}</div>` : ''
      const variant = item.variant_name ? ` <span class="muted">(${esc(item.variant_name)})</span>` : ''
      return `<tr>
        <td>
          <div class="item-name">${esc(item.name_snapshot)}${variant}</div>
          ${extras ? `<div class="muted">${extras}</div>` : ''}
          ${note}
        </td>
        <td class="c">${item.quantity}</td>
        <td class="l">${money(item.line_total)}</td>
      </tr>`
    })
    .join('')
}

function totalsRows(order: Order, payments: Payment[]): string {
  const paid = payments.reduce((sum, p) => sum + Number(p.amount), 0)
  const remaining = Number(order.total) - paid
  return `
    <div class="row"><span>${t('receipt.subtotal')}</span><span>${money(order.subtotal)}</span></div>
    ${Number(order.discount) > 0 ? `<div class="row"><span>${t('receipt.discount')}</span><span>- ${money(order.discount)}</span></div>` : ''}
    ${Number(order.tax) > 0 ? `<div class="row"><span>${t('receipt.tax')} ${order.tax_rate}%</span><span>${money(order.tax)}</span></div>` : ''}
    <div class="row total"><span>${t('receipt.total')}</span><span>${money(order.total)}</span></div>
    ${
      payments.length > 0
        ? `<div class="row"><span>${t('receipt.paid')} · ${esc(labelOf(PAYMENT_METHODS, order.payment_method, 'ar'))}</span><span>${money(paid)}</span></div>
           ${remaining > 0 ? `<div class="row warn"><span>${t('receipt.remaining')}</span><span>${money(remaining)}</span></div>` : ''}`
        : ''
    }
  `
}

function headHtml(settings: AppSettings, logo: string): string {
  const restaurant = settings.restaurant ?? {}
  const showLogo = settings.receipt?.show_logo !== false
  return `
    ${showLogo && logo ? `<img class="logo" src="${logo}" alt="">` : ''}
    <div class="brand">${esc(restaurant.name || 'SUSHI ROLLS')}</div>
    ${restaurant.phone ? `<div class="muted">${esc(restaurant.phone)}</div>` : ''}
    ${restaurant.address ? `<div class="muted">${esc(restaurant.address)}</div>` : ''}
  `
}

const fontCss = (font: string): string =>
  font
    ? `@font-face { font-family:'CairoLocal'; src:url(${font}) format('woff2'); font-weight:200 1000; }`
    : ''

export async function buildThermalReceiptHtml(data: ReceiptData): Promise<string> {
  const { order, items, payments, settings } = data
  const [logo, font] = await Promise.all([logoDataUrl(), fontDataUrl()])
  const width = settings.printing?.width === 58 ? '58mm' : '80mm'
  const footer = settings.receipt?.footer || t('receipt.thanks')
  return `<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8">
  <style>
    ${fontCss(font)}
    @page { size: ${width} auto; margin: 0; }
    * { box-sizing: border-box; }
    body { width: ${width}; margin: 0; padding: 4mm 4mm 6mm; font-family: ${font ? "'CairoLocal'," : ''} 'Segoe UI', Tahoma, sans-serif; color: #000; font-size: 12px; }
    .center { text-align: center; }
    .logo { width: 92px; margin: 0 auto 2mm; display: block; }
    .brand { font-size: 18px; font-weight: 900; letter-spacing: .5px; text-align: center; }
    .muted { color: #555; font-size: 10.5px; }
    .head { text-align: center; padding-bottom: 2.5mm; border-bottom: 2px dashed #000; margin-bottom: 2.5mm; }
    .meta { display: flex; justify-content: space-between; margin: 1mm 0; font-size: 11.5px; }
    .order-no { text-align: center; font-size: 22px; font-weight: 900; margin: 1mm 0; }
    .order-no small { display: block; font-size: 10px; font-weight: 600; color: #555; }
    table { width: 100%; border-collapse: collapse; margin: 2mm 0; }
    th { font-size: 10px; color: #444; border-bottom: 1.5px solid #000; padding: 1.2mm 0; text-align: right; }
    td { padding: 1.6mm 0; border-bottom: 1px dotted #bbb; vertical-align: top; font-size: 11.5px; }
    td.c { text-align: center; width: 22px; }
    td.l { text-align: left; width: 64px; white-space: nowrap; font-weight: 700; }
    .item-name { font-weight: 700; }
    .rows { margin-top: 2mm; border-top: 2px dashed #000; padding-top: 2mm; }
    .row { display: flex; justify-content: space-between; margin: 1.2mm 0; font-size: 12px; }
    .row.total { font-size: 16px; font-weight: 900; border-top: 1.5px solid #000; padding-top: 1.5mm; margin-top: 1.5mm; }
    .row.warn { color: #000; font-weight: 800; }
    .foot { margin-top: 3mm; padding-top: 2mm; border-top: 2px dashed #000; text-align: center; font-size: 10.5px; }
    .void { border: 2px solid #000; text-align: center; font-weight: 900; padding: 1.5mm; margin: 2mm 0; letter-spacing: 2px; }
  </style></head><body>
    <div class="head">${headHtml(settings, logo)}</div>
    <div class="order-no">#${order.order_number}<small>${t('receipt.number')}</small></div>
    ${order.status === 'cancelled' ? `<div class="void">${t('receipt.void')}</div>` : ''}
    <div class="meta"><span>${t('receipt.date')}</span><span>${fmtDate(order.created_at)} · ${fmtTime(order.created_at)}</span></div>
    <div class="meta"><span>${t('receipt.type')}</span><span>${esc(labelOf(ORDER_TYPES, order.order_type, 'ar'))}${order.restaurant_tables?.number ? ` · ${t('receipt.table')} ${esc(order.restaurant_tables.number)}` : ''}</span></div>
    ${settings.receipt?.show_cashier !== false ? `<div class="meta"><span>${t('receipt.cashier')}</span><span>${esc(order.cashier?.full_name ?? '—')}</span></div>` : ''}
    ${order.customer_name ? `<div class="meta"><span>${t('receipt.customer')}</span><span>${esc(order.customer_name)}${order.customer_phone ? ` · ${esc(order.customer_phone)}` : ''}</span></div>` : ''}
    <table>
      <thead><tr><th>${t('receipt.item')}</th><th class="c">${t('receipt.qty')}</th><th class="l">${t('receipt.total')}</th></tr></thead>
      <tbody>${itemsRows(items)}</tbody>
    </table>
    <div class="rows">${totalsRows(order, payments)}</div>
    ${order.notes ? `<div class="meta" style="margin-top:2mm"><span>${t('receipt.note')}</span><span>${esc(order.notes)}</span></div>` : ''}
    <div class="foot">${esc(footer)}</div>
  </body></html>`
}

export async function buildKitchenTicketHtml(data: ReceiptData): Promise<string> {
  const { order, items } = data
  const rows = items
    .map((item) => {
      const extras = (item.order_item_extras ?? [])
        .map((ex) => `<div class="ex">+ ${esc(ex.name_snapshot)} ×${ex.quantity}</div>`)
        .join('')
      const note = item.notes ? `<div class="note">✎ ${esc(item.notes)}</div>` : ''
      return `<div class="line">
        <div class="qty">${item.quantity}×</div>
        <div class="nm">${esc(item.name_snapshot)}${item.variant_name ? ` <span class="v">(${esc(item.variant_name)})</span>` : ''}${extras}${note}</div>
      </div>`
    })
    .join('')
  return `<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8">
  <style>
    @page { size: 80mm auto; margin: 0; }
    * { box-sizing: border-box; }
    body { width: 80mm; margin: 0; padding: 4mm; font-family: 'Segoe UI', Tahoma, sans-serif; color: #000; }
    .tag { font-size: 11px; font-weight: 700; border-bottom: 2px solid #000; padding-bottom: 1.5mm; display:flex; justify-content:space-between; }
    .no { font-size: 30px; font-weight: 900; margin: 2mm 0 1mm; }
    .sub { font-size: 11px; color: #333; margin-bottom: 2mm; }
    .line { display: flex; gap: 2mm; border-bottom: 1px dashed #999; padding: 2mm 0; }
    .qty { font-size: 20px; font-weight: 900; min-width: 12mm; }
    .nm { font-size: 15px; font-weight: 800; }
    .v { font-weight: 600; font-size: 12px; color: #444; }
    .ex { font-size: 12px; font-weight: 700; color: #000; }
    .note { font-size: 12px; font-weight: 700; background: #eee; padding: 1mm 2mm; margin-top: 1mm; }
    .ordernote { margin-top: 2mm; font-size: 12px; font-weight: 800; border: 2px solid #000; padding: 2mm; }
  </style></head><body>
    <div class="tag"><span>${t('receipt.kitchen')}</span><span>${fmtTime(order.created_at)}</span></div>
    <div class="no">#${order.order_number}</div>
    <div class="sub">${esc(labelOf(ORDER_TYPES, order.order_type, 'ar'))}${order.restaurant_tables?.number ? ` · ${t('kds.table')} ${esc(order.restaurant_tables.number)}` : ''} · ${fmtDate(order.created_at)}</div>
    ${rows}
    ${order.notes ? `<div class="ordernote">${t('receipt.note')}: ${esc(order.notes)}</div>` : ''}
  </body></html>`
}

export async function buildA4InvoiceHtml(data: ReceiptData): Promise<string> {
  const { order, items, payments, settings } = data
  const [logo, font] = await Promise.all([logoDataUrl(), fontDataUrl()])
  const restaurant = settings.restaurant ?? {}
  return `<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8">
  <style>
    ${fontCss(font)}
    @page { size: A4; margin: 0; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 14mm; font-family: ${font ? "'CairoLocal'," : ''} 'Segoe UI', Tahoma, sans-serif; color: #111; }
    .top { display: flex; align-items: flex-start; justify-content: space-between; border-bottom: 3px solid #E50E05; padding-bottom: 6mm; }
    .logo { width: 90px; border-radius: 8px; }
    .brand { font-size: 24px; font-weight: 900; }
    .muted { color: #666; font-size: 11px; }
    .title { text-align: left; }
    .title h1 { margin: 0; font-size: 26px; color: #E50E05; }
    .title .no { font-size: 18px; font-weight: 800; }
    .meta { display: grid; grid-template-columns: repeat(3, 1fr); gap: 3mm; margin: 6mm 0; }
    .box { border: 1px solid #ddd; border-radius: 8px; padding: 3mm; }
    .box .k { font-size: 10px; color: #888; margin-bottom: 1mm; }
    .box .v { font-size: 12px; font-weight: 700; }
    table { width: 100%; border-collapse: collapse; }
    th { background: #111; color: #fff; font-size: 11px; padding: 3mm 2.5mm; text-align: right; }
    td { border-bottom: 1px solid #eee; padding: 2.5mm; font-size: 12px; text-align: right; }
    .c { text-align: center; }
    .l { text-align: left; }
    .itename { font-weight: 700; }
    .sm { font-size: 10px; color: #777; }
    .totals { width: 72mm; margin-top: 5mm; margin-inline-start: auto; }
    .trow { display: flex; justify-content: space-between; padding: 1.6mm 0; font-size: 12px; }
    .trow.total { border-top: 2px solid #111; font-size: 16px; font-weight: 900; margin-top: 1.5mm; padding-top: 2.5mm; }
    .foot { margin-top: 14mm; border-top: 1px solid #ddd; padding-top: 4mm; text-align: center; color: #888; font-size: 11px; }
    .void { border: 3px solid #E50E05; color: #E50E05; font-size: 20px; font-weight: 900; text-align: center; padding: 2mm; margin-top: 4mm; }
  </style></head><body>
    <div class="top">
      <div style="display:flex; gap:5mm; align-items:center">
        ${logo ? `<img class="logo" src="${logo}">` : ''}
        <div><div class="brand">${esc(restaurant.name || 'SUSHI ROLLS')}</div>
        ${restaurant.phone ? `<div class="muted">${t('receipt.phone')}: ${esc(restaurant.phone)}</div>` : ''}
        ${restaurant.address ? `<div class="muted">${esc(restaurant.address)}</div>` : ''}</div>
      </div>
      <div class="title"><h1>${t('receipt.invoice')}</h1><div class="no">#${order.order_number}</div>
      <div class="muted">${fmtDate(order.created_at)} · ${fmtTime(order.created_at)}</div></div>
    </div>
    ${order.status === 'cancelled' ? `<div class="void">${t('receipt.void')}</div>` : ''}
    <div class="meta">
      <div class="box"><div class="k">${t('receipt.type')}</div><div class="v">${esc(labelOf(ORDER_TYPES, order.order_type, 'ar'))}</div></div>
      <div class="box"><div class="k">${t('receipt.table')}</div><div class="v">${esc(order.restaurant_tables?.number ?? '—')}</div></div>
      <div class="box"><div class="k">${t('receipt.cashier')}</div><div class="v">${esc(order.cashier?.full_name ?? '—')}</div></div>
      <div class="box"><div class="k">${t('receipt.customer')}</div><div class="v">${esc(order.customer_name ?? '—')}</div></div>
      <div class="box"><div class="k">${t('receipt.phone')}</div><div class="v">${esc(order.customer_phone ?? '—')}</div></div>
      <div class="box"><div class="k">${t('orders.paymentStatus')}</div><div class="v">${esc(labelOf(ORDER_STATUS, order.status, 'ar'))} · ${esc(labelOf(PAYMENT_METHODS, order.payment_method, 'ar'))}</div></div>
    </div>
    <table>
      <thead><tr><th>${t('receipt.item')}</th><th class="c">${t('receipt.qty')}</th><th class="l">${t('receipt.price')}</th><th class="l">${t('receipt.total')}</th></tr></thead>
      <tbody>
        ${items
          .map((item) => {
            const extras = (item.order_item_extras ?? [])
              .map((ex) => `+ ${esc(ex.name_snapshot)} ×${ex.quantity}`)
              .join(' · ')
            return `<tr><td><div class="itename">${esc(item.name_snapshot)}${item.variant_name ? ` (${esc(item.variant_name)})` : ''}</div>
              ${extras ? `<div class="sm">${extras}</div>` : ''}${item.notes ? `<div class="sm">✎ ${esc(item.notes)}</div>` : ''}</td>
              <td class="c">${item.quantity}</td><td class="l">${money(item.unit_price)}</td><td class="l">${money(item.line_total)}</td></tr>`
          })
          .join('')}
      </tbody>
    </table>
    <div class="totals">
      <div class="trow"><span>${t('receipt.subtotal')}</span><span>${money(order.subtotal)}</span></div>
      ${Number(order.discount) > 0 ? `<div class="trow"><span>${t('receipt.discount')}</span><span>- ${money(order.discount)}</span></div>` : ''}
      ${Number(order.tax) > 0 ? `<div class="trow"><span>${t('receipt.tax')} ${order.tax_rate}%</span><span>${money(order.tax)}</span></div>` : ''}
      <div class="trow total"><span>${t('receipt.total')}</span><span>${money(order.total)}</span></div>
    </div>
    ${order.notes ? `<div class="box" style="margin-top:6mm"><div class="k">${t('receipt.note')}</div><div class="v">${esc(order.notes)}</div></div>` : ''}
    <div class="foot">${esc(settings.receipt?.footer || t('receipt.thanks'))}</div>
  </body></html>`
}

async function printHtml(html: string, settings: AppSettings): Promise<{ ok: boolean; error?: string }> {
  const printer = settings.printing?.printer || null
  return api.print.receipt({ html, deviceName: printer, silent: !!printer })
}

export async function printThermalReceipt(data: ReceiptData): Promise<{ ok: boolean; error?: string }> {
  return printHtml(await buildThermalReceiptHtml(data), data.settings)
}

export async function printKitchenTicket(data: ReceiptData): Promise<{ ok: boolean; error?: string }> {
  return printHtml(await buildKitchenTicketHtml(data), data.settings)
}

export async function printA4Invoice(data: ReceiptData): Promise<{ ok: boolean; error?: string }> {
  return api.print.pdf({ html: await buildA4InvoiceHtml(data), fileName: `invoice-${data.order.order_number}.pdf` }).then((r) => ({
    ok: r.ok,
    error: r.error
  }))
}
