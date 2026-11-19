import { normalizeReference } from '../reference.js'
import type { MatchStrategy } from '../types.js'

const REPLACEMENT = '\uFFFD'

/** UTF-8 byte length without assuming a DOM or Node global is present. */
function utf8Length(text: string): number {
  let bytes = 0
  for (const char of text) {
    const cp = char.codePointAt(0)!
    if (cp <= 0x7f) bytes += 1
    else if (cp <= 0x7ff) bytes += 2
    else if (cp <= 0xffff) bytes += 3
    else bytes += 4
  }
  return bytes
}

/**
 * A wallet cuts at 28 *bytes*. A cut inside a multi-byte character leaves an
 * invalid byte which Horizon decodes as U+FFFD, so the stored text can be up
 * to 30 bytes long while still representing a 28-byte memo.
 */
function atTextMemoLimit(text: string): boolean {
  const bytes = utf8Length(text)
  return bytes === 28 || (bytes > 28 && text.includes(REPLACEMENT))
}

function isTruncatedPrefix(sent: string, full: string): boolean {
  const a = normalizeReference(sent)
  const b = normalizeReference(full)
  if (a === '' || b === '' || a === b) return false
  if (b.startsWith(a)) return true
  // The replacement character stands in for the bytes of the character the
  // wallet cut in half. Compare the text before it as the prefix.
  if (a.endsWith(REPLACEMENT)) {
    const before = a.slice(0, -1)
    return before !== '' && b.startsWith(before)
  }
  return false
}

/**
 * Score 0.60. A text memo at the 28-byte on-ledger limit that is a proper
 * prefix of the expectation's reference is probably that reference cut by the
 * payer's wallet. It is corroboration, never an identifier: long references
 * often share a prefix, so this stays below the 0.70 threshold and the engine
 * raises MEMO_TRUNCATED when it is the best evidence. A unique exact amount
 * can corroborate it to 0.84 and settle the payment.
 */
export const memoTruncatedStrategy: MatchStrategy = {
  name: 'memo_truncated',
  family: 'identifier',
  evaluate(movement, { expectation }) {
    if (movement.memo?.type !== 'text' || !atTextMemoLimit(movement.memo.value)) return null
    if (!isTruncatedPrefix(movement.memo.value, expectation.reference)) return null
    return {
      strategy: 'memo_truncated',
      family: 'identifier',
      score: 0.6,
      reason: `memo ${JSON.stringify(movement.memo.value)} looks like a 28-byte cut of reference ${expectation.reference}`,
    }
  },
}
