import type { MatchStrategy } from '../types.js'

/**
 * Score 0.40. The movement came from an account the expectation knows pays it.
 *
 * False-positive risk: an account is not an identity. Payers use the same
 * account for several invoices, forward payments for someone else, and an
 * account listed once stays a "known payer" forever. This is corroboration
 * only: it must stay below the 0.70 threshold, so on its own it goes to a
 * person, and two expectations listing the same payer stay ambiguous.
 */
export const knownPayerStrategy: MatchStrategy = {
  name: 'known_payer',
  family: 'payer',
  evaluate(movement, { expectation }) {
    const payer = movement.counterparty
    if (payer === null || !expectation.payers.includes(payer)) return null
    return {
      strategy: 'known_payer',
      family: 'payer',
      score: 0.4,
      reason: `paid by ${payer}, a known payer of ${expectation.reference}`,
    }
  },
}
