/**
 * The usage calls, pinned against `analytics.py::get_usage_analytics`, `methods_tools.py::insights.get`,
 * `billing_view._serialize_usage_model` and `methods_session.py::session.usage`.
 *
 * What the app is built on is again mostly a list of what each call does NOT say: the analytics route is the
 * only one with tokens and cost per day and it counts by the day a session STARTED; `insights.get` counts
 * sessions and messages and nothing else; `usage.bars` is the Nous balance only; and the provider account
 * limits other than Nous are TEXT lines inside `session.usage`, which is why the app shows them as text.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'

import { type FakeGateway, startFakeGateway } from './server'
import { utcDay } from './usage'

let gateway: FakeGateway
let socket: WebSocket
let nextId = 0

type Call = (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>

const call: Call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = `usage-${(nextId += 1)}`
    const onMessage = (data: unknown) => {
      for (const line of String(data).split('\n')) {
        if (!line.trim()) {
          continue
        }

        const frame = JSON.parse(line) as {
          id?: string
          result?: Record<string, unknown>
          error?: { code?: number; message?: string }
        }

        if (frame.id !== id) {
          continue
        }

        socket.off('message', onMessage)

        if (frame.error) {
          reject(Object.assign(new Error(frame.error.message ?? 'rpc error'), { code: frame.error.code }))

          return
        }

        resolve(frame.result ?? {})
      }
    }

    socket.on('message', onMessage)
    socket.send(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })

const analytics = async (query: string): Promise<{ status: number; body: Record<string, unknown> }> => {
  const response = await fetch(`${gateway.url}/api/analytics/usage?${query}`)

  return { body: (await response.json()) as Record<string, unknown>, status: response.status }
}

const stage = async (body: Record<string, unknown>): Promise<void> => {
  await fetch(`${gateway.url}/__fake/usage`, {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method: 'POST'
  })
}

beforeAll(async () => {
  gateway = await startFakeGateway({ port: 0 })
  socket = new WebSocket(gateway.wsUrl, ['hermes-gateway-v1'])

  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve())
    socket.once('error', reject)
  })
})

afterAll(async () => {
  socket.close()
  await gateway.close()
})

beforeEach(async () => {
  await stage({ clear: true })
})

describe('GET /api/analytics/usage', () => {
  it('answers one profile’s days, oldest first, the way the route groups them', async () => {
    const { body, status } = await analytics('days=30&profile=researcher')
    const daily = body.daily as Record<string, unknown>[]

    expect(status).toBe(200)
    expect(Object.keys(body).sort()).toEqual(
      ['by_model', 'by_task', 'daily', 'period_days', 'skills', 'tools', 'totals'].sort()
    )
    expect(body.period_days).toBe(30)
    expect(daily.length).toBeGreaterThan(1)
    expect(daily.map(row => row.day)).toEqual([...daily.map(row => row.day as string)].sort())
    expect(daily.at(-1)?.day).toBe(utcDay(Date.now() / 1000))

    // The columns of the route's SELECT, under their own names.
    expect(Object.keys(daily[0] ?? {}).sort()).toEqual(
      [
        'actual_cost',
        'api_calls',
        'cache_read_tokens',
        'day',
        'estimated_cost',
        'input_tokens',
        'output_tokens',
        'reasoning_tokens',
        'sessions'
      ].sort()
    )
  })

  it('is per profile, and the same call answers the same on every run', async () => {
    const first = (await analytics('days=30&profile=researcher')).body
    const again = (await analytics('days=30&profile=researcher')).body
    const other = (await analytics('days=30&profile=writer')).body

    expect(again).toEqual(first)
    expect(other.daily).not.toEqual(first.daily)
  })

  it('totals what its days add up to', async () => {
    const { body } = await analytics('days=30&profile=researcher')
    const daily = body.daily as { input_tokens: number; output_tokens: number; sessions: number }[]
    const totals = body.totals as Record<string, number>

    expect(totals.total_input).toBe(daily.reduce((sum, row) => sum + row.input_tokens, 0))
    expect(totals.total_output).toBe(daily.reduce((sum, row) => sum + row.output_tokens, 0))
    expect(totals.total_sessions).toBe(daily.reduce((sum, row) => sum + row.sessions, 0))
  })

  it('only looks back as far as `days`', async () => {
    await stage({
      days: {
        researcher: [
          { actual_cost: 0, day: utcDay(Date.now() / 1000), estimated_cost: 1, input_tokens: 10, sessions: 1 },
          {
            actual_cost: 0,
            day: utcDay(Date.now() / 1000 - 20 * 86_400),
            estimated_cost: 2,
            input_tokens: 20,
            sessions: 1
          }
        ]
      }
    })

    expect(((await analytics('days=7&profile=researcher')).body.daily as unknown[]).length).toBe(1)
    expect(((await analytics('days=30&profile=researcher')).body.daily as unknown[]).length).toBe(2)
  })

  it('refuses a `days` outside 1…365 with a 422, as FastAPI does, and does not clamp it', async () => {
    for (const days of ['0', '366', '-1', 'x', '1.5']) {
      const { body, status } = await analytics(`days=${days}&profile=researcher`)

      expect(status, days).toBe(422)
      expect(JSON.stringify(body.detail)).toContain('days')
    }

    expect((await analytics('days=365&profile=researcher')).status).toBe(200)
    expect((await analytics('days=1&profile=researcher')).status).toBe(200)
  })

  it('answers 404 for a profile the gateway does not have, not an empty history', async () => {
    const { body, status } = await analytics('days=7&profile=nobody')

    expect(status).toBe(404)
    expect(String(body.detail)).toContain('nobody')
  })

  it('has a staged profile’s days exactly, nulls and all', async () => {
    await stage({
      days: {
        writer: [
          {
            actual_cost: 0,
            api_calls: null,
            cache_read_tokens: null,
            day: utcDay(Date.now() / 1000),
            estimated_cost: 0,
            input_tokens: null,
            output_tokens: null,
            reasoning_tokens: null,
            sessions: 1
          }
        ]
      }
    })

    const daily = (await analytics('days=7&profile=writer')).body.daily as Record<string, unknown>[]

    // `SUM()` over rows with no counters is null; the app reads that as zero.
    expect(daily).toHaveLength(1)
    expect(daily[0]?.input_tokens).toBeNull()
  })

  it('is a plain 404 on a gateway staged without the route', async () => {
    await stage({ unsupported: true })

    expect((await analytics('days=7&profile=researcher')).status).toBe(404)
  })
})

describe('insights.get', () => {
  it('counts sessions and messages and nothing else', async () => {
    const result = await call('insights.get', { days: 30, profile: 'researcher' })

    expect(Object.keys(result).sort()).toEqual(['days', 'messages', 'sessions'])
    expect(result.days).toBe(30)
    expect(result.sessions).toBeGreaterThan(0)
    expect(result.messages).toBeGreaterThan(0)
  })

  it('is scoped to the profile it is given', async () => {
    const researcher = await call('insights.get', { days: 30, profile: 'researcher' })
    const everyone = await call('insights.get', { days: 30 })

    expect(Number(everyone.sessions)).toBeGreaterThanOrEqual(Number(researcher.sessions))
  })

  it('answers -32601 on a gateway staged without it', async () => {
    await stage({ unsupported: true })

    await expect(call('insights.get', { days: 7, profile: 'researcher' })).rejects.toMatchObject({ code: -32601 })
  })
})

describe('usage.bars', () => {
  it('says there is no balance for an account that is not a Nous one, without an error', async () => {
    expect(await call('usage.bars')).toEqual({ available: false, ok: true })
  })

  it('answers the Nous balance as display strings and fractions', async () => {
    await stage({ bars: true })

    const bars = await call('usage.bars')
    const plan = bars.plan_bar as Record<string, unknown>
    const topup = bars.topup_bar as Record<string, unknown>

    expect(bars.available).toBe(true)
    expect(bars.plan_name).toBe('Pro')
    expect(bars.total_spendable_display).toBe('$15.00')
    expect(plan.remaining_display).toBe('$12.00')
    expect(plan.pct_used).toBe(40)
    expect(plan.fill_fraction).toBe(0.6)
    // A top-up has no ceiling: `pct_used` is null and the bar is full.
    expect(topup.pct_used).toBeNull()
    expect(topup.fill_fraction).toBe(1)
  })
})

describe('session.usage', () => {
  const runtimeSession = async (): Promise<string> => {
    const stored = gateway.state.profiles.find(row => row.name === 'researcher')?.canonical_session?.id
    const resumed = await call('session.resume', { profile: 'researcher', session_id: stored })

    return String(resumed.session_id)
  }

  it('carries no account lines unless the provider has some to report', async () => {
    const usage = await call('session.usage', { session_id: await runtimeSession() })

    expect(usage).not.toHaveProperty('account_lines')
    expect(usage).not.toHaveProperty('credits_lines')
    expect(usage.context_max).toBeGreaterThan(0)
  })

  it('carries the provider account’s limits as the text lines the gateway renders them as', async () => {
    await stage({ accountLines: true, creditsLines: ['Nous credits: $4.20'] })

    const usage = await call('session.usage', { session_id: await runtimeSession() })

    expect(usage.account_lines).toEqual([
      '📈 Account limits',
      'Provider: anthropic (Max)',
      'Current session: 82% remaining (18% used) • resets in 2h 10m',
      'Current week: 64% remaining (36% used) • resets in 3d 4h'
    ])
    expect(usage.credits_lines).toEqual(['Nous credits: $4.20'])
    // Beside, and not instead of, what the session itself used.
    expect(usage.total).toBeGreaterThan(0)
  })
})

describe('account.usage', () => {
  const calls = async (): Promise<{ profile: string | null; refresh: boolean }[]> => {
    const response = await fetch(`${gateway.url}/__fake/usage`)

    return ((await response.json()) as { accountCalls: { profile: string | null; refresh: boolean }[] }).accountCalls
  }

  it('answers per provider the plan, the windows with a share used and a reset time, details and credits', async () => {
    const answer = await call('account.usage')
    const providers = answer.providers as Record<string, unknown>[]

    expect(answer.ok).toBe(true)
    // The launch profile, as the gateway's own default.
    expect(answer.profile).toBe(gateway.state.profiles.find(entry => entry.is_default)?.name)

    const claude = providers.find(entry => entry.provider === 'anthropic') as Record<string, unknown>

    expect(Object.keys(claude).sort()).toEqual(
      [
        'available',
        'credits',
        'details',
        'fetched_at',
        'plan',
        'provider',
        'source',
        'title',
        'unavailable_reason',
        'windows'
      ].sort()
    )
    expect(claude).toMatchObject({ available: true, plan: 'Max', unavailable_reason: null })

    const windows = claude.windows as Record<string, unknown>[]

    expect(windows.map(window => window.id)).toEqual(['current_session', 'current_week'])
    expect(windows[0]).toMatchObject({ label: 'Current session', used_percent: 18 })
    // ISO UTC, in the future: what "resets in" counts down to.
    expect(String(windows[0]?.reset_at)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    expect(Date.parse(String(windows[0]?.reset_at))).toBeGreaterThan(Date.now())
  })

  it('says why a provider has nothing: unavailable, with a reason and no windows', async () => {
    const providers = (await call('account.usage')).providers as Record<string, unknown>[]
    const router = providers.find(entry => entry.provider === 'openrouter')

    expect(router).toMatchObject({
      available: false,
      unavailable_reason: 'Not signed in to this provider in this profile.',
      windows: []
    })
  })

  it('answers what a test staged, credits included, for the profile it is asked about', async () => {
    await stage({
      account: [
        {
          available: true,
          credits: { currency: 'USD', remaining: 4.2, total: 10 },
          details: [],
          fetched_at: '2026-10-05T12:00:00Z',
          plan: null,
          provider: 'nous',
          source: 'portal-account',
          title: 'Nous credits',
          unavailable_reason: null,
          windows: []
        }
      ]
    })

    const answer = await call('account.usage', { profile: 'researcher' })

    expect(answer.profile).toBe('researcher')
    expect(answer.providers).toHaveLength(1)
    expect((answer.providers as Record<string, unknown>[])[0]?.credits).toEqual({
      currency: 'USD',
      remaining: 4.2,
      total: 10
    })
  })

  it('keeps what it was asked, so a test can tell a refresh from a plain read', async () => {
    await call('account.usage', { profile: 'researcher' })
    await call('account.usage', { refresh: true })

    expect(await calls()).toEqual([
      { profile: 'researcher', refresh: false },
      { profile: null, refresh: true }
    ])
  })

  it('refuses a profile the gateway does not serve with 4064, never the launch profile’s answer', async () => {
    await expect(call('account.usage', { profile: 'nobody' })).rejects.toMatchObject({ code: 4064 })
  })

  it('answers -32601 on a gateway that has the other usage calls and not this one', async () => {
    await stage({ accountUnsupported: true })

    await expect(call('account.usage')).rejects.toMatchObject({ code: -32601 })
    // The rest of the usage calls are still there.
    expect((await call('usage.bars')).ok).toBe(true)
  })

  it('answers -32601 on a gateway staged without any of the usage calls', async () => {
    await stage({ unsupported: true })

    await expect(call('account.usage')).rejects.toMatchObject({ code: -32601 })
  })
})
