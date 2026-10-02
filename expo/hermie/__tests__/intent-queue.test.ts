/**
 * What a Shortcut asks for, and what it gets back.
 *
 * The parser's rules are stricter than the share manifest's and the tests say
 * why: a share with one field written badly is still worth delivering, because
 * nobody is waiting. A request with one field written badly has a person
 * watching a spinner, so there is nothing to be gained by repairing it and a
 * clear refusal is worth more than a guess.
 */
import {
  intentFailure,
  intentReply,
  isExpired,
  isSafeIntentId,
  parsePendingIntent,
  sortIntents,
  INTENT_BUDGET_MS,
  INTENT_QUEUE_VERSION
} from '../src/features/intents/queue'

const request = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    version: INTENT_QUEUE_VERSION,
    id: 'abc123',
    kind: 'ask',
    bot: 'researcher',
    text: 'what is the status',
    createdAt: 1_700_000_000_000,
    ...over
  })

describe('parsePendingIntent', () => {
  it('reads the ordinary shape', () => {
    expect(parsePendingIntent(request())).toEqual({
      version: 1,
      id: 'abc123',
      kind: 'ask',
      bot: 'researcher',
      text: 'what is the status',
      createdAt: 1_700_000_000_000
    })
  })

  it('reads the fire-and-forget kind too', () => {
    expect(parsePendingIntent(request({ kind: 'send' }))?.kind).toBe('send')
  })

  it('refuses a version it does not understand', () => {
    expect(parsePendingIntent(request({ version: 2 }))).toBeNull()
  })

  it('refuses a kind it has never heard of', () => {
    // "Open chat" and "Bots needing input" never reach the queue at all — one
    // is a link and the other reads the snapshot in Swift.
    expect(parsePendingIntent(request({ kind: 'open' }))).toBeNull()
  })

  /**
   * Every field is load bearing. A request with no bot has nowhere to go and a
   * request with no words is a prompt with nothing in it, and both would fail
   * further down where the failure is harder to explain.
   */
  it.each([
    ['no bot', { bot: '' }],
    ['no text', { text: '' }],
    ['text that is only spaces', { text: '   ' }],
    ['an id that is not a name', { id: '../escape' }],
    ['a bot that is not a string', { bot: 42 }]
  ])('refuses %s', (_label, over) => {
    expect(parsePendingIntent(request(over))).toBeNull()
  })

  it('refuses anything that is not JSON, or is not an object', () => {
    expect(parsePendingIntent('{not json')).toBeNull()
    expect(parsePendingIntent('[]')).toBeNull()
  })

  it('accepts the alphabet the Swift side mints ids from', () => {
    expect(isSafeIntentId('0f2a4c6e8a0c2e4f6a8c0e2f4a6c8e0f')).toBe(true)
    expect(isSafeIntentId('.hidden')).toBe(false)
    expect(isSafeIntentId('has space')).toBe(false)
  })
})

describe('the answer the intent reads', () => {
  it('carries the reply', () => {
    expect(JSON.parse(intentReply('abc', 'the status is fine'))).toEqual({
      version: 1,
      id: 'abc',
      ok: true,
      reply: 'the status is fine'
    })
  })

  it('carries one sentence when it failed', () => {
    expect(JSON.parse(intentFailure('abc', 'No such bot.'))).toEqual({
      version: 1,
      id: 'abc',
      ok: false,
      error: 'No such bot.'
    })
  })
})

describe('the budget', () => {
  /**
   * A request outlives its Shortcut in one ordinary case: the app was opened,
   * took too long, and the person moved on. The prompt must then NOT be sent —
   * a message arriving ten minutes after somebody gave up asking for it is
   * worse than no message.
   */
  it('expires a request nobody is waiting for any more', () => {
    const intent = parsePendingIntent(request({ createdAt: 1_000 }))!

    expect(isExpired(intent, 1_000 + INTENT_BUDGET_MS - 1)).toBe(false)
    expect(isExpired(intent, 1_000 + INTENT_BUDGET_MS + 1)).toBe(true)
  })
})

describe('the queue order', () => {
  it('is oldest first', () => {
    const make = (id: string, createdAt: number) =>
      parsePendingIntent(request({ id, createdAt, kind: 'send' as const }))!

    expect(sortIntents([make('c', 3), make('a', 1), make('b', 2)]).map(intent => intent.id)).toEqual(['a', 'b', 'c'])
  })
})
