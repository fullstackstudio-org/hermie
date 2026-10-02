/**
 * Waiting for the reply "Ask a bot" returns.
 *
 * Four sequences decide the shape of this, and all four are below because none
 * of them is obvious from the code:
 *
 *  - a COLD start, where opening the chat paints the whole of the previous
 *    conversation into the store. That one shipped broken: the watch read the
 *    hydration as an answer and a Shortcut returned the reply to the question
 *    that had been asked the time before;
 *  - a gateway fast enough to finish the turn before the caller gets back;
 *  - a prompt parked behind a turn that was already running, so the first turn
 *    to END is not the one that was asked about;
 *  - a reconnect, whose resume re-lays the tail — which changes item ids without
 *    anything having been said.
 *
 * What makes all four work is that nothing settles until the prompt has been
 * accepted, and that a reply then has to stand AFTER our own words rather than
 * merely have a different id from the one before.
 */
import type { ChatState } from '@hermie/transcript'

import { answersPrompt, lastReplyOf, startReplyWatch } from '../src/features/intents/await-reply'

type Listener = () => void

interface Row {
  id: string
  kind: string
  text?: string
  interim?: boolean
}

function chatWith(rows: Row[], active = false) {
  return {
    order: rows.map(row => row.id),
    items: Object.fromEntries(rows.map(row => [row.id, { text: '', ...row }])),
    turn: { active }
  } as unknown as ChatState
}

function storeWith(initial: ChatState) {
  const listeners = new Set<Listener>()
  let chat = initial

  return {
    store: {
      getState: () => ({ chats: { researcher: chat } }),
      subscribe: (listener: Listener) => {
        listeners.add(listener)

        return () => listeners.delete(listener)
      }
    },
    set(next: ChatState) {
      chat = next
      for (const listener of [...listeners]) {
        listener()
      }
    }
  }
}

/** What the runner passes once `send` has come back. */
const ASKED = { itemId: 'o:1', text: 'what is the status' }

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

describe('lastReplyOf', () => {
  it('takes the last thing the bot SAID, not the last row', () => {
    const chat = chatWith([
      { id: 'a', kind: 'assistant', text: 'the answer' },
      { id: 'b', kind: 'tool' },
      { id: 'c', kind: 'notice' }
    ])

    expect(lastReplyOf(chat)).toEqual({ id: 'a', text: 'the answer' })
  })

  /**
   * Mid-turn commentary the gateway seals before the real reply. Returning it
   * would hand a Shortcut "Let me look that up" as the answer.
   */
  it('skips an interim bubble', () => {
    const chat = chatWith([
      { id: 'a', kind: 'assistant', text: 'the answer' },
      { id: 'b', kind: 'assistant', text: 'let me look', interim: true }
    ])

    expect(lastReplyOf(chat)?.id).toBe('a')
  })

  it('answers nothing for a chat with nothing in it', () => {
    expect(lastReplyOf(undefined)).toBeNull()
    expect(lastReplyOf(chatWith([]))).toBeNull()
  })
})

describe('answersPrompt', () => {
  it('accepts a reply that stands after the prompt it was painted for', () => {
    const chat = chatWith([
      { id: 'h1', kind: 'user', text: 'yesterday' },
      { id: 'h2', kind: 'assistant', text: 'the old answer' },
      { id: 'o:1', kind: 'user', text: 'what is the status' },
      { id: 'live', kind: 'assistant', text: 'the new answer' }
    ])

    expect(answersPrompt(chat, 'live', ASKED, 'h2')).toBe(true)
  })

  it('refuses the reply that was already there', () => {
    const chat = chatWith([
      { id: 'h1', kind: 'user', text: 'yesterday' },
      { id: 'h2', kind: 'assistant', text: 'the old answer' }
    ])

    expect(answersPrompt(chat, 'h2', ASKED, 'h2')).toBe(false)
  })

  /**
   * A transcript re-laid under the watch — a reconnect's resume, a history read
   * that arrived late. Nothing has been said, but every id is new, which is
   * exactly what an identity test cannot see.
   */
  it('refuses a previous reply that came back under a new id', () => {
    const chat = chatWith([
      { id: 'r1', kind: 'user', text: 'yesterday' },
      { id: 'r2', kind: 'assistant', text: 'the old answer' }
    ])

    expect(answersPrompt(chat, 'r2', ASKED, 'h2')).toBe(false)
  })

  /**
   * The parked prompt. It had no item when it was submitted, so there is no id
   * to measure against and its own words are what identify its bubble.
   */
  it('places a parked prompt by what it says', () => {
    const chat = chatWith([
      { id: 'h2', kind: 'assistant', text: 'the old answer' },
      { id: 'o:4', kind: 'user', text: 'what is the status' },
      { id: 'live', kind: 'assistant', text: 'the new answer' }
    ])

    expect(answersPrompt(chat, 'live', { text: 'what is the status' }, 'h2')).toBe(true)
  })

  it('refuses a reply with none of our words before it', () => {
    const chat = chatWith([
      { id: 'h2', kind: 'assistant', text: 'the old answer' },
      { id: 'other', kind: 'user', text: 'somebody else asked something' },
      { id: 'theirs', kind: 'assistant', text: 'their answer' }
    ])

    expect(answersPrompt(chat, 'theirs', { text: 'what is the status' }, 'h2')).toBe(false)
  })
})

describe('startReplyWatch', () => {
  /**
   * The cold start, which is the launch a Shortcut actually produces.
   *
   * The store is empty when the watch begins and then the chat hydrates: the
   * cache paints the thread, the resume binds it, the history read fills it in.
   * None of that is a reply to anything, and the newest of it is the answer to
   * the question asked the time before.
   */
  it('does not read a hydration as a reply', async () => {
    const { set, store } = storeWith(chatWith([]))
    const watch = startReplyWatch({ chats: store, botName: 'researcher', timeoutMs: 1_000 })
    const settled = jest.fn()

    void watch.reply.then(settled)

    set(
      chatWith([
        { id: 'h1', kind: 'user', text: 'yesterday' },
        { id: 'h2', kind: 'assistant', text: 'the old answer' }
      ])
    )
    await settle()

    expect(settled).not.toHaveBeenCalled()
  })

  it('answers with the reply to the prompt once the turn ends', async () => {
    const history = [
      { id: 'h1', kind: 'user', text: 'yesterday' },
      { id: 'h2', kind: 'assistant', text: 'the old answer' }
    ]
    const { set, store } = storeWith(chatWith(history))
    const watch = startReplyWatch({ chats: store, botName: 'researcher', timeoutMs: 1_000 })

    const asked = [...history, { id: 'o:1', kind: 'user', text: 'what is the status' }]

    set(chatWith(asked, true))
    watch.prompted(ASKED)
    set(chatWith([...asked, { id: 'live', kind: 'assistant', text: 'all fine' }], true))
    set(chatWith([...asked, { id: 'live', kind: 'assistant', text: 'all fine' }]))

    await expect(watch.reply).resolves.toBe('all fine')
  })

  /**
   * The fast gateway. The whole turn is over before `send` comes back, so the
   * reply is already in the store by the time the runner says the prompt has
   * gone — and a watch that only reacted to CHANGES from then on would sit
   * through the entire budget for it.
   */
  it('answers a reply that landed before the prompt was reported', async () => {
    const { set, store } = storeWith(chatWith([{ id: 'h2', kind: 'assistant', text: 'the old answer' }]))
    const watch = startReplyWatch({ chats: store, botName: 'researcher', timeoutMs: 1_000 })

    set(
      chatWith([
        { id: 'h2', kind: 'assistant', text: 'the old answer' },
        { id: 'o:1', kind: 'user', text: 'what is the status' },
        { id: 'live', kind: 'assistant', text: 'instant' }
      ])
    )
    watch.prompted(ASKED)

    await expect(watch.reply).resolves.toBe('instant')
  })

  /**
   * The parked-prompt race. A turn was already running when the request was
   * made, so `ChatController.send` queues it — and the first turn to end is
   * somebody else's.
   */
  it('does not answer with the turn that was already running', async () => {
    const running = [
      { id: 'h2', kind: 'assistant', text: 'the old answer' },
      { id: 'other', kind: 'user', text: 'somebody else asked something' }
    ]
    const { set, store } = storeWith(chatWith(running, true))
    const watch = startReplyWatch({ chats: store, botName: 'researcher', timeoutMs: 1_000 })
    const settled = jest.fn()

    void watch.reply.then(settled)
    // Parked: no item was painted, so the prompt is identified by its words.
    watch.prompted({ text: 'what is the status' })

    // The turn ahead of ours ends, with a reply of its own.
    const theirs = [...running, { id: 'theirs', kind: 'assistant', text: 'their answer' }]

    set(chatWith(theirs))
    await settle()

    expect(settled).not.toHaveBeenCalled()

    // Ours is taken out of the queue, sent, and answered.
    const ours = [...theirs, { id: 'o:4', kind: 'user', text: 'what is the status' }]

    set(chatWith([...ours, { id: 'live', kind: 'assistant', text: 'ours' }]))

    await expect(watch.reply).resolves.toBe('ours')
  })

  /**
   * A reconnect mid-wait. `session.resume` re-lays the tail, so ids change with
   * nothing having been said — the case an "is it a different id" test answers
   * wrongly, and the second half of why a Shortcut returned the previous reply.
   */
  it('does not answer because a reconnect renumbered the transcript', async () => {
    const { set, store } = storeWith(
      chatWith([
        { id: 'h1', kind: 'user', text: 'yesterday' },
        { id: 'h2', kind: 'assistant', text: 'the old answer' }
      ])
    )
    const watch = startReplyWatch({ chats: store, botName: 'researcher', timeoutMs: 1_000 })
    const settled = jest.fn()

    void watch.reply.then(settled)
    watch.prompted(ASKED)

    set(
      chatWith([
        { id: 'r1', kind: 'user', text: 'yesterday' },
        { id: 'r2', kind: 'assistant', text: 'the old answer' }
      ])
    )
    await settle()

    expect(settled).not.toHaveBeenCalled()

    // And then the real one, after the prompt this time.
    set(
      chatWith([
        { id: 'r1', kind: 'user', text: 'yesterday' },
        { id: 'r2', kind: 'assistant', text: 'the old answer' },
        { id: 'o:1', kind: 'user', text: 'what is the status' },
        { id: 'r3', kind: 'assistant', text: 'after the reconnect' }
      ])
    )

    await expect(watch.reply).resolves.toBe('after the reconnect')
  })

  it('answers null when the budget runs out', async () => {
    const { store } = storeWith(chatWith([{ id: 'h2', kind: 'assistant', text: 'old' }], true))
    const watch = startReplyWatch({ chats: store, botName: 'researcher', timeoutMs: 5 })

    watch.prompted(ASKED)

    await expect(watch.reply).resolves.toBeNull()
  })

  /** A watch nobody ever reports a prompt to still settles, and settles to null. */
  it('answers null for a send that never happened', async () => {
    const { store } = storeWith(chatWith([{ id: 'h2', kind: 'assistant', text: 'old' }]))

    await expect(startReplyWatch({ chats: store, botName: 'researcher', timeoutMs: 5 }).reply).resolves.toBeNull()
  })

  /**
   * An interruption, a tool-only turn, an error. A Shortcut that returned an
   * empty string for any of those would look like it had worked.
   */
  it('answers null for a turn that ended with nothing to say', async () => {
    const { set, store } = storeWith(chatWith([{ id: 'o:1', kind: 'user', text: 'what is the status' }], true))
    const watch = startReplyWatch({ chats: store, botName: 'researcher', timeoutMs: 1_000 })

    watch.prompted(ASKED)
    set(
      chatWith([
        { id: 'o:1', kind: 'user', text: 'what is the status' },
        { id: 'live', kind: 'assistant', text: '' }
      ])
    )

    await expect(watch.reply).resolves.toBeNull()
  })

  it('stops listening once it has answered', async () => {
    const asked = [{ id: 'o:1', kind: 'user', text: 'what is the status' }]
    const { set, store } = storeWith(chatWith(asked, true))
    const watch = startReplyWatch({ chats: store, botName: 'researcher', timeoutMs: 1_000 })

    watch.prompted(ASKED)
    set(chatWith([...asked, { id: 'first', kind: 'assistant', text: 'first' }]))
    await expect(watch.reply).resolves.toBe('first')

    // A later turn must not be able to settle an already-settled promise, which
    // would be an unhandled state rather than a visible bug.
    expect(() =>
      set(
        chatWith([
          ...asked,
          { id: 'first', kind: 'assistant', text: 'first' },
          { id: 'second', kind: 'assistant', text: 'second' }
        ])
      )
    ).not.toThrow()
  })
})
