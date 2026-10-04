/**
 * How the context meter writes its numbers: the count of tokens, and the reading
 * as one line.
 *
 * Deliberately coarse. A count that moves in its last three digits several times
 * a second is a line that flickers while the reader is trying to read the one
 * number that matters, so thousands past a thousand and millions past a million,
 * one decimal only where it changes the reading (`1.2M` says something `1M` does
 * not; `164.2k` and `164k` do not differ in any way that matters at a glance).
 * The same rule the Apple apps' meter follows.
 */
import type { ContextUsage } from '@hermie/transcript'

import { strings } from '../../generated/strings'
import { formatNumber } from '../../i18n/format'

/** Where the meter stops being informational and starts being a warning. */
export const CONTEXT_WARN_AT = 0.75
export const CONTEXT_DANGER_AT = 0.9

/** `164k`, `1.2M`, `850`. */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) {
    return formatNumber(Math.round(tokens))
  }

  if (tokens < 1_000_000) {
    return `${formatNumber(Math.round(tokens / 1000))}k`
  }

  const millions = tokens / 1_000_000

  return `${formatNumber(millions < 10 ? Math.round(millions * 10) / 10 : Math.round(millions))}M`
}

/** `164k / 200k`, the line under the percentage. */
export function contextCounts(usage: ContextUsage): string {
  return strings.chat.context.counts({ used: formatTokens(usage.used), limit: formatTokens(usage.limit) })
}

/** `82% · 164k / 200k`, with the gateway's own caveat when it flagged the count as approximate. */
export function contextSummary(usage: ContextUsage): string {
  const base = `${strings.chat.context.percent({ percent: usage.percent })} · ${contextCounts(usage)}`

  return usage.estimated ? `${base} ${strings.chat.context.estimated}` : base
}
