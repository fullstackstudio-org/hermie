/**
 * Running what a Shortcut asked for.
 *
 * The rule the whole class is arranged around — every request is answered,
 * including the ones that fail — is the opposite of the share outbox's, and it
 * is what most of these tests are about. A share that cannot be delivered is
 * kept, because nobody is waiting. A Shortcut is somebody holding a phone.
 */
import { IntentRunner, type IntentRunnerPorts } from '../src/features/intents/intent-runner'
import { INTENT_BUDGET_MS, INTENT_QUEUE_VERSION, type IntentResult } from '../src/features/intents/queue'

const NOW = 1_700_000_000_000

function requestFor(over: Record<string, unknown> = {}): { id: string; payload: string } {
  const id = (over.id as string) ?? 'i1'

  return {
    id,
    payload: JSON.stringify({
      version: INTENT_QUEUE_VERSION,
      id,
      kind: 'ask',
      bot: 'researcher',
      text: 'what is the status',
      createdAt: NOW,
      ...over
    })
  }
}

function harness(entries: { id: string; payload: string }[], over: Partial<IntentRunnerPorts> = {}) {
  const calls: string[] = []
  const answers = new Map<string, IntentResult>()
  let remaining = [...entries]

  const ports: IntentRunnerPorts = {
    queue: {
      available: true,
      async list() {
        calls.push('list')

        return remaining.map(entry => ({ ...entry }))
      },
      async complete(id, result) {
        calls.push(`complete:${id}`)
        answers.set(id, JSON.parse(result) as IntentResult)
        remaining = remaining.filter(entry => entry.id !== id)

        return true
      },
      async indexBots() {
        return true
      }
    },
    ready: () => true,
    open: async bot => {
      calls.push(`open:${bot}`)
    },
    send: async bot => {
      calls.push(`send:${bot}`)

      return 'o:1'
    },
    startReplyWatch: (bot, budgetMs) => {
      calls.push(`watch:${bot}:${budgetMs}`)

      return {
        prompted: mark => {
          calls.push(`prompted:${mark.itemId ?? 'parked'}`)
        },
        reply: Promise.resolve('the status is fine')
      }
    },
    now: () => NOW,
    ...over
  }

  return { answers, calls, runner: new IntentRunner(ports) }
}

describe('Ask a bot', () => {
  it('opens the chat, sends, waits, and answers with the reply', async () => {
    const { answers, calls, runner } = harness([requestFor()])

    await runner.run()

    /*
      The order is the fix for a Shortcut that answered with the PREVIOUS reply:
      the chat is OPENED first, because opening it hydrates the transcript and a
      watch started before that takes its baseline on an empty one; the watch
      goes second, because a fast gateway can finish the turn before `send`
      returns; and the prompt is reported last, because nothing can be an answer
      to a question that has not been asked. See `await-reply.ts`.
    */
    expect(calls).toEqual([
      'list',
      'open:researcher',
      `watch:researcher:${INTENT_BUDGET_MS}`,
      'send:researcher',
      'prompted:o:1',
      'complete:i1'
    ])
    expect(answers.get('i1')).toEqual({ version: 1, id: 'i1', ok: true, reply: 'the status is fine' })
  })

  /**
   * A turn still running when the budget runs out is a real outcome, not a
   * failure of anything. What the person needs is the way out, which is the
   * action that does not wait.
   */
  it('says so, and names the way out, when the turn is still running', async () => {
    const { answers, runner } = harness([requestFor()], {
      startReplyWatch: () => ({ prompted: () => undefined, reply: Promise.resolve(null) })
    })

    await runner.run()

    expect(answers.get('i1')?.ok).toBe(false)
    expect(answers.get('i1')?.error).toContain('Send to')
  })

  /**
   * The watch gets what is LEFT of the budget, not the budget.
   *
   * Both sides spend one number, and they start spending it at different
   * moments: the Swift side from the instant it writes the request, this side
   * only after a launch, a dial and a hydration. A watch that ran the full
   * budget from here would write its answer into a file nobody is reading any
   * more.
   */
  it('hands the watch what is left of the budget after the launch', async () => {
    const { calls, runner } = harness([requestFor({ createdAt: NOW - 12_000 })])

    await runner.run()

    expect(calls).toContain(`watch:researcher:${INTENT_BUDGET_MS - 12_000}`)
  })
})

describe('Send to a bot', () => {
  it('returns as soon as the gateway has the prompt, and never waits', async () => {
    const { answers, calls, runner } = harness([requestFor({ kind: 'send' })])

    await runner.run()

    expect(calls).toEqual(['list', 'open:researcher', 'send:researcher', 'complete:i1'])
    expect(calls.some(call => call.startsWith('watch:'))).toBe(false)
    expect(answers.get('i1')).toEqual({ version: 1, id: 'i1', ok: true, reply: '' })
  })
})

describe('the requests it cannot run', () => {
  it('answers a bot the roster does not have with the reason', async () => {
    const { answers, runner } = harness([requestFor({ bot: 'ghost' })], {
      open: async bot => {
        throw new Error(`${bot} is not a bot on this gateway.`)
      }
    })

    await runner.run()

    expect(answers.get('i1')).toEqual({
      version: 1,
      id: 'i1',
      ok: false,
      error: 'ghost is not a bot on this gateway.'
    })
  })

  it('answers a request it cannot read rather than dropping it', async () => {
    const { answers, runner } = harness([{ id: 'i1', payload: '{not json' }])

    await runner.run()

    expect(answers.get('i1')?.ok).toBe(false)
    expect(answers.get('i1')?.error).toContain('newer version')
  })

  /**
   * The one thing that must not happen: a prompt arriving in a chat long after
   * the person gave up on asking for it.
   */
  it('sends nothing for a request whose budget has run out', async () => {
    const { answers, calls, runner } = harness([requestFor({ createdAt: NOW - INTENT_BUDGET_MS - 1 })])

    await runner.run()

    expect(calls).toEqual(['list', 'complete:i1'])
    expect(answers.get('i1')?.error).toContain('too long')
  })

  /**
   * The one case that IS left pending. The request is still inside its budget,
   * the socket is dialling, and the Swift side is still polling — so the ready
   * edge runs this again in a moment and the wait costs nothing extra.
   */
  it('leaves a request alone while the gateway is not ready yet', async () => {
    const { calls, runner } = harness([requestFor()], { ready: () => false })

    await runner.run()

    expect(calls).toEqual(['list'])
  })

  it('does nothing at all where there are no Shortcuts', async () => {
    const { calls, runner } = harness([requestFor()], {
      queue: {
        available: false,
        async list() {
          return []
        },
        async complete() {
          return false
        },
        async indexBots() {
          return false
        }
      }
    })

    await runner.run()

    expect(calls).toEqual([])
  })
})

describe('two requests at once', () => {
  it('runs them oldest first', async () => {
    const { calls, runner } = harness([
      requestFor({ id: 'later', kind: 'send', createdAt: NOW - 1_000 }),
      requestFor({ id: 'earlier', kind: 'send', createdAt: NOW - 2_000 })
    ])

    await runner.run()

    expect(calls.filter(call => call.startsWith('complete'))).toEqual(['complete:earlier', 'complete:later'])
  })

  /**
   * The link and the gateway's ready edge land within a frame of each other on
   * a cold start, which is exactly the launch a Shortcut produces.
   */
  it('does not run the same request twice when two runs overlap', async () => {
    const { calls, runner } = harness([requestFor({ kind: 'send' })])

    await Promise.all([runner.run(), runner.run()])

    expect(calls.filter(call => call === 'send:researcher')).toHaveLength(1)
  })
})
