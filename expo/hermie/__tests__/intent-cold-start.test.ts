/**
 * "Ask a bot", as the whole chain rather than as its parts.
 *
 * `intent-runner.test.ts` proves the runner answers every request and
 * `intent-await-reply.test.ts` proves the watch reads a transcript correctly.
 * Neither of them caught the thing the owner hit, because the bug lived in the
 * SEAM: the runner started the watch, and only afterwards did the thing that
 * fills the store. So this file wires the real runner to the real watch over a
 * transcript that behaves like the app's — opening a chat hydrates it, sending
 * paints a bubble, the gateway answers — and drives the four sequences that
 * actually happen on a phone.
 *
 * A cold start is the one that shipped broken, and it is the launch a Shortcut
 * produces every time: the app was not running, so the chat store is empty when
 * the request is picked up, and opening the chat paints the previous
 * conversation into it. The watch saw a last-message id where there had been
 * none, no running turn, and answered with the reply to the question that had
 * been asked the time before.
 */
import type { ChatState } from '@hermie/transcript'

import { startReplyWatch } from '../src/features/intents/await-reply'
import { IntentRunner, type IntentRunnerPorts } from '../src/features/intents/intent-runner'
import { INTENT_QUEUE_VERSION, type IntentResult } from '../src/features/intents/queue'

const NOW = 1_700_000_000_000
const PROMPT = 'what is the status'

interface Row {
  id: string
  kind: 'user' | 'assistant'
  text: string
}

const YESTERDAY: Row[] = [
  { id: 'h1', kind: 'user', text: 'how did the deploy go' },
  { id: 'h2', kind: 'assistant', text: 'the old answer' }
]

/** The same rows under fresh ids: what a resume hands back after a reconnect. */
const RELAID: Row[] = YESTERDAY.map((row, index) => ({ ...row, id: `r${index}` }))

/**
 * A chat store with the app's shape and none of its machinery.
 *
 * The four mutators are the four things that write to the real one during a
 * Shortcut: a hydration, a resume that re-lays the tail, the bubble a send
 * paints, and a reply arriving and the turn ending.
 */
function transcript(initial: Row[] = []) {
  const listeners = new Set<() => void>()
  let rows = [...initial]
  let active = false
  let painted = 0

  const notify = (): void => {
    for (const listener of [...listeners]) {
      listener()
    }
  }

  return {
    store: {
      getState: () => ({
        chats: {
          researcher: {
            order: rows.map(row => row.id),
            items: Object.fromEntries(rows.map(row => [row.id, row])),
            turn: { active }
          } as unknown as ChatState
        }
      }),
      subscribe: (listener: () => void) => {
        listeners.add(listener)

        return () => listeners.delete(listener)
      }
    },
    /** What `openChat` does: cache, resume and history, as one write. */
    hydrate(next: Row[]) {
      rows = [...next]
      notify()
    },
    /** A prompt painted before the gateway has acknowledged it. */
    paint(text: string): string {
      painted += 1
      const id = `o:${painted}`

      rows = [...rows, { id, kind: 'user', text }]
      active = true
      notify()

      return id
    },
    /** The reply, and the end of the turn. */
    answer(text: string) {
      rows = [...rows, { id: `live${painted}`, kind: 'assistant', text }]
      notify()
      active = false
      notify()
    }
  }
}

type Transcript = ReturnType<typeof transcript>

function runnerFor(chat: Transcript, over: Partial<IntentRunnerPorts> = {}) {
  const answers = new Map<string, IntentResult>()
  let remaining = [
    {
      id: 'i1',
      payload: JSON.stringify({
        version: INTENT_QUEUE_VERSION,
        id: 'i1',
        kind: 'ask',
        bot: 'researcher',
        text: PROMPT,
        createdAt: NOW
      })
    }
  ]

  const ports: IntentRunnerPorts = {
    queue: {
      available: true,
      async list() {
        return remaining.map(entry => ({ ...entry }))
      },
      async complete(id, result) {
        answers.set(id, JSON.parse(result) as IntentResult)
        remaining = remaining.filter(entry => entry.id !== id)

        return true
      },
      async indexBots() {
        return true
      }
    },
    ready: () => true,
    open: async () => chat.hydrate(YESTERDAY),
    send: async (_bot, text) => {
      const id = chat.paint(text)

      setTimeout(() => chat.answer('the new answer'), 0)

      return id
    },
    startReplyWatch: (bot, budgetMs) => startReplyWatch({ botName: bot, chats: chat.store, timeoutMs: budgetMs }),
    now: () => NOW,
    ...over
  }

  return { answers, runner: new IntentRunner(ports) }
}

describe('a Shortcut that cold-started the app', () => {
  it('answers with the new reply rather than the one the hydration painted', async () => {
    const chat = transcript()
    const { answers, runner } = runnerFor(chat)

    await runner.run()

    expect(answers.get('i1')).toEqual({ version: 1, id: 'i1', ok: true, reply: 'the new answer' })
  })

  /**
   * The same launch with a cache one conversation deep and a slow socket: the
   * hydration lands in two writes rather than one, which is two more chances to
   * mistake the previous reply for this one.
   */
  it('is not fooled by a hydration that arrives in stages', async () => {
    const chat = transcript()
    const { answers, runner } = runnerFor(chat, {
      open: async () => {
        chat.hydrate([YESTERDAY[0] as Row])
        chat.hydrate(YESTERDAY)
      }
    })

    await runner.run()

    expect(answers.get('i1')?.reply).toBe('the new answer')
  })
})

describe('a Shortcut on an app that was already running', () => {
  it('answers with the new reply', async () => {
    const chat = transcript(YESTERDAY)
    const { answers, runner } = runnerFor(chat)

    await runner.run()

    expect(answers.get('i1')?.reply).toBe('the new answer')
  })
})

describe('a gateway faster than the send', () => {
  /**
   * The whole turn is over before `send` returns, so there is no store change
   * left to react to. The watch has to look once when the prompt is reported.
   */
  it('answers the reply that had already landed', async () => {
    const chat = transcript()
    const { answers, runner } = runnerFor(chat, {
      send: async (_bot, text) => {
        const id = chat.paint(text)

        chat.answer('the new answer')

        return id
      }
    })

    await runner.run()

    expect(answers.get('i1')?.reply).toBe('the new answer')
  })
})

describe('a reconnect while the reply is still coming', () => {
  /**
   * `session.resume` re-lays the tail, so every id changes although nothing has
   * been said. That is the second half of why a Shortcut returned the previous
   * reply: an identity test cannot tell a renumbering from an answer.
   */
  it('does not answer with the renumbered previous reply', async () => {
    const chat = transcript()
    const { answers, runner } = runnerFor(chat, {
      send: async (_bot, text) => {
        const id = chat.paint(text)

        setTimeout(() => {
          // The dial comes back: the tail is re-laid under new ids, with our own
          // prompt among them, and only then does the bot answer.
          chat.hydrate([...RELAID, { id: 'p1', kind: 'user', text }])
          chat.answer('the new answer')
        }, 0)

        return id
      }
    })

    await runner.run()

    expect(answers.get('i1')?.reply).toBe('the new answer')
  })

  /**
   * The same reconnect, with the reply LOST to it — the turn was rebuilt without
   * one. Nothing new stands after the prompt, so the honest answer is the
   * budget's: still working, use "Send to".
   */
  it('reports the bot as still working rather than answering with history', async () => {
    const chat = transcript()
    const { answers, runner } = runnerFor(chat, {
      startReplyWatch: (bot, budgetMs) =>
        startReplyWatch({ botName: bot, chats: chat.store, timeoutMs: Math.min(budgetMs, 20) }),
      send: async (_bot, text) => {
        const id = chat.paint(text)

        setTimeout(() => chat.hydrate(RELAID), 0)

        return id
      }
    })

    await runner.run()

    expect(answers.get('i1')?.ok).toBe(false)
    expect(answers.get('i1')?.error).toContain('Send to')
  })
})
