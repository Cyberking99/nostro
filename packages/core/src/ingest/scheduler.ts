/**
 * A concurrent ingest scheduler.
 *
 * `schedule()` syncs many (source, account) streams with bounded concurrency
 * and fair turns. Rather than draining one account before touching the next,
 * each worker picks the stream that is most overdue, runs one `sync()` batch
 * on it, then yields. This keeps a backlogging account from blocking
 * today's payments on every other account.
 *
 * Backoff per stream: a stream that keeps erroring is retried less often
 * (exponential, capped at `maxBackoffMs`), without stalling the others.
 *
 * The scheduler never bypasses the compare-and-set that `sync()` relies on.
 * Two schedulers on the same database are safe: the loser of a cursor race
 * gets `contended=true` and backs off one round like any other failure.
 */
import type { MovementSource } from './source.js'
import type { SyncOptions, SyncReport, AccountSyncReport } from './sync.js'
import { sync } from './sync.js'
import type { Store } from '../store/index.js'

export interface SchedulerOptions {
  readonly store: Store
  readonly tenantId: string
  /** Sources to run. Every (source, account) pair is an independent stream. */
  readonly sources: readonly MovementSource[]
  readonly accounts: readonly string[]
  /** Maximum streams to run in parallel. Default 4. */
  readonly concurrency?: number
  /** Pages per stream per turn. Passed through to `sync()`. Default 10. */
  readonly maxBatches?: number
  /** Records per pull. Default 200. */
  readonly batchSize?: number
  /** Initial backoff after a stream error, in ms. Default 1 000. */
  readonly backoffBaseMs?: number
  /** Maximum backoff after repeated stream errors, in ms. Default 60 000. */
  readonly maxBackoffMs?: number
  /** Injected clock for deterministic tests. Default `Date.now`. */
  readonly now?: () => number
}

export interface StreamState {
  readonly source: string
  readonly network: string
  readonly account: string
  inserted: number
  duplicates: number
  conflicts: number
  cursor: string | null
  caughtUp: boolean
  contended: boolean
  error: Error | null
  /** Number of consecutive failures (including contention). */
  errorCount: number
  /** Earliest timestamp at which this stream should be scheduled again. */
  nextRunAt: number
}

export interface ScheduleReport {
  readonly streams: readonly StreamState[]
  readonly inserted: number
  readonly duplicates: number
  readonly conflicts: number
  readonly errors: readonly { readonly source: string; readonly account: string; readonly error: Error }[]
}

/**
 * Run one full scheduling round: every stream gets at least one turn until it
 * is caught up, contended, or still backing off. Workers run up to
 * `concurrency` streams in parallel; each turn is one `sync()` call (bounded
 * by `maxBatches`).
 */
export async function schedule(options: SchedulerOptions): Promise<ScheduleReport> {
  const concurrency = Math.max(1, options.concurrency ?? 4)
  const maxBatches = options.maxBatches ?? 10
  const batchSize = options.batchSize ?? 200
  const backoffBaseMs = options.backoffBaseMs ?? 1_000
  const maxBackoffMs = options.maxBackoffMs ?? 60_000
  const getNow = options.now ?? (() => Date.now())

  // Build initial state for every (source, account) pair.
  const states: StreamState[] = []
  for (const source of options.sources) {
    for (const account of options.accounts) {
      states.push({
        source: source.name,
        network: source.network,
        account,
        inserted: 0,
        duplicates: 0,
        conflicts: 0,
        cursor: null,
        caughtUp: false,
        contended: false,
        error: null,
        errorCount: 0,
        nextRunAt: 0,
      })
    }
  }

  // Map source name → MovementSource for fast lookup inside workers.
  const sourceMap = new Map<string, MovementSource>()
  for (const s of options.sources) sourceMap.set(s.name, s)

  /**
   * Pick the next stream that is eligible to run right now: not caught up,
   * not contended, past its backoff window, and not already running.
   * Prefer the stream whose `nextRunAt` is smallest (most overdue).
   */
  function pickNext(active: Set<string>, t: number): StreamState | undefined {
    let best: StreamState | undefined
    for (const s of states) {
      if (s.caughtUp || s.contended) continue
      if (s.nextRunAt > t) continue
      if (active.has(`${s.source}:${s.account}`)) continue
      if (best === undefined || s.nextRunAt < best.nextRunAt) best = s
    }
    return best
  }

  /** Apply the result of one `sync()` batch to the stream state. */
  function applyReport(state: StreamState, report: AccountSyncReport, t: number): void {
    state.inserted += report.inserted
    state.duplicates += report.duplicates
    state.conflicts += report.conflicts
    state.cursor = report.cursor
    state.caughtUp = report.caughtUp
    state.contended = report.contended

    if (report.error !== null || report.contended) {
      state.errorCount += 1
      const delay = Math.min(maxBackoffMs, backoffBaseMs * 2 ** (state.errorCount - 1))
      state.nextRunAt = t + delay
      state.error = report.error
    } else {
      state.errorCount = 0
      state.nextRunAt = 0
      state.error = null
    }
  }

  // Track in-flight work. Each entry is a promise that resolves when that
  // worker slot is free again (never rejects — errors are captured in state).
  let inFlight = 0
  // A single shared resolve handle that fires whenever a slot frees up.
  let onSlotFree: (() => void) | null = null
  const slotFree = (): Promise<void> =>
    new Promise((resolve) => {
      onSlotFree = resolve
    })

  // Keys of streams currently being worked on: "sourceName:account".
  const active = new Set<string>()

  async function runOne(state: StreamState): Promise<void> {
    const key = `${state.source}:${state.account}`
    active.add(key)
    inFlight += 1
    try {
      const source = sourceMap.get(state.source)!
      const syncOpts: SyncOptions = {
        store: options.store,
        source,
        tenantId: options.tenantId,
        accounts: [state.account],
        batchSize,
        maxBatches,
      }
      const report: SyncReport = await sync(syncOpts)
      applyReport(state, report.accounts[0]!, getNow())
    } catch (err) {
      // sync() itself should not throw (it catches per-account), but guard anyway.
      state.error = err instanceof Error ? err : new Error(String(err))
      state.errorCount += 1
      state.nextRunAt = getNow() + Math.min(maxBackoffMs, backoffBaseMs * 2 ** (state.errorCount - 1))
    } finally {
      active.delete(key)
      inFlight -= 1
      // Wake the main loop if it was waiting for a slot.
      const wake = onSlotFree
      onSlotFree = null
      wake?.()
    }
  }

  // Main scheduling loop.
  const promises: Promise<void>[] = []

  for (;;) {
    const t = getNow()
    const next = pickNext(active, t)

    if (next !== undefined) {
      const p = runOne(next)
      promises.push(p)

      if (inFlight >= concurrency) {
        // Wait for any one slot to free before trying to dispatch more.
        await slotFree()
      }
      continue
    }

    // Nothing eligible right now.
    if (inFlight === 0) break  // All done.

    // Some workers are still running; wait for a slot then re-evaluate.
    await slotFree()
  }

  // Drain any remaining in-flight work.
  await Promise.all(promises)

  return {
    streams: states,
    inserted: states.reduce((n, s) => n + s.inserted, 0),
    duplicates: states.reduce((n, s) => n + s.duplicates, 0),
    conflicts: states.reduce((n, s) => n + s.conflicts, 0),
    errors: states.flatMap((s) =>
      s.error !== null ? [{ source: s.source, account: s.account, error: s.error }] : [],
    ),
  }
}
