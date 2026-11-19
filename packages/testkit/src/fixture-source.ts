/**
 * Replay a captured Horizon fixture through the normaliser as a
 * `MovementSource`.
 *
 * A fixture is one operation with all of its effects, or a set of fee-paying
 * transactions. `FixtureSource` turns those records into the same
 * `NewMovement`s the live sources would, without a network or a database, so
 * a test can ingest a real record in a few lines. Page cursors and retry
 * behaviour are deliberately not replayed: that is what the live sources are
 * for.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type {
  HorizonEffect,
  HorizonOperation,
  HorizonTransaction,
  MovementSource,
  NewMovement,
  PullRequest,
  PullResult,
} from '@nostro-labs/nostro'
import { normalizeEffects, normalizeFee } from '@nostro-labs/nostro'

/** The JSON written by `scripts/record-fixture.mjs`. */
export interface HorizonFixture {
  readonly scenario: string
  readonly network: string
  readonly horizon: string
  readonly capturedAt: string
  readonly sources: readonly string[]
  readonly operation?: HorizonOperation
  readonly effects?: readonly HorizonEffect[]
  readonly transactions?: Readonly<Record<string, HorizonTransaction>>
}

export interface FixtureSourceOptions {
  /** A parsed fixture, or a path or file URL to the captured JSON. */
  readonly fixture: HorizonFixture | string | URL
  /** Override the network label. Default: the fixture's `network`. */
  readonly network?: string
  /** Override the effects source label. Default `horizon`. */
  readonly source?: string
  /** Override the fees source label. Default `horizon-fees`. */
  readonly feesSource?: string
}

function read(options: FixtureSourceOptions): HorizonFixture {
  const f = options.fixture
  if (typeof f === 'string' || f instanceof URL) {
    const path = f instanceof URL ? fileURLToPath(f) : f
    return JSON.parse(readFileSync(path, 'utf8')) as HorizonFixture
  }
  return f
}

export class FixtureSource implements MovementSource {
  readonly name: string
  readonly network: string
  private readonly feesName: string
  private readonly fixture: HorizonFixture
  private readonly operations: ReadonlyMap<string, HorizonOperation>
  private readonly cursor: string

  constructor(options: FixtureSourceOptions) {
    this.fixture = read(options)
    this.network = options.network ?? this.fixture.network
    this.name = options.source ?? 'horizon'
    this.feesName = options.feesSource ?? 'horizon-fees'
    const op = this.fixture.operation
    this.operations = new Map(op === undefined ? [] : [[op.id, op]])
    this.cursor = `fixture:${this.fixture.scenario}:${this.fixture.capturedAt}`
  }

  /** The movements the fixture holds for one account. */
  movementsFor(tenantId: string, account: string): NewMovement[] {
    const out: NewMovement[] = []
    if (this.fixture.effects !== undefined) {
      out.push(
        ...normalizeEffects(this.fixture.effects, this.operations, {
          tenantId,
          network: this.network,
          source: this.name,
          account,
        }),
      )
    }
    for (const tx of Object.values(this.fixture.transactions ?? {})) {
      if (tx.fee_account !== account) continue
      const fee = normalizeFee(tx, {
        tenantId,
        network: this.network,
        source: this.feesName,
        account,
      })
      if (fee !== null) out.push(fee)
    }
    return out
  }

  async pull({ tenantId, account, cursor }: PullRequest): Promise<PullResult> {
    // A second pull has nothing left: the cursor is the fixture's identity.
    if (cursor !== null) return { movements: [], cursor, caughtUp: true }
    return { movements: this.movementsFor(tenantId, account), cursor: this.cursor, caughtUp: true }
  }
}
