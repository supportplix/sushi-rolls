import { describe, expect, it } from 'vitest'
import { canSubmitPayment } from '../src/renderer/src/lib/payments'

describe('canSubmitPayment', () => {
  it('allows an explicit zero payment when the order total is zero', () => {
    expect(canSubmitPayment(0, '0')).toBe(true)
    expect(canSubmitPayment(0, '')).toBe(true)
    expect(canSubmitPayment(0, '٠')).toBe(true)
  })

  it('rejects any non-zero payment on a zero-total order', () => {
    expect(canSubmitPayment(0, '1')).toBe(false)
    expect(canSubmitPayment(0, '-1')).toBe(false)
  })

  it('rejects negative and overpayments', () => {
    expect(canSubmitPayment(50, '-1')).toBe(false)
    expect(canSubmitPayment(50, '50.01')).toBe(false)
    expect(canSubmitPayment(-5, '0')).toBe(false)
  })

  it('accepts a partial or exact payment of an outstanding balance', () => {
    expect(canSubmitPayment(50, '25')).toBe(true)
    expect(canSubmitPayment(50, '50')).toBe(true)
    expect(canSubmitPayment(50, '٥٠')).toBe(true)
  })
})
