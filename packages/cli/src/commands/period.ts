import { closePeriod, reopenPeriod } from '@nostro-labs/nostro'
import { COMMON, UsageError, date, flag, positionals, string, tenant } from '../args.js'
import type { Command } from '../command.js'
import { COMMON_HELP, withStore } from '../command.js'
import { json, write } from '../io.js'

export const period: Command = {
  name: 'period',
  summary: 'Close or reopen a tenant accounting period',
  usage: '<close|reopen> [options]',
  help: `Closes journal effective dates through an inclusive UTC date or instant. A date-only
--through value closes the full UTC day. Reopening requires a reason.

Usage:
  nostro period close --through <date> [--note <text>] [options]
  nostro period reopen --reason <text> [options]

Options:
  --through <date>    Inclusive close-through date or instant (close only)
  --note <text>       Optional close note
  --reason <text>     Required explanation for reopening
${COMMON_HELP}`,
  options: {
    ...COMMON,
    through: { type: 'string' },
    note: { type: 'string' },
    reason: { type: 'string' },
  },
  async run(args, io) {
    const [action] = positionals(args, 1)
    if (action !== 'close' && action !== 'reopen') {
      throw new UsageError('Use "nostro period close" or "nostro period reopen".')
    }
    const tenantId = tenant(args, io)
    const throughArg = string(args, 'through')
    const note = string(args, 'note')
    const reason = string(args, 'reason')
    if (action === 'close') {
      if (throughArg === undefined) throw new UsageError('period close requires --through <date>.')
      if (reason !== undefined) throw new UsageError('--reason only applies to period reopen.')
      const through = date(args, 'through')
      if (through === undefined) throw new UsageError('period close requires --through <date>.')
      if (/^\d{4}-\d{2}-\d{2}$/.test(throughArg)) through.setUTCHours(23, 59, 59, 999)
      await withStore(args, io, async (store) => closePeriod({ store, tenantId, through, ...(note === undefined ? {} : { note }) }))
      await write(
        io.stdout,
        flag(args, 'json')
          ? json({ action: 'closed', tenantId, through: through.toISOString(), note: note ?? null })
          : `Closed ${tenantId} through ${through.toISOString()}.\n`,
      )
      return 0
    }
    if (throughArg !== undefined || note !== undefined) {
      throw new UsageError('--through and --note only apply to period close.')
    }
    if (reason === undefined) throw new UsageError('period reopen requires --reason <text>.')
    await withStore(args, io, async (store) => reopenPeriod({ store, tenantId, reason }))
    await write(
      io.stdout,
      flag(args, 'json')
        ? json({ action: 'reopened', tenantId, reason })
        : `Reopened ${tenantId}: ${reason}\n`,
    )
    return 0
  },
}
