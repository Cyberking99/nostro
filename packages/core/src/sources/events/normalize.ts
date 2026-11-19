/**
 * CAP-67 / SEP-41 contract event → movement normaliser (#23).
 *
 * Pure functions, no I/O. Takes decoded contract events (independent of
 * transport — RPC, archive, or test fixture) and returns the credits and debits
 * of the watched address.
 *
 * Supported event kinds (CAP-67 §4):
 *   transfer   topics: ["transfer", from, to]            data: i128 | {amount, to_muxed_id}
 *   mint       topics: ["mint", admin, to]               data: i128 | {amount, to_muxed_id}
 *   burn       topics: ["burn", from]                    data: i128
 *   clawback   topics: ["clawback", admin, from]         data: i128
 *
 * SAC events also carry an asset topic; SEP-41 events do not.
 * Fee events (negative amounts for refunds) are decoded and returned as
 * movements — they are not left to HorizonFeesSource because contract
 * addresses have no Horizon fee feed.
 *
 * An event whose shape does not match a known kind throws `UnknownEventError`
 * rather than being silently skipped (invariant I1: nothing is dropped).
 *
 * References:
 *   CAP-67  https://github.com/stellar/stellar-protocol/blob/master/core/cap-0067.md
 *   SEP-41  https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0041.md
 */

import type { NewMovement } from '../../model/index.js'
import { Money } from '../../money/index.js'
import { contractAsset, parseAsset } from '../../money/asset.js'
import type { AssetId } from '../../money/asset.js'

// ─── Public error ─────────────────────────────────────────────────────────────

export class UnknownEventError extends Error {
  public readonly code = 'UNKNOWN_EVENT'
  constructor(
    public readonly event: RawContractEvent,
    message: string,
  ) {
    super(message)
    this.name = 'UnknownEventError'
  }
}

// ─── Input types ──────────────────────────────────────────────────────────────

/**
 * A decoded contract event as returned by `getEvents` (xdrFormat:"json") or a
 * test fixture. Topics are already decoded strings; amounts are BigInt (i128).
 *
 * `id` follows the RPC format `<ledger_sequence * 2^32 + tx_index>-<event_index>`,
 * e.g. `0024906085852815360-0000000016`. The first part is a TOID (confirmed on
 * testnet 2026-11-18); we use it as the externalId prefix.
 *
 * `toMuxedId`: CAP-67 may supply a u64 muxed-id for the destination. It is
 * represented as a bigint here (u64 or null). String / bytes forms from the
 * wire are the decoder's responsibility before this function is called.
 */
export interface RawContractEvent {
  /** RPC event id, e.g. `0024906085852815360-0000000016`. */
  id: string
  /** Contract that emitted the event. */
  contractId: string
  /** Decoded topic values, in order. First topic is the event kind string. */
  topics: string[]
  /** Decoded i128 amount (always positive; sign is determined by kind + direction). */
  amount: bigint
  /**
   * Optional muxed-id for the destination (CAP-67 to_muxed_id).
   * The decoder must resolve string / bytes forms to a u64 bigint or null.
   */
  toMuxedId?: bigint | null
  /** Ledger sequence number. */
  ledger: number
  /** Transaction hash (64 lower-hex chars), or null if unavailable. */
  txHash: string | null
  /** Timestamp of the ledger close. */
  occurredAt: Date
}

export interface NormalizeEventContext {
  readonly tenantId: string
  readonly network: string
  readonly source: string
  /** The watched address (G... or C...). */
  readonly account: string
  /**
   * The AssetId for this token contract.
   * Pass a `contract:C...` id for a pure SEP-41 token, or a `CODE:ISSUER` id
   * for a SAC so that the resulting movements use the classic asset identity.
   */
  readonly assetId: AssetId
  /** Token decimals, e.g. 7 for XLM-equivalent, 18 for many ERC-20 SACs. */
  readonly decimals: number
}

// ─── Normaliser ───────────────────────────────────────────────────────────────

/**
 * Normalise a slice of contract events for one watched address and one token.
 *
 * Call once per token contract per watched account. The caller is responsible
 * for filtering events to the right contract before passing them in.
 */
export function normalizeTokenEvents(
  events: readonly RawContractEvent[],
  ctx: NormalizeEventContext,
): NewMovement[] {
  const out: NewMovement[] = []

  for (const ev of events) {
    const kind = ev.topics[0]

    switch (kind) {
      case 'transfer': {
        // topics: ["transfer", from, to]  — optional 4th topic is SEP-11 asset string (SAC only)
        const from = ev.topics[1]
        const to = ev.topics[2]
        if (from === undefined || to === undefined) {
          throw new UnknownEventError(ev, `transfer event ${ev.id} missing from/to topics`)
        }
        if (from === ctx.account) {
          out.push(build(ev, ctx, 'debit', 'transfer', to))
        }
        if (to === ctx.account) {
          out.push(build(ev, ctx, 'credit', 'transfer', from))
        }
        break
      }

      case 'mint': {
        // topics: ["mint", admin, to]
        const to = ev.topics[2]
        if (to === undefined) {
          throw new UnknownEventError(ev, `mint event ${ev.id} missing to topic`)
        }
        if (to === ctx.account) {
          out.push(build(ev, ctx, 'credit', 'mint', ev.topics[1] ?? null))
        }
        break
      }

      case 'burn': {
        // topics: ["burn", from]
        const from = ev.topics[1]
        if (from === undefined) {
          throw new UnknownEventError(ev, `burn event ${ev.id} missing from topic`)
        }
        if (from === ctx.account) {
          out.push(build(ev, ctx, 'debit', 'burn', null))
        }
        break
      }

      case 'clawback': {
        // topics: ["clawback", admin, from]
        const from = ev.topics[2]
        if (from === undefined) {
          throw new UnknownEventError(ev, `clawback event ${ev.id} missing from topic`)
        }
        if (from === ctx.account) {
          out.push(build(ev, ctx, 'debit', 'clawback', ev.topics[1] ?? null))
        }
        break
      }

      default:
        throw new UnknownEventError(
          ev,
          `Unrecognised contract event kind ${JSON.stringify(kind)} in event ${ev.id}. ` +
            `Known kinds: transfer, mint, burn, clawback.`,
        )
    }
  }

  return out
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function build(
  ev: RawContractEvent,
  ctx: NormalizeEventContext,
  direction: 'credit' | 'debit',
  kind: NewMovement['kind'],
  counterparty: string | null,
): NewMovement {
  return {
    tenantId: ctx.tenantId,
    network: ctx.network,
    source: ctx.source,
    externalId: `${ev.id}:${direction}`,
    account: ctx.account,
    direction,
    kind,
    amount: Money.fromRaw(ev.amount < 0n ? -ev.amount : ev.amount, ctx.assetId, ctx.decimals),
    counterparty: counterparty ?? null,
    muxedId: direction === 'credit' && ev.toMuxedId != null ? ev.toMuxedId : null,
    memo: null,
    ledger: ev.ledger,
    txHash: ev.txHash,
    operationId: null,
    occurredAt: ev.occurredAt,
    enrichment: 'complete',
  }
}
