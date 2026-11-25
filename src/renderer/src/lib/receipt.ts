import type { AppSettings, Order, OrderItem, Payment } from './types'
import { fmtDate, fmtTime, money } from './format'
import { fontDataUrl, logoDataUrl } from './logo'
import { labelOf, ORDER_STATUS, ORDER_TYPES, PAYMENT_METHODS } from './constants'
import { api } from './ipc'
import { THERMAL_PROFILES } from '@shared/ipc'
import { t } from '@/i18n'

function esc(v: string | number | null | undefined): string {
  return String(v ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function moneyHtml(value: number | string, stacked = false): string {
  const text = money(value)
  const separator = text.lastIndexOf(' ')
  const amount = separator === -1 ? text : text.slice(0, separator)
  const currency = separator === -1 ? '' : text.slice(separator + 1)
  return `<span class="money${stacked ? ' stacked' : ''}" dir="ltr"><span class="amount">${esc(amount)}</span> <span class="currency">${esc(currency)}</span></span>`
}

function metaRow(label: string, value: string): string {
  return `<div class="meta"><span>${esc(label)}</span><span dir="auto">${value}</span></div>`
}

export interface ReceiptData {
  order: Order
  items: OrderItem[]
  payments: Payment[]
  settings: AppSettings
}

function itemsRows(items: OrderItem[]): string {
  return items
    .map((item) => {
      const extras = (item.order_item_extras ?? [])
        .map((ex) => `<div class="item-extra">+ ${esc(ex.name_snapshot)} ×${ex.quantity} · ${moneyHtml(ex.price)}</div>`)
        .join('')
      const note = item.notes ? `<div class="item-note">${t('receipt.note')}: ${esc(item.notes)}</div>` : ''
      const variant = item.variant_name ? `<span class="item-variant">(${esc(item.variant_name)})</span>` : ''
      return `<tr>
        <td>
          <div class="item-name">${esc(item.name_snapshot)}${variant}</div>
          ${extras}
          ${note}
        </td>
        <td class="c">${item.quantity}</td>
        <td class="l">${moneyHtml(item.unit_price, true)}</td>
        <td class="l">${moneyHtml(item.line_total, true)}</td>
      </tr>`
    })
    .join('')
}

function totalsRows(order: Order, payments: Payment[], settings: AppSettings): string {
  const paid = payments.reduce((sum, p) => sum + Number(p.amount), 0)
  const remaining = Number(order.total) - paid
  const showTax = settings.receipt?.show_tax !== false
  const deliveryFee = Number((order as unknown as { delivery_fee?: number }).delivery_fee ?? 0)
  return `
    <div class="summary-row"><span>${t('receipt.subtotal')}</span><span>${moneyHtml(order.subtotal)}</span></div>
    ${Number(order.discount) > 0 ? `<div class="summary-row"><span>${t('receipt.discount')}</span><span>${moneyHtml(-Number(order.discount))}</span></div>` : ''}
    ${showTax && Number(order.tax) > 0 ? `<div class="summary-row"><span>${t('receipt.tax')} ${order.tax_rate}%</span><span>${moneyHtml(order.tax)}</span></div>` : ''}
    ${deliveryFee > 0 ? `<div class="summary-row"><span>${t('receipt.deliveryFee')}</span><span>${moneyHtml(deliveryFee)}</span></div>` : ''}
    <div class="grand-total"><span>${t('receipt.total')}</span><span>${moneyHtml(order.total)}</span></div>
    ${
      payments.length > 0
        ? `<div class="summary-row payment"><span>${t('receipt.paid')}</span><span>${moneyHtml(paid)}</span></div>
           ${remaining > 0 ? `<div class="summary-row payment remaining"><span>${t('receipt.remaining')}</span><span>${moneyHtml(remaining)}</span></div>` : ''}`
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
    ${restaurant.phone ? `<div class="contact" dir="ltr">${esc(restaurant.phone)}</div>` : ''}
    ${restaurant.address ? `<div class="contact">${esc(restaurant.address)}</div>` : ''}
  `
}

const fontCss = (font: string): string =>
  font
    ? `@font-face { font-family:'CairoLocal'; src:url(${font}) format('woff2'); font-weight:200 1000; font-display:block; }`
    : ''

export async function buildThermalReceiptHtml(data: ReceiptData): Promise<string> {
  const { order, items, payments, settings } = data
  const [logo, font] = await Promise.all([logoDataUrl(), fontDataUrl()])
  const widthMm = settings.printing?.width === 58 ? 58 : 80
  const profile = THERMAL_PROFILES[widthMm]
  const paperWidth = `${profile.paperWidthMm}mm`
  const printableWidth = `${profile.printableWidthMm}mm`
  const safeMargin = `${profile.safeMarginMm}mm`
  const contentPadding = `${profile.contentPaddingMm}mm`
  const bottomPadding = `${profile.bottomFeedClearanceMm}mm`
  const narrow = widthMm === 58
  const topPadding = narrow ? '3mm' : '4mm'
  const logoWidth = narrow ? '32mm' : '42mm'
  const qtyWidth = narrow ? '5mm' : '7mm'
  const unitWidth = narrow ? '11mm' : '14mm'
  const totalWidth = narrow ? '12mm' : '16mm'
  const metaLabelWidth = narrow ? '15mm' : '20mm'
  const bodyFontSize = narrow ? '10px' : '11.5px'
  const itemFontSize = narrow ? '9.5px' : '11px'
  const detailFontSize = narrow ? '8.5px' : '9.5px'
  const date = fmtDate(order.created_at)
  const time = fmtTime(order.created_at)
  const dateValue = narrow ? `${date}<br>${time}` : `${date} · ${time}`
  const footer = settings.receipt?.footer || t('receipt.thanks')
  const restaurantName = settings.restaurant?.name || 'SUSHI ROLLS'
  return `<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8">
  <style>
    ${fontCss(font)}
    @page { size: ${paperWidth} auto; margin: 0; }
    :root {
      --receipt-paper-width: ${paperWidth};
      --receipt-printable-width: ${printableWidth};
      --receipt-content-width: ${printableWidth};
      --receipt-safe-margin: ${safeMargin};
      --receipt-content-padding: ${contentPadding};
      --receipt-print-margin: 0;
    }
    *, *::before, *::after {
      box-sizing: border-box;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    html, body {
      background: #fff;
    }
    html {
      width: var(--receipt-paper-width);
      margin: 0;
      padding: 0;
    }
    body {
      width: var(--receipt-content-width);
      max-width: var(--receipt-content-width);
      min-height: 0;
      height: auto;
      margin: 0 auto;
      padding: ${topPadding} var(--receipt-content-padding) ${bottomPadding};
      font-family: ${font ? "'CairoLocal'," : ''} 'Cairo', 'Segoe UI', Tahoma, sans-serif;
      color: #174EA6;
      font-size: ${bodyFontSize};
      line-height: 1.4;
      font-feature-settings: 'kern' 1;
      text-rendering: optimizeLegibility;
      -webkit-font-smoothing: antialiased;
      overflow: visible;
    }
    .receipt {
      width: 100%;
      max-width: 100%;
      margin: 0;
      overflow: visible;
    }
    .logo {
      width: ${logoWidth};
      max-width: 100%;
      height: auto;
      margin: 0 auto 2mm;
      display: block;
      object-fit: contain;
    }
    .brand {
      font-size: ${narrow ? '17px' : '20px'};
      font-weight: 900;
      letter-spacing: .5px;
      text-align: center;
      line-height: 1.25;
    }
    .contact {
      margin-top: 1mm;
      font-size: ${detailFontSize};
      line-height: 1.45;
      text-align: center;
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    .head {
      text-align: center;
      padding-bottom: 2.5mm;
      border-bottom: 1.5px dashed #174EA6;
      margin-bottom: 2.5mm;
      break-inside: avoid;
      page-break-inside: avoid;
    }
    .order-no {
      text-align: center;
      font-size: ${narrow ? '24px' : '30px'};
      font-weight: 900;
      line-height: 1.1;
      margin: 0 0 2mm;
      break-inside: avoid;
      page-break-inside: avoid;
    }
    .order-no small {
      display: block;
      margin-top: 1mm;
      font-size: ${detailFontSize};
      font-weight: 700;
      letter-spacing: .2px;
    }
    .meta {
      display: grid;
      grid-template-columns: ${metaLabelWidth} minmax(0, 1fr);
      gap: 1.5mm;
      padding: 1mm .5mm;
      border-bottom: .5px dotted #8FB2E3;
      break-inside: avoid;
      page-break-inside: avoid;
      font-size: ${detailFontSize};
      line-height: 1.35;
    }
    .meta > span {
      min-width: 0;
    }
    .meta > span:first-child {
      font-weight: 700;
    }
    .meta > span:last-child {
      text-align: left;
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    table {
      width: 100%;
      table-layout: fixed;
      border-collapse: collapse;
      margin-top: 2.5mm;
    }
    col.qty { width: ${qtyWidth}; }
    col.unit { width: ${unitWidth}; }
    col.total { width: ${totalWidth}; }
    th {
      padding: 1.4mm .5mm;
      border-top: 1.5px dashed #174EA6;
      border-bottom: 1.5px solid #174EA6;
      font-size: ${detailFontSize};
      font-weight: 800;
      text-align: right;
    }
    td {
      padding: 1.6mm .5mm;
      border-bottom: .5px dotted #8FB2E3;
      vertical-align: top;
      font-size: ${itemFontSize};
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    th:first-child, td:first-child { padding-right: .4mm; }
    th:last-child, td:last-child { padding-left: .4mm; }
    th.c, td.c { text-align: center; }
    th.l, td.l { text-align: left; }
    td.l { font-weight: 800; }
    .item-name {
      font-weight: 800;
      unicode-bidi: plaintext;
      overflow-wrap: anywhere;
      word-break: break-word;
      line-height: 1.35;
    }
    .item-variant, .item-extra, .item-note {
      margin-top: .6mm;
      font-size: ${detailFontSize};
      font-weight: 500;
      line-height: 1.4;
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    .item-extra, .item-note {
      unicode-bidi: plaintext;
    }
    .money {
      display: inline-block;
      direction: ltr;
      unicode-bidi: isolate;
      white-space: normal;
      overflow-wrap: anywhere;
      font-variant-numeric: tabular-nums;
    }
    .money .amount {
      overflow-wrap: anywhere;
    }
    .money .currency {
      white-space: nowrap;
    }
    .money.stacked .currency {
      display: block;
      font-size: .78em;
      font-weight: 500;
      line-height: 1.15;
    }
    .totals {
      margin-top: 2.5mm;
      padding-top: 1.5mm;
      border-top: 1.5px dashed #174EA6;
      break-inside: avoid;
      page-break-inside: avoid;
    }
    .summary-row {
      display: flex;
      justify-content: space-between;
      gap: 1.5mm;
      padding: .8mm .5mm;
      font-size: ${detailFontSize};
      line-height: 1.35;
    }
    .summary-row > span:first-child {
      min-width: 0;
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    .summary-row > span:last-child {
      flex-shrink: 0;
    }
    .grand-total {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 2mm;
      margin: 2mm 0 1.5mm;
      padding: ${narrow ? '2mm 2.5mm' : '2.5mm 3.5mm'};
      background: #174EA6;
      border: 1.5px solid #174EA6;
      color: #fff;
      font-weight: 900;
      border-radius: 1mm;
      break-inside: avoid;
      page-break-inside: avoid;
    }
    .grand-total span {
      color: #fff;
    }
    .grand-total .money {
      font-size: ${narrow ? '17px' : '21px'};
      line-height: 1.2;
      color: #fff;
    }
    .grand-total .currency {
      font-size: .62em;
      color: #fff;
    }
    .payment {
      font-size: ${detailFontSize};
    }
    .remaining {
      font-weight: 800;
    }
    .order-note {
      display: grid;
      grid-template-columns: ${metaLabelWidth} minmax(0, 1fr);
      gap: 1.5mm;
      margin-top: 2.5mm;
      padding: 1.5mm 0;
      border-top: .5px dotted #8FB2E3;
      border-bottom: .5px dotted #8FB2E3;
      break-inside: avoid;
      page-break-inside: avoid;
      font-size: ${detailFontSize};
      line-height: 1.35;
    }
    .order-note > span {
      min-width: 0;
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    .order-note > span:first-child {
      font-weight: 800;
    }
    .foot {
      margin-top: 3.5mm;
      padding-top: 2.5mm;
      border-top: 1.5px dashed #174EA6;
      text-align: center;
      overflow-wrap: anywhere;
      word-break: break-word;
      break-inside: avoid;
      page-break-inside: avoid;
    }
    .thanks {
      font-size: ${narrow ? '9.5px' : '11px'};
      font-weight: 700;
      line-height: 1.4;
    }
    .foot-brand {
      margin-top: 1mm;
      font-size: ${narrow ? '12px' : '14px'};
      font-weight: 900;
      letter-spacing: .8px;
    }
    .void {
      border: 1.5px solid #174EA6;
      text-align: center;
      font-weight: 900;
      padding: 1.5mm;
      margin: 2mm 0;
      letter-spacing: 2px;
      break-inside: avoid;
      page-break-inside: avoid;
    }
    tr, .meta, .head, .order-no, .order-note, .foot, .totals, .grand-total {
      break-inside: avoid;
      page-break-inside: avoid;
    }
    @media print {
      *, *::before, *::after {
        box-sizing: border-box;
      }
      html, body {
        width: var(--receipt-printable-width);
        max-width: var(--receipt-printable-width);
        margin: 0 auto;
        padding-left: var(--receipt-content-padding);
        padding-right: var(--receipt-content-padding);
        height: auto !important;
        min-height: 0 !important;
        overflow: visible !important;
        page-break-inside: auto;
        break-inside: auto;
      }
      body {
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }
      .receipt-item, tr, .meta, .head, .order-no, .order-note, .totals, .grand-total, .foot {
        break-inside: avoid;
        page-break-inside: avoid;
      }
      .no-print {
        display: none !important;
      }
    }
  </style></head><body>
    <div class="head">${headHtml(settings, logo)}</div>
    <div class="order-no"><bdi dir="ltr">#${order.order_number}</bdi><small>${t('receipt.number')}</small></div>
    ${order.status === 'cancelled' ? `<div class="void">${t('receipt.void')}</div>` : ''}
    ${metaRow(t('receipt.date'), dateValue)}
    ${metaRow(t('receipt.type'), `${esc(labelOf(ORDER_TYPES, order.order_type, 'ar'))}${order.restaurant_tables?.number ? ` · ${t('receipt.table')} ${esc(order.restaurant_tables.number)}` : ''}`)}
    ${settings.receipt?.show_cashier !== false ? metaRow(t('receipt.cashier'), esc(order.cashier?.full_name ?? '—')) : ''}
    ${order.customer_name ? metaRow(t('receipt.customer'), `${esc(order.customer_name)}${order.customer_phone ? ` · <bdi dir="ltr">${esc(order.customer_phone)}</bdi>` : ''}`) : ''}
    ${order.customer_address ? metaRow(t('receipt.address'), esc(order.customer_address)) : ''}
    ${order.payment_method ? metaRow(t('common.paymentMethod'), esc(labelOf(PAYMENT_METHODS, order.payment_method, 'ar'))) : ''}
    <table>
      <colgroup><col class="item"><col class="qty"><col class="unit"><col class="total"></colgroup>
      <thead><tr><th>${t('receipt.item')}</th><th class="c">${t('receipt.qty')}</th><th class="l">${t('receipt.price')}</th><th class="l">${t('receipt.total')}</th></tr></thead>
      <tbody>${itemsRows(items)}</tbody>
    </table>
    <div class="totals">${totalsRows(order, payments, settings)}</div>
    ${order.notes ? `<div class="order-note"><span>${t('receipt.note')}</span><span dir="auto">${esc(order.notes)}</span></div>` : ''}
    <div class="foot"><div class="thanks">${esc(footer)}</div><div class="foot-brand">${esc(restaurantName)}</div></div>
  </body></html>`
}

export async function buildKitchenTicketHtml(data: ReceiptData): Promise<string> {
  const { order, items, settings } = data
  const width = settings.printing?.width === 58 ? '58mm' : '80mm'
  const narrow = width === '58mm'
  const printableWidth = narrow ? '48mm' : '72mm'
  const sidePadding = narrow ? '1.5mm 5.5mm' : '2.5mm 4.5mm'
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
    @page { size: ${width} auto; margin: 0; }
    * { box-sizing: border-box; }
    body { width: ${printableWidth}; margin: 0 auto; padding: ${sidePadding} 4mm; font-family: 'Segoe UI', Tahoma, sans-serif; color: #000; }
    .tag { font-size: 11px; font-weight: 700; border-bottom: 2px solid #000; padding-bottom: 1.5mm; display:flex; justify-content:space-between; gap:2mm; }
    .no { font-size: 30px; font-weight: 900; margin: 2mm 0 1mm; }
    .sub { font-size: 11px; color: #333; margin-bottom: 2mm; overflow-wrap:anywhere; }
    .line { display: flex; gap: 2mm; border-bottom: 1px dashed #999; padding: 2mm 0; }
    .qty { font-size: 20px; font-weight: 900; min-width: 12mm; flex-shrink:0; }
    .nm { font-size: 15px; font-weight: 800; min-width:0; overflow-wrap:anywhere; }
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
  const widthMm = settings.printing?.width === 58 ? 58 : 80
  return api.print.receipt({ html, deviceName: printer, silent: !!printer, widthMm })
}

export async function printThermalReceipt(data: ReceiptData): Promise<{ ok: boolean; error?: string }> {
  return printHtml(await buildThermalReceiptHtml(data), data.settings)
}

export async function printKitchenTicket(data: ReceiptData): Promise<{ ok: boolean; error?: string }> {
  return printHtml(await buildKitchenTicketHtml(data), data.settings)
}

export function getSampleReceiptData(settings?: AppSettings): ReceiptData {
  const now = new Date().toISOString()
  const items: OrderItem[] = [
    {
      id: 'sample-item-1',
      order_id: 'sample-order',
      product_id: null,
      name_snapshot: 'سوشي رول سلمون',
      variant_name: '8 قطع',
      unit_price: 205,
      cost_snapshot: 0,
      quantity: 2,
      notes: '',
      line_total: 410,
      order_item_extras: [
        { id: 'sample-extra-1', order_item_id: 'sample-item-1', extra_id: null, name_snapshot: 'أفوكادو', price: 25, quantity: 1 }
      ]
    },
    {
      id: 'sample-item-2',
      order_id: 'sample-order',
      product_id: null,
      name_snapshot: 'سوشي رول كاليفورنيا',
      variant_name: null,
      unit_price: 150,
      cost_snapshot: 0,
      quantity: 1,
      notes: 'بدون مايونيز',
      line_total: 150,
      order_item_extras: []
    },
    {
      id: 'sample-item-3',
      order_id: 'sample-order',
      product_id: null,
      name_snapshot: 'ماجي رول',
      variant_name: '6 قطع',
      unit_price: 140,
      cost_snapshot: 0,
      quantity: 1,
      notes: '',
      line_total: 140,
      order_item_extras: [
        { id: 'sample-extra-2', order_item_id: 'sample-item-3', extra_id: null, name_snapshot: 'صوص حلو', price: 20, quantity: 1 }
      ]
    }
  ]
  const order: Order = {
    id: 'sample-order',
    order_number: 100000,
    status: 'completed',
    order_type: 'dine_in',
    table_id: 'sample-table',
    customer_id: null,
    customer_name: 'عميل تجريبي',
    customer_phone: null,
    customer_address: null,
    cashier_id: null,
    waiter_id: null,
    subtotal: 700,
    discount_type: 'fixed',
    discount_value: 20,
    discount: 20,
    tax_rate: 14,
    tax: 95.2,
    total: 775.2,
    payment_status: 'paid',
    payment_method: 'cash',
    notes: 'فاتورة اختبار — غير صالحة للدفع',
    cancel_reason: null,
    cancelled_by: null,
    cancelled_at: null,
    inventory_deducted_at: null,
    shift_id: null,
    created_at: now,
    updated_at: now,
    completed_at: now,
    order_items: items,
    restaurant_tables: { number: '12', zone: 'صالة' },
    cashier: { full_name: 'كاشير تجريبي' }
  }
  const payments: Payment[] = [
    { id: 'sample-payment', order_id: order.id, method: 'cash', amount: order.total, reference: null, shift_id: null, created_by: null, created_at: now }
  ]
  return {
    order,
    items,
    payments,
    settings: settings ?? {
      restaurant: { name: 'SUSHI ROLLS', phone: '', address: '' },
      printing: { width: 80, printer: undefined },
      receipt: { show_logo: true, show_tax: true, show_cashier: true }
    }
  }
}

export function printSampleReceipt(settings: AppSettings): Promise<{ ok: boolean; error?: string }> {
  return printThermalReceipt(getSampleReceiptData(settings))
}

export async function printA4Invoice(data: ReceiptData): Promise<{ ok: boolean; error?: string }> {
  return api.print.pdf({ html: await buildA4InvoiceHtml(data), fileName: `invoice-${data.order.order_number}.pdf` }).then((r) => ({
    ok: r.ok,
    error: r.error
  }))
}
