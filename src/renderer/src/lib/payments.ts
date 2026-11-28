import { parseNum } from './format'

/**
 * Payment dialog guard. A zero-total order (e.g. 100% discount) is settled with
 * an explicit zero payment; negatives and any amount above the outstanding
 * balance are rejected before the RPC is called.
 */
export function canSubmitPayment(remaining: number, rawAmount: string): boolean {
  const amount = parseNum(rawAmount)
  if (!Number.isFinite(amount)) return false
  const amountCents = Math.round(amount * 100)
  const remainingCents = Math.round(remaining * 100)
  if (amountCents < 0) return false
  // Zero payment settles only a genuinely zero-total order, never an
  // already-overpaid/negative balance.
  if (remainingCents === 0) return amountCents === 0
  if (remainingCents < 0) return false
  return amountCents > 0 && amountCents <= remainingCents
}
