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
})
