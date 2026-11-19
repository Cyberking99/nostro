/**
 * `nostro chart <sub-command> [options]`
 *
 * Supported sub-commands:
 *   move   Migrate all balances from one account code to another (issue #55)
 */
import { moveAccount } from '@nostro-labs/nostro'
import { COMMON, UsageError, date, flag, positionals, string, tenant } from '../args.js'
import type { Command } from '../command.js'
import { COMMON_HELP, withStore } from '../command.js'
import { write } from '../io.js'

export const chart: Command = {
  name: 'chart',
  summary: 'Manage the chart of accounts',
  usage: '<move> [options]',
  help: `Manage account codes in the chart of accounts.

Subcommands:
  move   Move all balances from one account code to another in one auditable entry.
         Cash accounts (assets:stellar:*) are refused.

Options:
  --from <code>        Source account code
  --to <code>          Destination account code
  --note <text>        Entry description (optional)
  --effective-at <date> Date the entry is posted (default: now)
${COMMON_HELP}`,
  options: {
    ...COMMON,
    from: { type: 'string' },
    to: { type: 'string' },
    note: { type: 'string' },
    'effective-at': { type: 'string' },
  },
  async run(args, io) {
    const [sub] = positionals(args, 1)
    const tenantId = tenant(args, io)
    const isJson = flag(args, 'json')

    if (sub !== 'move') {
      throw new UsageError(`Unknown chart subcommand ${JSON.stringify(sub)}. Use "move".`)
    }

    const from = string(args, 'from')
    const to = string(args, 'to')
    if (from === undefined) throw new UsageError('chart move requires --from <code>.')
    if (to === undefined) throw new UsageError('chart move requires --to <code>.')

    const note = string(args, 'note')
    const effectiveAt = date(args, 'effective-at')

    return withStore(args, io, async (store) => {
      const result = await moveAccount({
        store,
        tenantId,
        from,
        to,
        ...(note !== undefined ? { note } : {}),
        ...(effectiveAt !== undefined ? { effectiveAt } : {}),
      })

      if (isJson) {
        await write(io.stdout, `${JSON.stringify({ moved: result.moved, assets: result.assets }, null, 2)}\n`)
      } else if (result.moved === 0) {
        await write(io.stdout, `Nothing to move: ${from} has a zero balance in every asset.\n`)
      } else {
        await write(io.stdout, `Moved ${result.moved} balance(s) from "${from}" to "${to}" (assets: ${result.assets.join(', ')}).\n`)
      }
      return 0
    })
  },
}
