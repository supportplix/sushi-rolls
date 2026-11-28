import { describe, expect, it } from 'vitest'
import { calcDiscount, calcTotals } from '../src/renderer/src/lib/totals'
import { money, num, parseNum } from '../src/renderer/src/lib/format'

describe('calcDiscount', () => {
  it('applies percentage discounts', () => {
    expect(calcDiscount(200, 'percent', 10)).toBe(20)
  })

  it('caps percentage at 100', () => {
    expect(calcDiscount(200, 'percent', 150)).toBe(200)
  })

  it('caps fixed discounts at subtotal', () => {
    expect(calcDiscount(100, 'fixed', 150)).toBe(100)
  })

  it('ignores negative values', () => {
    expect(calcDiscount(100, 'percent', -5)).toBe(0)
    expect(calcDiscount(100, 'fixed', -5)).toBe(0)
  })
})

describe('calcTotals', () => {
  it('calculates exclusive tax after discount', () => {
    const t = calcTotals(200, 'percent', 10, { enabled: true, rate: 14, inclusive: false })
    expect(t.discount).toBe(20)
    expect(t.tax).toBe(25.2)
    expect(t.total).toBe(205.2)
  })

  it('calculates inclusive tax inside the total', () => {
    const t = calcTotals(114, 'none', 0, { enabled: true, rate: 14, inclusive: true })
    expect(t.total).toBe(114)
    expect(t.tax).toBe(14)
  })

  it('has no tax when disabled', () => {
    const t = calcTotals(100, 'none', 0, { enabled: false, rate: 14 })
    expect(t.tax).toBe(0)
    expect(t.total).toBe(100)
  })
})

describe('money', () => {
  it('never pads decimals for whole numbers', () => {
    expect(money(50)).toBe('50 ج.م.')
    expect(money('120')).toBe('120 ج.م.')
  })

  it('shows cents only when the value has them', () => {
    expect(money(12.25)).toBe('12.25 ج.م.')
    expect(money(609.5)).toBe('609.5 ج.م.')
  })

  it('formats thousands without breaking the currency suffix', () => {
    expect(money(1250)).toBe('1,250 ج.م.')
  })

  it('handles negatives', () => {
    expect(money(-30)).toBe('-30 ج.م.')
  })
})

describe('parseNum', () => {
  it('parses empty input as zero', () => {
    expect(parseNum('')).toBe(0)
  })

  it('strips non numeric characters', () => {
    expect(parseNum('1,250.5 ج.م.')).toBe(1250.5)
  })

  it('parses Arabic-Indic digits and Arabic separators', () => {
    expect(parseNum('١٢٥٠٫٥')).toBe(1250.5)
    expect(parseNum('١٢٣')).toBe(123)
    expect(parseNum('١٬٢٣٤٫٥٦ ج.م.')).toBe(1234.56)
  })

  it('parses Extended Arabic-Indic (Persian) digits and separators', () => {
    expect(parseNum('۱۲٫۷۵')).toBe(12.75)
    expect(parseNum('۱٬۲۵۰٫۵')).toBe(1250.5)
  })

  it('keeps the sign when Arabic digits use the Unicode minus', () => {
    expect(parseNum('−٥٠')).toBe(-50)
    expect(parseNum('−۵۰٫۲۵')).toBe(-50.25)
  })

  it('does not turn a purely non numeric Arabic string into zero silently', () => {
    expect(parseNum('علبة')).toBe(0)
    expect(parseNum('٠')).toBe(0)
  })
})

describe('num', () => {
  it('formats quantities', () => {
    expect(num(0.125, 3)).toBe('0.125')
    expect(num(1250, 0)).toBe('1,250')
  })
})
