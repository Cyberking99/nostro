import { normalizeReference } from '../reference.js'
import type { MatchStrategy } from '../types.js'

/**
 * Score 0.75. Matches a memo sent in the wrong type:
 *
 * - **id memo for a text reference.** Payer sends `MEMO_ID 1042` for
 *   `INV-1042`. The id is turned into its decimal string and compared against
 *   the expectation's normalised reference and any normalised text memo it
 *   asked for. Leading zeros keep their meaning: `MEMO_ID 123` is never the
 *   reference `00123` — the payer would have sent `00123` as text if they
 *   meant that.
 * - **text memo for an id expectation.** Expectation asked for `MEMO_ID 9001`
 *   (or has `muxedId 9001`), payer types the text `"9001"`. The text memo is
 *   normalised and compared against the decimal string of every id the
 *   expectation carries (`memo.value` when type is `id`, and `muxedId`).
 *
 * Scored below the same-type strategies (0.95 / 0.85) because the wrong memo
 * type is itself weak evidence: the payer may also have typed the wrong number.
 * At 0.75 it clears the 0.70 threshold on its own only when no runner-up is
 * within 0.15, which is the ambiguity margin; in practice a corroborating
 * amount signal is what tips a cross-type match into automatic settlement.
 *
 * **False-positive risk:** Any numeric reference that happens to equal a
 * pending memo id or muxed id. Keep invoice numbers that are just integers
 * short, or prefer text prefixes (`INV-123` beats `123`).
 */
export const memoCrossTypeStrategy: MatchStrategy = {
  name: 'memo_cross_type',
  family: 'identifier',
  evaluate(movement, { expectation }) {
    // Case 1: payer sent an id memo; expectation expects text or has a text reference.
    if (movement.memo?.type === 'id') {
      const sentDecimal = movement.memo.value.toString()
      const refNorm = normalizeReference(expectation.reference)
      const refMatchesSentId = refNorm !== '' && refNorm === sentDecimal

      const askedTextNorm =
        expectation.memo?.type === 'text' ? normalizeReference(expectation.memo.value) : null
      const askedMatchesSentId = askedTextNorm !== null && askedTextNorm !== '' && askedTextNorm === sentDecimal

      if (!refMatchesSentId && !askedMatchesSentId) return null
      return {
        strategy: 'memo_cross_type',
        family: 'identifier',
        score: 0.75,
        reason:
          `id memo ${movement.memo.value} matches ` +
          (refMatchesSentId
            ? `reference ${expectation.reference} as a decimal string (wrong memo type)`
            : `the text memo asked for (wrong memo type)`),
      }
    }

    // Case 2: payer sent a text memo; expectation expects an id or has a muxed id.
    if (movement.memo?.type === 'text') {
      const sentNorm = normalizeReference(movement.memo.value)
      if (sentNorm === '') return null

      const askedIdValue =
        expectation.memo?.type === 'id' ? expectation.memo.value.toString() : null
      const muxedValue = expectation.muxedId !== null ? expectation.muxedId.toString() : null

      const matchesAskedId = askedIdValue !== null && sentNorm === askedIdValue
      const matchesMuxedId = muxedValue !== null && sentNorm === muxedValue

      if (!matchesAskedId && !matchesMuxedId) return null
      return {
        strategy: 'memo_cross_type',
        family: 'identifier',
        score: 0.75,
        reason:
          `text memo "${movement.memo.value}" normalises to ${sentNorm}, matching ` +
          (matchesAskedId ? `the id memo asked for (wrong memo type)` : `the muxed id (wrong memo type)`),
      }
    }

    return null
  },
}
