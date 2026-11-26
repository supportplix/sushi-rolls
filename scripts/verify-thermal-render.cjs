const { app, BrowserWindow } = require('electron')
const { writeFileSync, mkdirSync, existsSync } = require('fs')
const { join } = require('path')

const THERMAL_PROFILES = {
  58: {
    paperWidthMm: 58,
    printableWidthMm: 48,
    safeMarginMm: 5,
    contentPaddingMm: 1.5,
    bottomFeedClearanceMm: 8
  },
  80: {
    paperWidthMm: 80,
    printableWidthMm: 72,
    safeMarginMm: 4,
    contentPaddingMm: 2,
    bottomFeedClearanceMm: 10
  }
}

const RECEIPT_MIN_PAGE_HEIGHT_MM = 40
const RECEIPT_MAX_PAGE_HEIGHT_MM = 2000

function receiptPageSize(widthMm, contentHeightPx) {
  const width = widthMm === 58 ? 58 : 80
  const px = Number(contentHeightPx ?? 0)
  const heightMm = Number.isFinite(px) && px > 0
    ? Math.min(Math.max(Math.ceil(px * 25.4 / 96) + 6, RECEIPT_MIN_PAGE_HEIGHT_MM), RECEIPT_MAX_PAGE_HEIGHT_MM)
    : RECEIPT_MIN_PAGE_HEIGHT_MM
  return { width: width * 1000, height: heightMm * 1000 }
}

const ARTIFACT_DIR = process.env.ARTIFACT_DIR || 'C:\\Users\\Osama\\.gemini\\antigravity\\brain\\8592336c-8496-456b-9052-452de4d256b7'

app.disableHardwareAcceleration()
app.on('window-all-closed', (e) => e.preventDefault())

async function runVerification() {
  await app.whenReady()
  console.log('--- Starting Thermal Rendering Verification in Electron Chromium ---')

  const results = []

  const testCases = [
    {
      name: '58mm-standard-order',
      widthMm: 58,
      itemsCount: 3,
      customerName: 'عميل تجريبي',
      notes: 'فاتورة اختبار 58 مم'
    },
    {
      name: '80mm-standard-order',
      widthMm: 80,
      itemsCount: 3,
      customerName: 'عميل تجريبي',
      notes: 'فاتورة اختبار 80 مم'
    },
    {
      name: '58mm-long-arabic-mixed',
      widthMm: 58,
      itemsCount: 4,
      longNames: true,
      customerName: 'الأستاذ عبد الرحمن الشناوي - التجمع الخامس',
      notes: 'وجبة سريعة مع صوص حار إضافي وسبايسي مايونيز'
    },
    {
      name: '80mm-long-invoice-many-items',
      widthMm: 80,
      itemsCount: 15,
      customerName: 'شركة النور للمقاولات - طلب صالة',
      notes: 'فاتورة طويلة متعددة الأصناف للتأكد من نمو الارتفاع وعدم انقسام الصفحات'
    }
  ]

  for (const tc of testCases) {
    console.log(`\nTesting Case: ${tc.name} (${tc.widthMm}mm)...`)
    const profile = THERMAL_PROFILES[tc.widthMm]

    // Create realistic HTML
    const items = []
    for (let i = 1; i <= tc.itemsCount; i++) {
      const name = tc.longNames
        ? (i % 2 === 0
            ? 'سوشي رول كاليفورنيا بالجمبري المقلي California Shrimp Tempura Roll مع صوص سبيشال'
            : 'كومبو ماكسي رول فاخر مشكل من السلمون والتونة الطازجة')
        : `سوشي رول كلاسيك صنف ${i}`
      items.push({
        id: `it-${i}`,
        name_snapshot: name,
        variant_name: i % 2 === 0 ? '8 قطع' : '4 قطع',
        quantity: i,
        unit_price: 120 + i * 10,
        line_total: (120 + i * 10) * i,
        extras: i === 1 ? '+ أفوكادو ×1 · 25 ج.م.' : '',
        note: i === 2 ? 'ملاحظة: بدون مايونيز' : ''
      })
    }

    const subtotal = items.reduce((s, it) => s + it.line_total, 0)
    const discount = 20
    const tax = Math.round((subtotal - discount) * 0.14 * 10) / 10
    const total = subtotal - discount + tax

    const rowsHtml = items.map(it => `
      <tr>
        <td>
          <div class="item-name">${it.name_snapshot} <span class="item-variant">(${it.variant_name})</span></div>
          ${it.extras ? `<div class="item-extra">${it.extras}</div>` : ''}
          ${it.note ? `<div class="item-note">${it.note}</div>` : ''}
        </td>
        <td class="c">${it.quantity}</td>
        <td class="l"><span class="money stacked" dir="ltr"><span class="amount">${it.unit_price}</span> <span class="currency">ج.م.</span></span></td>
        <td class="l"><span class="money stacked" dir="ltr"><span class="amount">${it.line_total}</span> <span class="currency">ج.م.</span></span></td>
      </tr>
    `).join('')

    const narrow = tc.widthMm === 58
    const printableWidth = `${profile.printableWidthMm}mm`
    const paperWidth = `${profile.paperWidthMm}mm`
    const safeMargin = `${profile.safeMarginMm}mm`
    const contentPadding = `${profile.contentPaddingMm}mm`
    const bottomPadding = `${profile.bottomFeedClearanceMm}mm`

    const html = `<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8">
    <style>
      @page { size: ${paperWidth} auto; margin: 0; }
      :root {
        --receipt-paper-width: ${paperWidth};
        --receipt-printable-width: ${printableWidth};
        --receipt-safe-margin: ${safeMargin};
        --receipt-content-padding: ${contentPadding};
        --receipt-content-width: ${printableWidth};
        --receipt-print-margin: 0;
      }
      *, *::before, *::after { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      html, body { background: #fff; }
      html { width: var(--receipt-paper-width); margin: 0; padding: 0; }
      body {
        width: var(--receipt-content-width);
        max-width: var(--receipt-content-width);
        min-height: 0;
        height: auto;
        margin: 0 auto;
        padding: ${narrow ? '3mm' : '4mm'} var(--receipt-content-padding) ${bottomPadding};
        font-family: 'Segoe UI', Tahoma, sans-serif;
        color: #174EA6;
        font-size: ${narrow ? '10px' : '11.5px'};
        line-height: 1.4;
        overflow: visible;
      }
      .head { text-align: center; padding-bottom: 2.5mm; border-bottom: 1.5px dashed #174EA6; margin-bottom: 2.5mm; }
      .brand { font-size: ${narrow ? '17px' : '20px'}; font-weight: 900; letter-spacing: .5px; }
      .contact { margin-top: 1mm; font-size: ${narrow ? '8.5px' : '9.5px'}; line-height: 1.45; overflow-wrap: anywhere; }
      .order-no { text-align: center; font-size: ${narrow ? '24px' : '30px'}; font-weight: 900; line-height: 1.1; margin: 0 0 2mm; }
      .order-no small { display: block; margin-top: 1mm; font-size: ${narrow ? '8.5px' : '9.5px'}; font-weight: 700; }
      .meta { display: grid; grid-template-columns: ${narrow ? '15mm' : '20mm'} minmax(0, 1fr); gap: 1.5mm; padding: 1mm 0; border-bottom: .5px dotted #8FB2E3; font-size: ${narrow ? '8.5px' : '9.5px'}; }
      .meta > span:first-child { font-weight: 700; }
      .meta > span:last-child { text-align: left; overflow-wrap: anywhere; word-break: break-word; }
      table { width: 100%; table-layout: fixed; border-collapse: collapse; margin-top: 2.5mm; }
      col.qty { width: ${narrow ? '5mm' : '7mm'}; }
      col.unit { width: ${narrow ? '11mm' : '14mm'}; }
      col.total { width: ${narrow ? '12mm' : '16mm'}; }
      th { padding: 1.4mm .5mm; border-top: 1.5px dashed #174EA6; border-bottom: 1.5px solid #174EA6; font-size: ${narrow ? '8.5px' : '9.5px'}; font-weight: 800; text-align: right; }
      td { padding: 1.6mm .5mm; border-bottom: .5px dotted #8FB2E3; vertical-align: top; font-size: ${narrow ? '9.5px' : '11px'}; overflow-wrap: anywhere; word-break: break-word; }
      th:first-child, td:first-child { padding-right: 0; }
      th:last-child, td:last-child { padding-left: 0; }
      th.c, td.c { text-align: center; }
      th.l, td.l { text-align: left; }
      td.l { font-weight: 800; }
      .item-name { font-weight: 800; unicode-bidi: plaintext; overflow-wrap: anywhere; word-break: break-word; line-height: 1.35; }
      .item-variant, .item-extra, .item-note { margin-top: .6mm; font-size: ${narrow ? '8.5px' : '9.5px'}; font-weight: 500; line-height: 1.4; overflow-wrap: anywhere; word-break: break-word; }
      .money { display: inline-block; direction: ltr; unicode-bidi: isolate; white-space: normal; overflow-wrap: anywhere; }
      .money.stacked .currency { display: block; font-size: .78em; font-weight: 500; line-height: 1.15; }
      .totals { margin-top: 2.5mm; padding-top: 1.5mm; border-top: 1.5px dashed #174EA6; }
      .summary-row { display: flex; justify-content: space-between; gap: 1.5mm; padding: .8mm 0; font-size: ${narrow ? '8.5px' : '9.5px'}; }
      .grand-total { display: flex; align-items: center; justify-content: space-between; gap: 2mm; margin: 2mm 0 1.5mm; padding: ${narrow ? '2mm 2.5mm' : '2.5mm 3.5mm'}; background: #174EA6; border: 1.5px solid #174EA6; color: #fff; font-weight: 900; border-radius: 1mm; }
      .grand-total span { color: #fff; }
      .grand-total .money { font-size: ${narrow ? '17px' : '21px'}; line-height: 1.2; color: #fff; }
      .grand-total .currency { font-size: .62em; color: #fff; }
      .order-note { display: grid; grid-template-columns: ${narrow ? '15mm' : '20mm'} minmax(0, 1fr); gap: 1.5mm; margin-top: 2.5mm; padding: 1.5mm 0; border-top: .5px dotted #8FB2E3; border-bottom: .5px dotted #8FB2E3; font-size: ${narrow ? '8.5px' : '9.5px'}; }
      .order-note > span:first-child { font-weight: 800; }
      .foot { margin-top: 3.5mm; padding-top: 2.5mm; border-top: 1.5px dashed #174EA6; text-align: center; overflow-wrap: anywhere; word-break: break-word; }
      .thanks { font-size: ${narrow ? '9.5px' : '11px'}; font-weight: 700; line-height: 1.4; }
      .foot-brand { margin-top: 1mm; font-size: ${narrow ? '12px' : '14px'}; font-weight: 900; letter-spacing: .8px; }
      @media print {
        *, *::before, *::after { box-sizing: border-box; }
        html, body {
          width: var(--receipt-printable-width);
          max-width: var(--receipt-printable-width);
          margin: 0 auto;
          padding-left: var(--receipt-content-padding);
          padding-right: var(--receipt-content-padding);
          height: auto !important;
          min-height: 0 !important;
          overflow: visible !important;
        }
        body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        .receipt-item, tr, .meta, .head, .order-no, .order-note, .totals, .grand-total, .foot { break-inside: avoid; page-break-inside: avoid; }
      }
    </style></head><body>
      <div class="head">
        <div class="brand">SUSHI ROLLS</div>
        <div class="contact" dir="ltr">01000000000</div>
        <div class="contact">القاهرة - جمهورية مصر العربية</div>
      </div>
      <div class="order-no"><bdi dir="ltr">#100234</bdi><small>أوردر رقم</small></div>
      <div class="meta"><span>التاريخ</span><span dir="auto">24‏/11‏/2026 · 01:30 ص</span></div>
      <div class="meta"><span>النوع</span><span dir="auto">صالة · ترابيزة 4</span></div>
      <div class="meta"><span>الكاشير</span><span dir="auto">أحمد علي</span></div>
      <div class="meta"><span>العميل</span><span dir="auto">${tc.customerName}</span></div>
      <table>
        <colgroup><col class="item"><col class="qty"><col class="unit"><col class="total"></colgroup>
        <thead><tr><th>الصنف</th><th class="c">عدد</th><th class="l">سعر</th><th class="l">الإجمالي</th></tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
      <div class="totals">
        <div class="summary-row"><span>المجموع</span><span><span class="money" dir="ltr"><span class="amount">${subtotal}</span> <span class="currency">ج.م.</span></span></span></div>
        <div class="summary-row"><span>الخصم</span><span><span class="money" dir="ltr"><span class="amount">-${discount}</span> <span class="currency">ج.م.</span></span></span></div>
        <div class="summary-row"><span>ضريبة القيمة المضافة 14%</span><span><span class="money" dir="ltr"><span class="amount">${tax}</span> <span class="currency">ج.م.</span></span></span></div>
        <div class="grand-total"><span>الإجمالي</span><span><span class="money" dir="ltr"><span class="amount">${total}</span> <span class="currency">ج.م.</span></span></span></div>
        <div class="summary-row payment"><span>المدفوع</span><span><span class="money" dir="ltr"><span class="amount">${total}</span> <span class="currency">ج.م.</span></span></span></div>
      </div>
      ${tc.notes ? `<div class="order-note"><span>ملاحظة</span><span dir="auto">${tc.notes}</span></div>` : ''}
      <div class="foot">
        <div class="thanks">شكراً لزيارتكم — SUSHI ROLLS</div>
        <div class="foot-brand">SUSHI ROLLS</div>
      </div>
    </body></html>`

    const tmpFile = join(ARTIFACT_DIR, `temp-${tc.name}.html`)
    if (!existsSync(ARTIFACT_DIR)) mkdirSync(ARTIFACT_DIR, { recursive: true })
    writeFileSync(tmpFile, html, 'utf8')

    const win = new BrowserWindow({
      show: false,
      width: Math.ceil(profile.paperWidthMm * 96 / 25.4) + 100,
      height: 900,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })

    await win.loadFile(tmpFile)

    // Inspect rendered layout in Chromium
    const layout = await win.webContents.executeJavaScript(`
      (() => {
        const body = document.body;
        const bodyRect = body.getBoundingClientRect();
        const htmlRect = document.documentElement.getBoundingClientRect();
        const foot = document.querySelector('.foot');
        const footRect = foot ? foot.getBoundingClientRect() : null;
        const grandTotal = document.querySelector('.grand-total');
        const grandTotalRect = grandTotal ? grandTotal.getBoundingClientRect() : null;
        const table = document.querySelector('table');
        const tableRect = table ? table.getBoundingClientRect() : null;

        const elements = Array.from(document.body.querySelectorAll('*'));
        let hasInternalOverflow = false;
        elements.forEach(el => {
          if (el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0 && !['HTML', 'BODY'].includes(el.tagName)) {
            // Check if element has horizontal overflow
            const style = window.getComputedStyle(el);
            if (style.overflowX !== 'hidden' && style.overflowX !== 'clip' && el.scrollWidth > bodyRect.width + 1) {
              hasInternalOverflow = true;
            }
          }
        });

        return {
          bodyLeft: bodyRect.left,
          bodyWidth: bodyRect.width,
          bodyHeight: bodyRect.height,
          bodyScrollWidth: body.scrollWidth,
          bodyClientWidth: body.clientWidth,
          docScrollHeight: Math.ceil(Math.max(
            document.documentElement.scrollHeight,
            document.body.scrollHeight,
            bodyRect.height,
            footRect ? footRect.bottom : 0
          )),
          hasTable: !!table,
          tableWidth: tableRect ? tableRect.width : 0,
          hasGrandTotal: !!grandTotal,
          hasFooter: !!foot,
          footerVisible: footRect ? (footRect.height > 0 && footRect.bottom <= bodyRect.bottom + 5) : false,
          hasInternalOverflow,
          bodyOverflowsWidth: body.scrollWidth > body.clientWidth + 1
        };
      })()
    `)

    console.log(`Measured layout: bodyLeft=${layout.bodyLeft.toFixed(1)}px, bodyWidth=${layout.bodyWidth.toFixed(1)}px (~${(layout.bodyWidth * 25.4 / 96).toFixed(1)}mm), scrollHeight=${layout.docScrollHeight}px, bodyOverflows=${layout.bodyOverflowsWidth}`)

    // Calculate pageSize using our centralized helper
    const pageSize = receiptPageSize(tc.widthMm, layout.docScrollHeight)
    console.log(`Computed pageSize: width=${pageSize.width / 1000}mm, height=${pageSize.height / 1000}mm`)

    // Generate PDF to verify exact print media output & page count
    const pdfBuffer = await win.webContents.printToPDF({
      printBackground: true,
      pageSize,
      margins: { marginType: 'none' }
    })

    // Inspect PDF page count by searching for "/Type /Page" or "/Count"
    const pdfText = pdfBuffer.toString('binary')
    const pageMatches = (pdfText.match(/\/Type\s*\/Page\b/g) || []).length
    console.log(`Generated PDF size: ${pdfBuffer.length} bytes, PDF Page count: ${pageMatches}`)

    // Set window content size to fit entire document height for complete visual capture
    win.setContentSize(win.getContentBounds().width, Math.max(900, layout.docScrollHeight + 50))
    await new Promise(r => setTimeout(r, 100))

    // Capture visual screenshot of the rendered receipt exactly at body coordinates
    const screenshot = await win.webContents.capturePage({
      x: Math.max(0, Math.floor(layout.bodyLeft)),
      y: 0,
      width: Math.ceil(layout.bodyWidth),
      height: Math.ceil(layout.docScrollHeight)
    })

    const screenshotPath = join(ARTIFACT_DIR, `${tc.name}.png`)
    const pdfPath = join(ARTIFACT_DIR, `${tc.name}.pdf`)
    try {
      writeFileSync(screenshotPath, screenshot.toPNG())
      writeFileSync(pdfPath, pdfBuffer)
      console.log(`Saved screenshot to: ${screenshotPath}`)
      console.log(`Saved PDF to: ${pdfPath}`)
    } catch (e) {
      console.error('Failed to save file:', e)
    }

    const passed = (
      pageMatches === 1 &&
      layout.hasTable &&
      layout.hasGrandTotal &&
      layout.hasFooter &&
      !layout.bodyOverflowsWidth &&
      !layout.hasInternalOverflow
    )

    results.push({
      test: tc.name,
      widthMm: tc.widthMm,
      pageCount: pageMatches,
      bodyWidthMm: Number((layout.bodyWidth * 25.4 / 96).toFixed(1)),
      targetPrintableWidthMm: profile.printableWidthMm,
      overflow: layout.bodyOverflowsWidth,
      footerVisible: layout.footerVisible,
      status: passed ? 'PASSED' : 'FAILED'
    })

    win.destroy()
    await new Promise(r => setTimeout(r, 100))
  }

  console.log('\n--- VERIFICATION SUMMARY ---')
  console.table(results)

  const allPassed = results.every(r => r.status === 'PASSED')
  if (allPassed) {
    console.log('\nALL THERMAL PRINT RENDERING TESTS PASSED!')
    process.exit(0)
  } else {
    console.error('\nSOME TESTS FAILED!')
    process.exit(1)
  }
}

runVerification().catch(err => {
  console.error('Verification error:', err)
  process.exit(1)
})
