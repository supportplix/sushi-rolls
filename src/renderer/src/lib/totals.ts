export interface TaxConfig {
  enabled?: boolean
  rate?: number
  inclusive?: boolean
}

export type DiscountType = 'none' | 'percent' | 'fixed'

export function calcDiscount(subtotal: number, type: DiscountType, value: number): number {
  const v = Number.isFinite(value) ? Math.max(value, 0) : 0
  if (type === 'percent') return (Math.min(v, 100) * subtotal) / 100
  if (type === 'fixed') return Math.min(v, subtotal)
  return 0
}

export function calcTotals(
  subtotal: number,
  discountType: DiscountType,
  discountValue: number,
  tax: TaxConfig | undefined
): { discount: number; tax: number; total: number; net: number } {
  const discount = Math.round(calcDiscount(subtotal, discountType, discountValue) * 100) / 100
  const net = subtotal - discount
  let taxAmount = 0
  let total = net
  if (tax?.enabled && (tax.rate ?? 0) > 0) {
    const rate = Number(tax.rate ?? 0)
    if (tax.inclusive) {
      taxAmount = Math.round((net * rate) / (100 + rate) * 100) / 100
      total = net
    } else {
      taxAmount = Math.round(((net * rate) / 100) * 100) / 100
      total = net + taxAmount
    }
  }
  return { discount, tax: taxAmount, total: Math.round(total * 100) / 100, net }
}
