import { ValidationError, assertStorableText } from '../model/index.js'
import type { Store } from '../store/index.js'

export interface ClosePeriodOptions {
  readonly store: Store
  readonly tenantId: string
  /** Inclusive upper bound; entries effective at this instant are closed. */
  readonly through: Date
  readonly note?: string
}

export interface ReopenPeriodOptions {
  readonly store: Store
  readonly tenantId: string
  readonly reason: string
}

function assertTenantId(tenantId: string): void {
  if (typeof tenantId !== 'string' || tenantId.trim() === '') {
    throw new ValidationError('tenantId', 'must be a non-empty string')
  }
  assertStorableText('tenantId', tenantId)
}

export async function closePeriod(options: ClosePeriodOptions): Promise<void> {
  const { store, tenantId, through } = options
  assertTenantId(tenantId)
  if (!(through instanceof Date) || Number.isNaN(through.getTime())) {
    throw new ValidationError('through', 'must be a valid date')
  }
  if (options.note !== undefined) {
    if (typeof options.note !== 'string' || options.note.trim() === '') {
      throw new ValidationError('note', 'must be a non-empty string when provided')
    }
    assertStorableText('note', options.note)
  }
  await store.transaction((tx) => tx.closeJournalPeriod(tenantId, through, options.note ?? null))
}

export async function reopenPeriod(options: ReopenPeriodOptions): Promise<void> {
  const { store, tenantId, reason } = options
  assertTenantId(tenantId)
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new ValidationError('reason', 'must be a non-empty string')
  }
  assertStorableText('reason', reason)
  await store.transaction((tx) => tx.reopenJournalPeriod(tenantId, reason))
}
