/**
 * What the gateway reports about use, in the shapes the real one answers with.
 *
 * Four calls say something about it and none says the whole thing, which is why the app reads all four:
 *
 *  - `GET /api/analytics/usage?days=<n>&profile=<name>` (`hermes_cli/web_routers/analytics.py`) groups
 *    ONE profile's sessions by the UTC day each STARTED on and sums their tokens and cost. It is the only
 *    source of "per bot, per day". `days` is a FastAPI `Query(30, ge=1, le=365)`, so a value outside
 *    1…365 is a 422 and not a clamp, and an unknown profile is a 404 as for the session search.
 *  - `insights.get {days, profile}` answers `{days, sessions, messages}` and nothing else.
 *  - `usage.bars` is the Nous account's plan and top-up balance as display strings and fractions
 *    (`billing_view._serialize_usage_model`); `{ok: true, available: false}` for any other account.
 *  - `session.usage` (the existing handler) gains `account_lines` and `credits_lines`: the provider
 *    account's limits as TEXT, which is all the gateway has of Anthropic's subscription windows or Codex's
 *    quota (`methods_session._account_usage_lines`).
 *
 * The numbers are derived from the profile's name and the date, so the same call answers the same on every
 * run and a test can assert on them; `POST /__fake/usage` replaces a profile's days outright when a test
 * wants exact ones (a day over a limit, a day with no use).
 */

/** One row of the analytics route's `daily` list. */
export interface UsageDay {
  day: string
  input_tokens: number | null
  output_tokens: number | null
  cache_read_tokens: number | null
  reasoning_tokens: number | null
  estimated_cost: number
  actual_cost: number
  sessions: number
  api_calls: number | null
}

/** What a test staged through `POST /__fake/usage`. */
export interface UsageStage {
  /** A profile's days, by profile name, replacing the derived ones. */
  days: Map<string, UsageDay[]>
  /** The Nous balance `usage.bars` answers with; absent is "not a Nous account". */
  bars: Record<string, unknown> | null
  /** `session.usage`'s `account_lines`. */
  accountLines: string[]
  /** `session.usage`'s `credits_lines`. */
  creditsLines: string[]
  /** The gateway has none of these routes and methods (an older one): 404 and `-32601`. */
  unsupported: boolean
}

export const emptyUsageStage = (): UsageStage => ({
  accountLines: [],
  bars: null,
  creditsLines: [],
  days: new Map(),
  unsupported: false
})

/** `yyyy-MM-dd` for the UTC day `epochSeconds` is in: the day the gateway groups sessions by. */
export const utcDay = (epochSeconds: number): string => new Date(epochSeconds * 1000).toISOString().slice(0, 10)

const hashOf = (text: string): number => {
  let hash = 7

  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) % 1_000_003
  }

  return hash
}

const round = (value: number, places: number): number => {
  const factor = 10 ** places

  return Math.round(value * factor) / factor
}

/**
 * The days a profile has by default: the last seven, today included, each with a few thousand tokens and
 * a few cents, shaped by the profile's name. A cost here is the gateway's estimate (`actual_cost` is 0),
 * as it is for almost every provider.
 */
export const defaultUsageDays = (profile: string, nowSeconds: number): UsageDay[] => {
  const seed = hashOf(profile)
  const days: UsageDay[] = []

  for (let back = 6; back >= 0; back -= 1) {
    const roll = (seed + back * 17) % 7
    const input = 1_000 * (1 + roll) + 120 * back
    const output = 400 * (1 + (roll % 5)) + 40 * back

    days.push({
      actual_cost: 0,
      api_calls: 2 + roll,
      cache_read_tokens: input * 3,
      day: utcDay(nowSeconds - back * 86_400),
      estimated_cost: round(input * 0.000003 + output * 0.000015, 4),
      input_tokens: input,
      output_tokens: output,
      reasoning_tokens: 0,
      sessions: 1 + (roll % 3)
    })
  }

  return days
}

/** The days of one profile inside the last `days` days, oldest first. */
export const usageDaysOf = (stage: UsageStage, profile: string, days: number, nowSeconds: number): UsageDay[] => {
  const all = stage.days.get(profile) ?? defaultUsageDays(profile, nowSeconds)
  // `started_at > now - days * 86400`: a session that started exactly that long ago is out. By day that
  // is every day after the one the cutoff falls in, and the cutoff's own day only for its later sessions,
  // which the fake counts as in.
  const cutoff = utcDay(nowSeconds - days * 86_400)

  return all.filter(row => row.day >= cutoff).sort((left, right) => left.day.localeCompare(right.day))
}

const sum = (rows: UsageDay[], pick: (row: UsageDay) => number | null): number =>
  rows.reduce((total, row) => total + (pick(row) ?? 0), 0)

/** The route's whole answer: the days, the totals, and the lists a client of this app does not read. */
export const usageAnalytics = (rows: UsageDay[], days: number): Record<string, unknown> => ({
  by_model: [],
  by_task: [],
  daily: rows,
  period_days: days,
  skills: [],
  tools: [],
  totals: {
    total_actual_cost: round(
      sum(rows, row => row.actual_cost),
      4
    ),
    total_api_calls: sum(rows, row => row.api_calls),
    total_cache_read: sum(rows, row => row.cache_read_tokens),
    total_estimated_cost: round(
      sum(rows, row => row.estimated_cost),
      4
    ),
    total_input: sum(rows, row => row.input_tokens),
    total_output: sum(rows, row => row.output_tokens),
    total_reasoning: sum(rows, row => row.reasoning_tokens),
    total_sessions: sum(rows, row => row.sessions)
  }
})

/** FastAPI's refusal of `days` outside `ge=1, le=365`: 422 with a list under `detail`. */
export const daysRefusal = (raw: string | null): Record<string, unknown> | null => {
  if (raw === null) {
    return null
  }

  const days = Number(raw)

  if (Number.isInteger(days) && days >= 1 && days <= 365) {
    return null
  }

  return {
    detail: [
      {
        input: raw,
        loc: ['query', 'days'],
        msg: Number.isInteger(days) ? 'Input should be between 1 and 365' : 'Input should be a valid integer',
        type: Number.isInteger(days) ? 'less_than_equal' : 'int_parsing'
      }
    ]
  }
}

/**
 * `usage.bars` for a Nous account, in `billing_view._serialize_usage_model`'s shape: every dollar figure a
 * display string, the plan bar a share used and the top-up bar a full bar with no denominator.
 */
export const nousBars = (): Record<string, unknown> => ({
  available: true,
  has_topup: true,
  ok: true,
  plan_bar: {
    fill_fraction: 0.6,
    kind: 'plan',
    pct_used: 40,
    remaining_display: '$12.00',
    spent_display: '$8.00',
    total_display: '$20.00'
  },
  plan_name: 'Pro',
  renews_at: '2026-10-24T00:00:00Z',
  renews_display: 'Oct 24, 2026',
  status: 'healthy',
  subscription_remaining_display: '$12.00',
  topup_bar: {
    fill_fraction: 1,
    kind: 'topup',
    pct_used: null,
    remaining_display: '$3.00',
    spent_display: '$0.00',
    total_display: '$3.00'
  },
  topup_remaining_display: '$3.00',
  total_spendable_display: '$15.00'
})

/**
 * The account's limits as the CLI renders them (`render_account_usage_lines`): a title, the provider and
 * plan, then a line per window with the share left and when it resets. Plain text with an emoji in front of
 * the title, which is the gateway's own wording.
 */
export const anthropicAccountLines = (): string[] => [
  '📈 Account limits',
  'Provider: anthropic (Max)',
  'Current session: 82% remaining (18% used) • resets in 2h 10m',
  'Current week: 64% remaining (36% used) • resets in 3d 4h'
]

/** `insights.get`'s whole answer. */
export const insights = (days: number, sessions: number, messages: number): Record<string, unknown> => ({
  days,
  messages,
  sessions
})
