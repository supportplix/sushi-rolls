import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings, Order, OrderItem, Payment } from '../src/renderer/src/lib/types'

const printReceipt = vi.hoisted(() => vi.fn())

vi.mock('../src/renderer/src/lib/ipc', () => ({
  api: {
    print: {
      receipt: printReceipt,
      pdf: vi.fn()
    }
  }
}))

vi.mock('../src/renderer/src/lib/logo', () => ({
  logoDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,UI_LOGO'),
  printLogoDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,PRINT_LOGO'),
  fontDataUrl: vi.fn().mockResolvedValue('')
}))

import { buildKitchenTicketHtml, buildThermalReceiptHtml, printKitchenTicket, printSampleReceipt, printThermalReceipt } from '../src/renderer/src/lib/receipt'

function receiptData(width: 58 | 80 = 80): {
  order: Order
  items: OrderItem[]
  payments: Payment[]
  settings: AppSettings
} {
  const now = '2026-11-23T12:00:00.000Z'
  const items: OrderItem[] = [
    {
      id: 'item-1',
      order_id: 'order-1',
      product_id: null,
      name_snapshot: 'سوشي رول سلمون',
      variant_name: '8 قطع',
      unit_price: 100,
      cost_snapshot: 0,
      quantity: 2,
      notes: 'بدون مايونيز',
      line_total: 225,
      order_item_extras: [
        { id: 'extra-1', order_item_id: 'item-1', extra_id: null, name_snapshot: 'أفوكادو', price: 25, quantity: 1 }
      ]
    }
  ]
  const order: Order = {
    id: 'order-1',
    order_number: 100000,
    status: 'completed',
    order_type: 'delivery',
    table_id: null,
    customer_id: null,
    customer_name: 'عميل تجريبي',
    customer_phone: '01000000000',
    customer_address: 'عنوان تجريبي',
    cashier_id: null,
    waiter_id: null,
    subtotal: 225,
    discount_type: 'fixed',
    discount_value: 25,
    discount: 25,
    tax_rate: 14,
    tax: 28,
    total: 228,
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
    restaurant_tables: undefined,
    cashier: { full_name: 'كاشير تجريبي' }
  }
  const payments: Payment[] = [
    {
      id: 'payment-1',
      order_id: order.id,
      method: 'cash',
      amount: 228,
      reference: null,
      shift_id: null,
      created_by: null,
      created_at: now
    }
  ]
  return {
    order,
    items,
    payments,
    settings: {
      restaurant: { name: 'SUSHI ROLLS', phone: '01000000000', address: 'القاهرة' },
      printing: { width, printer: 'Printer POS-80' },
      receipt: { show_logo: true, show_cashier: true, footer: 'شكراً لزيارتكم — SUSHI ROLLS' }
    }
  }
}

beforeEach(() => {
  printReceipt.mockReset().mockResolvedValue({ ok: true })
})

describe('receipt page geometry', () => {
  it('sizes the print page from measured content instead of a fixed 297mm roll', async () => {
    const ipc = await import('../src/shared/ipc') as unknown as {
      receiptPageSize?: (widthMm: 58 | 80 | undefined, contentHeightPx?: number | null) => { width: number; height: number }
    }

    expect(ipc.receiptPageSize).toBeTypeOf('function')
    expect(ipc.receiptPageSize?.(80, 800)).toEqual({ width: 80000, height: 218000 })
    expect(ipc.receiptPageSize?.(58, 800)).toEqual({ width: 58000, height: 218000 })
    expect(ipc.receiptPageSize?.(undefined, 800)).toEqual({ width: 80000, height: 218000 })
    expect(ipc.receiptPageSize?.(80, 0)).toEqual({ width: 80000, height: 40000 })
    expect(ipc.receiptPageSize?.(58, NaN)).toEqual({ width: 58000, height: 40000 })
    expect(ipc.receiptPageSize?.(undefined)).toEqual({ width: 80000, height: 40000 })
  })
})

describe('thermal receipt design', () => {
  it('uses the official logo without changing its aspect ratio', async () => {
    const html = await buildThermalReceiptHtml(receiptData())

    expect(html).toContain('data:image/png;base64,UI_LOGO')
    expect(html).not.toContain('data:image/png;base64,PRINT_LOGO')
    expect(html).toMatch(/\.logo\s*\{[^}]*max-width:\s*100%/)
    expect(html).toMatch(/\.logo\s*\{[^}]*height:\s*auto/)
  })

  it.each([
    { width: 80 as const, logoWidth: '42mm' },
    { width: 58 as const, logoWidth: '32mm' }
  ])('renders a prominent $logoWidth logo on $width mm paper', async ({ width, logoWidth }) => {
    const html = await buildThermalReceiptHtml(receiptData(width))

    expect(html).toMatch(new RegExp(`\\.logo\\s*\\{[^}]*width:\\s*${logoWidth}`))
  })

  it.each([
    { width: 80 as const, printableWidth: '72mm', padding: '4mm var(--receipt-content-padding) 10mm' },
    { width: 58 as const, printableWidth: '48mm', padding: '3mm var(--receipt-content-padding) 8mm' }
  ])('keeps $width mm paper content inside safe margins and physical printable head ($printableWidth)', async ({ width, printableWidth, padding }) => {
    const html = await buildThermalReceiptHtml(receiptData(width))

    expect(html).toContain('width: var(--receipt-content-width);')
    expect(html).toContain(`--receipt-paper-width: ${width}mm;`)
    expect(html).toContain(`--receipt-printable-width: ${printableWidth};`)
    expect(html).toContain(`padding: ${padding};`)
    expect(html).toContain(`@page { size: ${width}mm auto; margin: 0; }`)
    expect(html).not.toMatch(/(?:^|[;{]\s*)height:\s*\d/)
  })

  it('uses white paper, royal-blue typography, and blue dashed separators', async () => {
    const html = await buildThermalReceiptHtml(receiptData())

    expect(html).toMatch(/html,\s*body\s*\{[^}]*background:\s*#fff/)
    expect(html).toMatch(/body\s*\{[^}]*color:\s*#174EA6/)
    expect(html).toMatch(/\.head\s*\{[^}]*border-bottom:[^;]*dashed\s+#174EA6/)
    expect(html).toMatch(/\.totals\s*\{[^}]*border-top:[^;]*dashed\s+#174EA6/)
    expect(html).not.toContain('color: #000')
  })

  it('highlights the final payable amount in a solid royal-blue container', async () => {
    const html = await buildThermalReceiptHtml(receiptData())

    expect(html).toMatch(/\.grand-total\s*\{[^}]*background:\s*#174EA6/)
    expect(html).toMatch(/\.grand-total\s*\{[^}]*color:\s*#fff/)
    expect(html).toContain('<div class="grand-total">')
    expect(html).toContain('<span class="money" dir="ltr"><span class="amount">228</span> <span class="currency">ج.م.</span></span>')
  })

  it('renders separate product, quantity, unit-price, and line-total columns', async () => {
    const html = await buildThermalReceiptHtml(receiptData())

    expect(html).toContain('<col class="item">')
    expect(html).toContain('<col class="qty">')
    expect(html).toContain('<col class="unit">')
    expect(html).toContain('<col class="total">')
    expect(html).toContain('<th class="c">عدد</th>')
    expect(html).toContain('<th class="l">سعر</th>')
    expect(html).toContain('<th class="l">الإجمالي</th>')
    expect(html).toContain('<td class="l"><span class="money stacked" dir="ltr"><span class="amount">100</span> <span class="currency">ج.م.</span></span></td>')
    expect(html).toContain('<td class="l"><span class="money stacked" dir="ltr"><span class="amount">225</span> <span class="currency">ج.م.</span></span></td>')
  })

  it('shows add-ons, their available prices, variants, and item notes beneath the product', async () => {
    const html = await buildThermalReceiptHtml(receiptData())

    expect(html).toContain('<span class="item-variant">(8 قطع)</span>')
    expect(html).toContain('+ أفوكادو ×1')
    expect(html).toContain('<span class="amount">25</span>')
    expect(html).toContain('ملاحظة: بدون مايونيز')
  })

  it('shows customer contact details, delivery address, cashier, and payment method from the order', async () => {
    const html = await buildThermalReceiptHtml(receiptData())

    expect(html).toContain('<bdi dir="ltr">01000000000</bdi>')
    expect(html).toContain('<span dir="auto">عنوان تجريبي</span>')
    expect(html).toContain('<span dir="auto">كاشير تجريبي</span>')
    expect(html).toContain('<span dir="auto">نقدي</span>')
  })

  it('keeps persisted subtotal, discount, tax, total, and payment values unchanged', async () => {
    const html = await buildThermalReceiptHtml(receiptData())

    expect(html).toContain('<div class="summary-row"><span>المجموع</span><span><span class="money" dir="ltr"><span class="amount">225</span> <span class="currency">ج.م.</span></span></span></div>')
    expect(html).toContain('<div class="summary-row"><span>الخصم</span><span><span class="money" dir="ltr"><span class="amount">-25</span> <span class="currency">ج.م.</span></span></span></div>')
    expect(html).toContain('<div class="summary-row"><span>ضريبة القيمة المضافة 14%</span><span><span class="money" dir="ltr"><span class="amount">28</span> <span class="currency">ج.م.</span></span></span></div>')
    expect(html).toContain('<div class="summary-row payment"><span>المدفوع</span><span><span class="money" dir="ltr"><span class="amount">228</span> <span class="currency">ج.م.</span></span></span></div>')
  })

  it('wraps long mixed-language product names without clipping numeric columns', async () => {
    const data = receiptData(58)
    data.items[0].name_snapshot = 'سوشي رول سلمون وأفوكادو مع صوص حلو Special Roll مع إضافات extra'
    const html = await buildThermalReceiptHtml(data)

    expect(html).toMatch(/table\s*\{[^}]*table-layout:\s*fixed/)
    expect(html).toMatch(/\.item-name\s*\{[^}]*overflow-wrap:\s*anywhere/)
    expect(html).not.toMatch(/td\.l\s*\{[^}]*white-space:\s*nowrap/)
    expect(html).toMatch(/\.money\s*\{[^}]*overflow-wrap:\s*anywhere/)
    expect(html).toContain('سوشي رول سلمون وأفوكادو مع صوص حلو Special Roll مع إضافات extra')
  })

  it.each([
    { width: 80 as const, maxNumericColumnsMm: 40 },
    { width: 58 as const, maxNumericColumnsMm: 29 }
  ])('reserves enough item-name width on $width mm paper', async ({ width, maxNumericColumnsMm }) => {
    const html = await buildThermalReceiptHtml(receiptData(width))
    const qtyWidth = Number(html.match(/col\.qty\s*\{\s*width:\s*(\d+)mm/)?.[1])
    const unitWidth = Number(html.match(/col\.unit\s*\{\s*width:\s*(\d+)mm/)?.[1])
    const totalWidth = Number(html.match(/col\.total\s*\{\s*width:\s*(\d+)mm/)?.[1])

    expect(qtyWidth + unitWidth + totalWidth).toBeLessThanOrEqual(maxNumericColumnsMm)
  })

  it('finishes with the thank-you message and restaurant branding', async () => {
    const html = await buildThermalReceiptHtml(receiptData())

    expect(html).toContain('<div class="thanks">شكراً لزيارتكم — SUSHI ROLLS</div>')
    expect(html).toContain('<div class="foot-brand">SUSHI ROLLS</div>')
    expect(html).toMatch(/\.foot\s*\{[^}]*break-inside:\s*avoid/)
  })

  it('forces exact print colors for the blue total container', async () => {
    const html = await buildThermalReceiptHtml(receiptData())

    expect(html).toContain('-webkit-print-color-adjust: exact;')
    expect(html).toContain('print-color-adjust: exact;')
  })

  it('passes the selected 58mm paper width to Electron', async () => {
    await printThermalReceipt(receiptData(58))

    expect(printReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceName: 'Printer POS-80',
        silent: true,
        widthMm: 58
      })
    )
  })

  it('matches kitchen ticket paper width to the selected 58mm printer', async () => {
    const html = await buildKitchenTicketHtml(receiptData(58))

    expect(html).toContain('@page { size: 58mm auto; margin: 0; }')
    expect(html).toMatch(/body\s*\{[^}]*width:\s*48mm/)
  })

  it('passes the selected 58mm width when printing a kitchen ticket', async () => {
    await printKitchenTicket(receiptData(58))

    expect(printReceipt).toHaveBeenCalledWith(expect.objectContaining({ widthMm: 58 }))
  })

  it('prints a sample invoice through the real thermal template with current printer settings', async () => {
    const result = await printSampleReceipt(receiptData(58).settings)

    expect(result).toEqual({ ok: true })
    expect(printReceipt).toHaveBeenCalledTimes(1)
    const args = printReceipt.mock.calls[0][0]
    expect(args).toEqual(
      expect.objectContaining({
        deviceName: 'Printer POS-80',
        silent: true,
        widthMm: 58
      })
    )
    expect(args.html).toContain('data:image/png;base64,UI_LOGO')
    expect(args.html).toContain('سوشي رول سلمون')
    expect(args.html).toContain('فاتورة اختبار — غير صالحة للدفع')
  })
})

describe('12 required test scenarios (Section 10)', () => {
  it('Scenario 1: Single product — complete, correctly aligned receipt', async () => {
    const data = receiptData(80)
    data.items = [data.items[0]]
    const html = await buildThermalReceiptHtml(data)
    expect(html).toContain('سوشي رول سلمون')
    expect(html).toContain('head')
    expect(html).toContain('foot')
    expect(html).toContain('grand-total')
  })

  it('Scenario 2: Many products — natural height expansion without missing items', async () => {
    const data = receiptData(80)
    data.items = Array.from({ length: 15 }, (_, i) => ({
      ...data.items[0],
      id: `item-${i + 1}`,
      name_snapshot: `صنف رقم ${i + 1}`
    }))
    const html = await buildThermalReceiptHtml(data)
    for (let i = 1; i <= 15; i++) {
      expect(html).toContain(`صنف رقم ${i}`)
    }
    expect(html).toContain('thanks')
    expect(html).toContain('foot-brand')
  })

  it('Scenario 3: Long Arabic names — correct RTL wrapping with word-break', async () => {
    const data = receiptData(58)
    data.items[0].name_snapshot = 'وجبة سوشي كومبو عائلي فاخر مكونة من أربعين قطعة مشكلة من أفضل المكونات البحرية الطازجة'
    const html = await buildThermalReceiptHtml(data)
    expect(html).toContain(data.items[0].name_snapshot)
    expect(html).toMatch(/\.item-name\s*\{[^}]*word-break:\s*break-word/)
  })

  it('Scenario 4: Mixed Arabic and English — correct shaping and alignment', async () => {
    const data = receiptData(58)
    data.items[0].name_snapshot = 'رول سلمون مدخن Smoked Salmon Roll حجم XL مع سبايسي مايونيز Spicy Mayo'
    const html = await buildThermalReceiptHtml(data)
    expect(html).toContain(data.items[0].name_snapshot)
    expect(html).toMatch(/\.item-name\s*\{[^}]*unicode-bidi:\s*plaintext/)
  })

  it('Scenario 5: Products with add-ons — complete options and descriptions', async () => {
    const data = receiptData(80)
    data.items[0].order_item_extras = [
      { id: 'ex-1', order_item_id: 'item-1', extra_id: null, name_snapshot: 'صوص ترياكي', price: 15, quantity: 2 },
      { id: 'ex-2', order_item_id: 'item-1', extra_id: null, name_snapshot: 'سمسم محمص', price: 10, quantity: 1 }
    ]
    data.items[0].notes = 'يرجى تحضيره ساخن وبدون شطة'
    const html = await buildThermalReceiptHtml(data)
    expect(html).toContain('صوص ترياكي')
    expect(html).toContain('سمسم محمص')
    expect(html).toContain('يرجى تحضيره ساخن وبدون شطة')
  })

  it('Scenario 6: Discounts — existing values preserved accurately', async () => {
    const data = receiptData(80)
    data.order.subtotal = 500
    data.order.discount = 75
    data.order.total = 425
    const html = await buildThermalReceiptHtml(data)
    expect(html).toContain('<span class="amount">-75</span>')
    expect(html).toContain('<span class="amount">425</span>')
  })

  it('Scenario 7: Taxes — existing values preserved accurately when enabled', async () => {
    const data = receiptData(80)
    data.order.tax_rate = 14
    data.order.tax = 63
    data.settings.receipt = { show_tax: true }
    const html = await buildThermalReceiptHtml(data)
    expect(html).toContain('ضريبة القيمة المضافة 14%')
    expect(html).toContain('<span class="amount">63</span>')
  })

  it('Scenario 8: Delivery fees — correct display in summary', async () => {
    const data = receiptData(80)
    ;(data.order as unknown as { delivery_fee: number }).delivery_fee = 35
    const html = await buildThermalReceiptHtml(data)
    expect(html).toContain('خدمة التوصيل')
    expect(html).toContain('<span class="amount">35</span>')
  })

  it('Scenario 9: Long customer details — no clipping or overflow', async () => {
    const data = receiptData(58)
    data.order.customer_name = 'الأستاذ عبد الرحمن محمد عبد العزيز الشناوي'
    data.order.customer_phone = '01012345678 - 01298765432'
    data.order.customer_address = 'عمارة 45 ش التسعين الشمالي، التجمع الخامس، الدور الرابع شقة 16 خلف مول داون تاون'
    const html = await buildThermalReceiptHtml(data)
    expect(html).toContain('الأستاذ عبد الرحمن محمد عبد العزيز الشناوي')
    expect(html).toContain('عمارة 45 ش التسعين الشمالي')
    expect(html).toMatch(/\.meta\s*>\s*span:last-child\s*\{[^}]*overflow-wrap:\s*anywhere/)
  })

  it('Scenario 10: 58mm printer — fully contained within 48mm usable width', async () => {
    const html = await buildThermalReceiptHtml(receiptData(58))
    expect(html).toContain('--receipt-paper-width: 58mm;')
    expect(html).toContain('--receipt-printable-width: 48mm;')
    expect(html).toContain('--receipt-content-width: 48mm;')
  })

  it('Scenario 11: 80mm printer — fully contained within 72mm usable width', async () => {
    const html = await buildThermalReceiptHtml(receiptData(80))
    expect(html).toContain('--receipt-paper-width: 80mm;')
    expect(html).toContain('--receipt-printable-width: 72mm;')
    expect(html).toContain('--receipt-content-width: 72mm;')
  })

  it('Scenario 12: Long invoice — complete footer and all invoice items visible', async () => {
    const data = receiptData(80)
    data.items = Array.from({ length: 25 }, (_, i) => ({
      ...data.items[0],
      id: `long-item-${i + 1}`,
      name_snapshot: `رول تجريبي خاص ${i + 1}`,
      line_total: 100
    }))
    data.order.notes = 'ملاحظات إضافية للأوردر الطويل للتأكد من نمو الارتفاع بشكل طبيعي'
    const html = await buildThermalReceiptHtml(data)
    expect(html).toContain('رول تجريبي خاص 25')
    expect(html).toContain('ملاحظات إضافية للأوردر الطويل')
    expect(html).toContain('شكراً لزيارتكم — SUSHI ROLLS')
    expect(html).toContain('SUSHI ROLLS')
    expect(html).not.toMatch(/overflow:\s*hidden/)
  })
})
