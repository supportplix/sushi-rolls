import { describe, expect, it } from 'vitest'
import { humanError } from '../src/renderer/src/lib/errors'

describe('humanError', () => {
  it('displays the service failure details instead of the generic retry message', () => {
    expect(humanError(new Error('SERVICE_ACTION_FAILED: service installer returned 1060'))).toBe(
      'service installer returned 1060'
    )
  })

  it('translates a service that is not installed', () => {
    expect(humanError(new Error('SERVICE_NOT_INSTALLED'))).toBe('خدمة البصمة غير مثبتة. اضغط «تثبيت الخدمة» أولاً.')
  })

  it('shows the underlying message for otherwise-untranslated enrollment errors', () => {
    expect(humanError(new Error('USB device is unavailable'), true)).toBe('USB device is unavailable')
  })

  it('keeps unrelated unknown errors generic by default', () => {
    expect(humanError(new Error('unexpected internal error'))).toBe('حصل خطأ، حاول تاني')
  })

  it('translates hardening and other backend error codes', () => {
    expect(humanError(new Error('ORDER_NOT_PAYABLE'))).toBe('الأوردر لا يقبل الدفع في حالته الحالية')
    expect(humanError(new Error('PAYMENT_EXCEEDS_TOTAL'))).toBe('المبلغ أكبر من إجمالي الأوردر')
    expect(humanError(new Error('PGRST202: function not found'))).toBe('وظيفة الاستعادة غير منشورة على قاعدة البيانات')
    expect(humanError(new Error('ENROLLMENT_BUSY'))).toBe('جهاز البصمة مشغول بتسجيل آخر — حاول بعد قليل')
  })

  it('translates dynamic service exit codes', () => {
    expect(humanError(new Error('SERVICE_EXIT_1060'))).toBe('فشل أمر خدمة البصمة (رمز الخروج 1060)')
  })
})
