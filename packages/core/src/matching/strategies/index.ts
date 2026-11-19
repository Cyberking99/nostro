import type { MatchStrategy } from '../types.js'
import { exactAmountStrategy } from './exact-amount.js'
import { memoContainedStrategy } from './memo-contained.js'
import { memoIdStrategy } from './memo-id.js'
import { memoNearMissStrategy } from './memo-near-miss.js'
import { memoTextStrategy } from './memo-text.js'
import { muxedIdStrategy } from './muxed-id.js'

export { exactAmountStrategy, memoContainedStrategy, memoIdStrategy, memoNearMissStrategy, memoTextStrategy, muxedIdStrategy }

/**
 * The default strategies, strongest first. The ordering and scores are
 * opinionated and documented on purpose: configurable matching rules are how
 * reconciliation systems become impossible to audit.
 */
export const DEFAULT_STRATEGIES: readonly MatchStrategy[] = [
  muxedIdStrategy,
  memoIdStrategy,
  memoTextStrategy,
  memoContainedStrategy,
  memoNearMissStrategy,
  exactAmountStrategy,
]
