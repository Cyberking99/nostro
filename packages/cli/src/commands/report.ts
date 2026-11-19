/**
 * `nostro report <kind> [options]`
 *
 * Supported sub-commands (issues #56 and #57):
 *   trial-balance   Per-account, per-asset totals and net balances
 *   ledger          Account ledger with opening balance and running total
 *   balance-sheet   Assets, liabilities, equity and current earnings
 *   income          Income and expense accounts for a period
 */
import {
  accountLedger,
  balanceSheet,
  incomeStatement,
  trialBalance,
} from '@nostro-labs/nostro'
import { COMMON, UsageError, date, flag, positionals, string, tenant } from '../args.js'
import type { Command } from '../command.js'
import { COMMON_HELP, withStore } from '../command.js'
import { json, table, write } from '../io.js'

/** Format a bigint amount into a human-readable decimal string. */
function fmt(raw: bigint, decimals: number): string {
  const neg = raw < 0n
  const abs = neg ? -raw : raw
  if (decimals === 0) return `${neg ? '-' : ''}${abs}`
  const str = abs.toString().padStart(decimals + 1, '0')
  const whole = str.slice(0, str.length - decimals) || '0'
  const frac = str.slice(str.length - decimals)
  return `${neg ? '-' : ''}${whole}.${frac}`
}

function shortAsset(asset: string): string {
  if (asset === 'native') return 'XLM'
  const colon = asset.indexOf(':')
  return colon === -1 ? asset : asset.slice(0, colon)
}

export const report: Command = {
  name: 'report',
  summary: 'Trial balance, account ledger, balance sheet and income statement',
  usage: '<trial-balance|ledger|balance-sheet|income> [options]',
  help: `Run accounting reports.

Subcommands:
  trial-balance        Per-account, per-asset totals and net balances as of --as-of
  ledger               Account ledger with running balance; requires --account and --asset
  balance-sheet        Assets, liabilities, equity + current earnings as of --as-of
  income               Income and expense accounts for a period

Options:
  --as-of <date>       Balance as of this instant (trial-balance, balance-sheet)
  --account <code>     Account code for the ledger (ledger only)
  --asset <id>         Asset id, e.g. "native" or "USDC:GA5Z..." (ledger only)
  --from <date>        Period start, inclusive (ledger, income)
  --to <date>          Period end, exclusive (ledger, income)
${COMMON_HELP}`,
  options: {
    ...COMMON,
    'as-of': { type: 'string' },
    account: { type: 'string' },
    asset: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
  },
  async run(args, io) {
    const [sub] = positionals(args, 1)
    const tenantId = tenant(args, io)
    const isJson = flag(args, 'json')

    if (sub === 'trial-balance') {
      const asOf = date(args, 'as-of')
      return withStore(args, io, async (store) => {
        const report = await trialBalance({ store, tenantId, ...(asOf !== undefined ? { asOf } : {}) })
        if (isJson) {
          await write(io.stdout, json({
            balanced: report.balanced,
            assetTotals: report.assetTotals.map(t => ({ asset: t.asset, net: t.net.toString() })),
            lines: report.lines.map(l => ({
              account: l.account,
              asset: l.asset,
              totalDebits: l.totalDebits.toString(),
              totalCredits: l.totalCredits.toString(),
              netBalance: l.netBalance.toString(),
            })),
          }))
        } else {
          const rows: string[][] = [['Account', 'Asset', 'Debits', 'Credits', 'Net']]
          for (const l of report.lines) {
            rows.push([
              l.account,
              shortAsset(l.asset),
              fmt(l.totalDebits, l.decimals),
              fmt(l.totalCredits, l.decimals),
              fmt(l.netBalance, l.decimals),
            ])
          }
          await write(io.stdout, table(rows))
          await write(io.stdout, `\nBalanced: ${report.balanced ? 'yes' : 'NO — entries do not balance'}\n`)
        }
        return report.balanced ? 0 : 1
      })
    }

    if (sub === 'ledger') {
      const account = string(args, 'account')
      const assetId = string(args, 'asset')
      if (account === undefined) throw new UsageError('ledger requires --account <code>.')
      if (assetId === undefined) throw new UsageError('ledger requires --asset <id>.')
      const from = date(args, 'from')
      const to = date(args, 'to')
      return withStore(args, io, async (store) => {
        const ledger = await accountLedger({ store, tenantId, account, asset: assetId, from, to })
        if (isJson) {
          await write(io.stdout, json({
            account: ledger.account,
            asset: ledger.asset,
            openingBalance: ledger.openingBalance.toString(),
            closingBalance: ledger.closingBalance.toString(),
            lines: ledger.lines.map(l => ({
              entryId: l.entryId,
              seq: l.seq,
              kind: l.kind,
              effectiveAt: l.effectiveAt.toISOString(),
              description: l.description,
              side: l.side,
              amount: l.amount.toString(),
              movementId: l.movementId,
              runningBalance: l.runningBalance.toString(),
            })),
          }))
        } else {
          const { decimals } = ledger.lines[0]?.amount ?? { decimals: 7 }
          await write(io.stdout, `Account: ${account}  Asset: ${shortAsset(assetId)}\n`)
          await write(io.stdout, `Opening balance: ${fmt(ledger.openingBalance, decimals)}\n\n`)
          const rows: string[][] = [['Date', 'Entry', 'Description', 'Dr', 'Cr', 'Balance']]
          for (const l of ledger.lines) {
            rows.push([
              l.effectiveAt.toISOString().slice(0, 10),
              l.entryId.slice(0, 8),
              l.description.slice(0, 40),
              l.side === 'debit' ? fmt(l.amount.raw, l.amount.decimals) : '',
              l.side === 'credit' ? fmt(l.amount.raw, l.amount.decimals) : '',
              fmt(l.runningBalance, l.amount.decimals),
            ])
          }
          await write(io.stdout, table(rows))
          await write(io.stdout, `\nClosing balance: ${fmt(ledger.closingBalance, decimals)}\n`)
        }
        return 0
      })
    }

    if (sub === 'balance-sheet') {
      const asOf = date(args, 'as-of')
      return withStore(args, io, async (store) => {
        const bs = await balanceSheet({ store, tenantId, ...(asOf !== undefined ? { asOf } : {}) })
        if (isJson) {
          await write(io.stdout, json({
            asOf: bs.asOf?.toISOString() ?? null,
            balanced: bs.balanced,
            currentEarnings: bs.currentEarnings.map(e => ({ asset: e.asset, amount: e.amount.toString() })),
            sections: bs.sections.map(s => ({
              kind: s.kind,
              accounts: s.accounts.map(a => ({ account: a.account, asset: a.asset, balance: a.balance.toString() })),
            })),
          }))
        } else {
          for (const section of bs.sections) {
            if (section.accounts.length === 0) continue
            await write(io.stdout, `\n=== ${section.kind.toUpperCase()} ===\n`)
            const rows = section.accounts.map(a => [a.account, shortAsset(a.asset), fmt(a.balance, a.decimals)])
            await write(io.stdout, table(rows))
          }
          if (bs.currentEarnings.length > 0) {
            await write(io.stdout, `\n=== CURRENT EARNINGS ===\n`)
            const rows = bs.currentEarnings.map(e => ['(net income)', shortAsset(e.asset), fmt(e.amount, e.decimals)])
            await write(io.stdout, table(rows))
          }
          await write(io.stdout, `\nBalanced: ${bs.balanced ? 'yes' : 'NO'}\n`)
        }
        return bs.balanced ? 0 : 1
      })
    }

    if (sub === 'income') {
      const from = date(args, 'from')
      const to = date(args, 'to')
      return withStore(args, io, async (store) => {
        const stmt = await incomeStatement({ store, tenantId, from, to })
        if (isJson) {
          await write(io.stdout, json({
            from: stmt.from?.toISOString() ?? null,
            to: stmt.to?.toISOString() ?? null,
            netResult: stmt.netResult.map(r => ({ asset: r.asset, amount: r.amount.toString() })),
            lines: stmt.lines.map(l => ({
              account: l.account,
              kind: l.kind,
              asset: l.asset,
              amount: l.amount.toString(),
            })),
          }))
        } else {
          await write(io.stdout, `\n=== INCOME ===\n`)
          const income = stmt.lines.filter(l => l.kind === 'income')
          if (income.length > 0) await write(io.stdout, table(income.map(l => [l.account, shortAsset(l.asset), fmt(l.amount, l.decimals)])))
          await write(io.stdout, `\n=== EXPENSES ===\n`)
          const expenses = stmt.lines.filter(l => l.kind === 'expense')
          if (expenses.length > 0) await write(io.stdout, table(expenses.map(l => [l.account, shortAsset(l.asset), fmt(l.amount, l.decimals)])))
          await write(io.stdout, `\n=== NET RESULT ===\n`)
          if (stmt.netResult.length > 0) await write(io.stdout, table(stmt.netResult.map(r => [shortAsset(r.asset), fmt(r.amount, r.decimals)])))
        }
        return 0
      })
    }

    throw new UsageError(`Unknown report type ${JSON.stringify(sub)}. Use trial-balance, ledger, balance-sheet or income.`)
  },
}
