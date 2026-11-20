import type { Movement } from '../../model/index.js'
import { sumAmounts } from '../../store/index.js'
import type { Candidate, MatchStrategy } from '../types.js'

/**
 * Score 0.50 when this payment exactly matches the sum of 2+ open invoices,
 * all in the same asset and time window.
 *
 * A signal that the payer combined several invoices without individual memos.
 * The score is below threshold to avoid over-confident matches, but high enough
 * to suggest a split to a person.
 */
export const multipleInvoicesStrategy: MatchStrategy = {
  name: 'multiple_invoices',
  family: 'amount',
  evaluate(movement, candidate, all) {
    if (movement.amount.asset !== candidate.remaining.asset || movement.amount.decimals !== candidate.remaining.decimals) {
      return null
    }

    const fits = (c: Candidate) => {
      if (c.remaining.asset !== movement.amount.asset || c.remaining.decimals !== movement.amount.decimals) return false
      if (!c.remaining.isPositive()) return false
      const at = movement.occurredAt.getTime()
      if (c.expectation.expiresAt !== null && at > c.expectation.expiresAt.getTime()) return false
      return at >= c.expectation.createdAt.getTime() - 7 * 24 * 60 * 60 * 1000
    }

    const matches = all.filter(fits)
    if (matches.length < 2) return null

    const sum = sumAmounts(
      matches.map((c) => c.remaining),
      movement.amount,
    )
    if (!sum.equals(movement.amount)) return null

    return {
      strategy: 'multiple_invoices',
      family: 'amount',
      score: 0.5,
      reason: `payment exactly matches sum of ${matches.length} open invoices`,
    }
  },
}
