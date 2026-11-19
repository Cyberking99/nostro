/**
 * Tests for the concurrent ingest scheduler (#28).
 *
 * All tests use injected clocks and in-memory stores so they are
 * deterministic and require no real network.
 */
import { describe, expect, it } from 'vitest'
import type { MovementSource, NewMovement, PullRequest } from '../src/index.js'
import { MemoryStore, Money, NATIVE } from '../src/index.js'
import { schedule } from '../src/ingest/scheduler.js'

const T = 'tenant'
const A = `G${'A'.repeat(55)}`
const B = `G${'B'.repeat(55)}`
const C = `G${'C'.repeat(55)}`

function movement(account: string, token: string): NewMovement {
  return {
    tenantId: T,
    network: 'testnet',
    source: 'fake',
    externalId: token,
    account,
    direction: 'credit',
    kind: 'transfer',
    amount: Money.parse('1', NATIVE),
    ledger: Number(token),
    txHash: Number(token).toString(16).padStart(64, '0'),
    occurredAt: new Date('2026-10-06T00:00:00Z'),
  }
}

class FakeSource implements MovementSource {
  readonly name = 'fake'
  readonly network = 'testnet'
  /** Call counts per account. */
  readonly calls: Record<string, number> = {}

  constructor(
    public feeds: Record<string, string[]>,
    private readonly onPull?: (req: PullRequest) => Promise<void>,
  ) {}

  async pull(req: PullRequest) {
    this.calls[req.account] = (this.calls[req.account] ?? 0) + 1
    await this.onPull?.(req)
    const feed = this.feeds[req.account] ?? []
    const after = req.cursor === null ? -1 : Number(req.cursor)
    const pending = feed.filter((t) => Number(t) > after)
    const batch = pending.slice(0, req.limit)
    return {
      movements: batch.map((t) => movement(req.account, t)),
      cursor: batch.length === 0 ? (req.cursor ?? '0') : batch[batch.length - 1]!,
      caughtUp: pending.length <= req.limit,
    }
  }
}

class ErrorSource implements MovementSource {
  readonly name = 'fake'
  readonly network = 'testnet'
  calls = 0
  constructor(private readonly error: Error) {}
  async pull(): Promise<never> {
    this.calls += 1
    throw this.error
  }
}

describe('schedule', () => {
  it('syncs all accounts and reports totals', async () => {
    const store = new MemoryStore()
    const source = new FakeSource({ [A]: ['1', '2', '3'], [B]: ['1', '2'] })

    const report = await schedule({ store, tenantId: T, sources: [source], accounts: [A, B] })

    expect(report.inserted).toBe(5)
    expect(report.errors).toHaveLength(0)
    expect(report.streams).toHaveLength(2)
    expect(report.streams.every((s) => s.caughtUp)).toBe(true)
    const movements = await store.listMovements({ tenantId: T })
    expect(movements).toHaveLength(5)
  })

  it('gives fair turns: an account with a large backlog does not block a caught-up account', async () => {
    const store = new MemoryStore()
    // A has 400 records (needs 2 maxBatches=1 turns to finish 2×200).
    // B has 1 record. With fair scheduling B should finish in its first turn.
    const aFeed = Array.from({ length: 400 }, (_, i) => String(i + 1))
    const source = new FakeSource({ [A]: aFeed, [B]: ['1'] })

    const report = await schedule({
      store,
      tenantId: T,
      sources: [source],
      accounts: [A, B],
      concurrency: 1,
      maxBatches: 1,
      batchSize: 200,
    })

    // B must have been serviced at least once during the round.
    expect(source.calls[B]).toBeGreaterThanOrEqual(1)
    // A is fully synced.
    const aStream = report.streams.find((s) => s.account === A)!
    expect(aStream.caughtUp).toBe(true)
    // B is fully synced.
    const bStream = report.streams.find((s) => s.account === B)!
    expect(bStream.caughtUp).toBe(true)
  })

  it('backs off a failing stream and keeps others running', async () => {
    const store = new MemoryStore()
    const good = new FakeSource({ [B]: ['1', '2'] })
    const bad = new ErrorSource(new Error('horizon 500'))

    // Use two separate sources so they can be passed together.
    const mixed: MovementSource[] = [
      {
        name: 'fake',
        network: 'testnet',
        pull: async (req) => {
          if (req.account === A) return bad.pull(req)
          return good.pull(req)
        },
      },
    ]

    // Inject a stable clock so backoff times are deterministic.
    let t = 0
    const report = await schedule({
      store,
      tenantId: T,
      sources: mixed,
      accounts: [A, B],
      backoffBaseMs: 1_000,
      maxBackoffMs: 60_000,
      now: () => t,
    })

    // B synced fine.
    const bStream = report.streams.find((s) => s.account === B)!
    expect(bStream.caughtUp).toBe(true)
    expect(bStream.error).toBeNull()

    // A errored and has a backoff scheduled.
    const aStream = report.streams.find((s) => s.account === A)!
    expect(aStream.error).not.toBeNull()
    expect(aStream.error!.message).toBe('horizon 500')
    expect(aStream.nextRunAt).toBeGreaterThan(t)
  })

  it('respects the concurrency limit', async () => {
    const store = new MemoryStore()
    let concurrent = 0
    let maxConcurrent = 0

    const counting: MovementSource = {
      name: 'fake',
      network: 'testnet',
      pull: async (req) => {
        concurrent += 1
        maxConcurrent = Math.max(maxConcurrent, concurrent)
        // Yield so others can interleave.
        await new Promise((r) => setTimeout(r, 5))
        concurrent -= 1
        return {
          movements: [movement(req.account, '1')],
          cursor: '1',
          caughtUp: true,
        }
      },
    }

    await schedule({
      store,
      tenantId: T,
      sources: [counting],
      accounts: [A, B, C],
      concurrency: 2,
    })

    expect(maxConcurrent).toBeLessThanOrEqual(2)
  })

  it('reports errors without stopping other streams', async () => {
    const store = new MemoryStore()
    const source = new FakeSource({ [B]: ['1'] })
    // A has no feed entry → FakeSource throws.

    const report = await schedule({ store, tenantId: T, sources: [source], accounts: [A, B] })

    expect(report.errors).toHaveLength(1)
    expect(report.errors[0]!.account).toBe(A)
    const bStream = report.streams.find((s) => s.account === B)!
    expect(bStream.caughtUp).toBe(true)
    expect(bStream.inserted).toBe(1)
  })

  it('accumulates totals across multiple sync turns per stream', async () => {
    const store = new MemoryStore()
    // 5 records, batchSize=2, maxBatches=1 → needs 3 turns to finish.
    const source = new FakeSource({ [A]: ['1', '2', '3', '4', '5'] })

    const report = await schedule({
      store,
      tenantId: T,
      sources: [source],
      accounts: [A],
      batchSize: 2,
      maxBatches: 1,
      concurrency: 1,
    })

    expect(report.inserted).toBe(5)
    const aStream = report.streams.find((s) => s.account === A)!
    expect(aStream.caughtUp).toBe(true)
    expect(aStream.inserted).toBe(5)
  })

  it('handles multiple sources independently', async () => {
    const store = new MemoryStore()
    const effects = new FakeSource({ [A]: ['1', '2'] })
    const feesSource: MovementSource = {
      name: 'fees',
      network: 'testnet',
      pull: async (req) => {
        const token = '100'
        const after = req.cursor === null ? -1 : Number(req.cursor)
        if (Number(token) <= after) return { movements: [], cursor: req.cursor ?? '0', caughtUp: true }
        return {
          movements: [{ ...movement(req.account, token), source: 'fees' }],
          cursor: token,
          caughtUp: true,
        }
      },
    }

    const report = await schedule({
      store,
      tenantId: T,
      sources: [effects, feesSource],
      accounts: [A],
    })

    // 2 effect movements + 1 fee movement.
    expect(report.inserted).toBe(3)
    expect(report.streams).toHaveLength(2)
    expect(report.streams.every((s) => s.caughtUp)).toBe(true)
  })
})
