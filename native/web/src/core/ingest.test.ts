/**
 * The ingest (`core/ingest.ts`): wire order, one commit per frame, and the
 * hidden tab.
 *
 * Two halves. The first drives the ingest with hand-made arrivals that each
 * append a marker to a chat's message queue, so the order the markers end up
 * in IS the order the arrivals were applied in. The second drives the real
 * controller over a hand-written gateway: events, a server request and an RPC
 * answer interleaved, and what the store (and a screen subscribed to it) sees.
 */
import type { ApprovalItem, AssistantItem, ChatState } from '@hermie/transcript'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createChatsStore } from '../state/chats'
import { botFromProfileRow, botsStore } from '../state/bots'
import { fakeVisibility } from '../test-support/fake-watchers'
import { FakeChatGateway } from '../test-support/fake-chat-gateway'
import { BotsController } from './bots-controller'
import { ChatController } from './chat-controller'
import { createIngest, type FrameSource, HIDDEN_DRAIN_MS, immediateFrames } from './ingest'

/** Frames that come only when the test says so. */
function manualFrames(): FrameSource & { run(): void; readonly waiting: number; readonly requested: number } {
  const callbacks = new Map<number, () => void>()
  let next = 1
  let requested = 0

  return {
    request(callback) {
      const id = next++
      requested += 1
      callbacks.set(id, callback)

      return id
    },
    cancel(handle) {
      callbacks.delete(handle as number)
    },
    run() {
      const due = [...callbacks.values()]

      callbacks.clear()
      due.forEach(callback => callback())
    },
    get waiting() {
      return callbacks.size
    },
    get requested() {
      return requested
    }
  }
}

/** A store with one chat, and a count of the times a subscriber heard from it. */
function storeWithChat() {
  const store = createChatsStore()

  store.getState().ensure('bot', { storedSessionId: 's', resolvedSessionId: 's' })

  let notified = 0
  const stop = store.subscribe(() => {
    notified += 1
  })

  return {
    store,
    notified: () => notified,
    stop,
    /** The markers in the order they were applied, as the COMMITTED store has them. */
    committed: () => (store.getState().queues.bot ?? []).map(entry => entry.id)
  }
}

describe('the ingest', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('applies arrivals in order and commits them in one setState per frame', () => {
    const { store, notified, committed } = storeWithChat()
    const frames = manualFrames()
    const ingest = createIngest({ store, frames, visibility: fakeVisibility('visible') })

    for (const id of ['e1', 'e2', 'e3']) {
      ingest.push(() => ingest.chats.getState().enqueue('bot', { id, text: id }))
    }

    // Queued, not applied, not committed; one frame asked for, not three.
    expect(ingest.pending).toBe(3)
    expect(frames.waiting).toBe(1)
    expect(committed()).toEqual([])
    expect(notified()).toBe(0)

    frames.run()

    expect(committed()).toEqual(['e1', 'e2', 'e3'])
    expect(notified()).toBe(1)
    expect(ingest.commits).toBe(1)
    expect(ingest.pending).toBe(0)
  })

  it('keeps wire order across events, a server request and an RPC answer, and still commits once', async () => {
    const { store, notified, committed } = storeWithChat()
    const frames = manualFrames()
    const ingest = createIngest({ store, frames, visibility: fakeVisibility('visible') })
    const mark = (id: string) => () => ingest.chats.getState().enqueue('bot', { id, text: id })

    // An RPC was sent before any of this; its answer will arrive last.
    const answer = Promise.resolve().then(() => {
      // The controller writing what the answer said, after its `await`.
      ingest.chats.getState().enqueue('bot', { id: 'rpc', text: 'rpc' })
    })

    ingest.push(mark('e1'))
    ingest.push(mark('e2'))

    // A server request needs its yes or no at once: the queue is drained
    // through it, the two events first.
    const accepted = ingest.now(() => {
      mark('request')()

      return true
    })

    expect(accepted).toBe(true)
    expect(ingest.chats.getState().queues.bot?.map(entry => entry.id)).toEqual(['e1', 'e2', 'request'])

    ingest.push(mark('e3'))
    await answer

    // Applied in arrival order, the answer behind the event that beat it...
    expect(ingest.chats.getState().queues.bot?.map(entry => entry.id)).toEqual(['e1', 'e2', 'request', 'e3', 'rpc'])
    // ...and none of it in the store until the frame.
    expect(committed()).toEqual([])
    expect(notified()).toBe(0)

    frames.run()

    expect(committed()).toEqual(['e1', 'e2', 'request', 'e3', 'rpc'])
    expect(notified()).toBe(1)
  })

  it('routes the store’s own actions through the queue, so a screen’s write waits its turn', () => {
    const { store, committed } = storeWithChat()
    const frames = manualFrames()
    const ingest = createIngest({ store, frames, visibility: fakeVisibility('visible') })

    ingest.push(() => ingest.chats.getState().enqueue('bot', { id: 'event', text: 'event' }))
    // What a composer would call: the store's action, not the controller's view.
    store.getState().enqueue('bot', { id: 'screen', text: 'screen' })

    expect(committed()).toEqual([])

    frames.run()

    expect(committed()).toEqual(['event', 'screen'])
  })

  it('drains a hidden page on a 100 ms timer, because a hidden tab gets no frames', () => {
    vi.useFakeTimers()

    const { store, notified, committed } = storeWithChat()
    const frames = manualFrames()
    const visibility = fakeVisibility('hidden')
    const ingest = createIngest({ store, frames, visibility })

    for (const id of ['e1', 'e2']) {
      ingest.push(() => ingest.chats.getState().enqueue('bot', { id, text: id }))
    }

    expect(frames.requested).toBe(0)

    vi.advanceTimersByTime(HIDDEN_DRAIN_MS - 1)
    expect(committed()).toEqual([])

    vi.advanceTimersByTime(1)
    expect(committed()).toEqual(['e1', 'e2'])
    expect(notified()).toBe(1)

    // A reply that keeps streaming into the hidden tab keeps being drained.
    ingest.push(() => ingest.chats.getState().enqueue('bot', { id: 'e3', text: 'e3' }))
    vi.advanceTimersByTime(HIDDEN_DRAIN_MS)
    expect(committed()).toEqual(['e1', 'e2', 'e3'])
    expect(frames.requested).toBe(0)
  })

  it('moves a frame asked for just before the page hid onto the timer, and back when it is shown', () => {
    vi.useFakeTimers()

    const { store, committed } = storeWithChat()
    const frames = manualFrames()
    const visibility = fakeVisibility('visible')
    const ingest = createIngest({ store, frames, visibility })

    ingest.push(() => ingest.chats.getState().enqueue('bot', { id: 'e1', text: 'e1' }))
    expect(frames.waiting).toBe(1)

    // The frame will never come now.
    visibility.set('hidden')
    expect(frames.waiting).toBe(0)

    vi.advanceTimersByTime(HIDDEN_DRAIN_MS)
    expect(committed()).toEqual(['e1'])

    // Asked for while hidden, then shown: the next frame is sooner than the timer.
    ingest.push(() => ingest.chats.getState().enqueue('bot', { id: 'e2', text: 'e2' }))
    visibility.set('visible')
    expect(frames.waiting).toBe(1)

    frames.run()
    expect(committed()).toEqual(['e1', 'e2'])

    vi.advanceTimersByTime(HIDDEN_DRAIN_MS)
    expect(committed()).toEqual(['e1', 'e2'])
  })

  it('never lets a drain span an await: an arrival that starts async work is applied without waiting for it', async () => {
    const { store, committed } = storeWithChat()
    const frames = manualFrames()
    const ingest = createIngest({ store, frames, visibility: fakeVisibility('visible') })
    let later: Promise<void> = Promise.resolve()

    ingest.push(() => {
      ingest.chats.getState().enqueue('bot', { id: 'e1', text: 'e1' })
      later = (async () => {
        await Promise.resolve()
        ingest.chats.getState().enqueue('bot', { id: 'async', text: 'async' })
      })()
    })
    ingest.push(() => ingest.chats.getState().enqueue('bot', { id: 'e2', text: 'e2' }))

    frames.run()

    // The frame applied both arrivals and committed; the async tail had not run.
    expect(committed()).toEqual(['e1', 'e2'])

    await later
    frames.run()

    expect(committed()).toEqual(['e1', 'e2', 'async'])
  })

  it('takes an arrival pushed during a drain in the same drain', () => {
    const { store, committed } = storeWithChat()
    const frames = manualFrames()
    const ingest = createIngest({ store, frames, visibility: fakeVisibility('visible') })

    ingest.push(() => {
      ingest.chats.getState().enqueue('bot', { id: 'e1', text: 'e1' })
      ingest.push(() => ingest.chats.getState().enqueue('bot', { id: 'nested', text: 'nested' }))
    })

    frames.run()

    expect(committed()).toEqual(['e1', 'nested'])
    expect(ingest.pending).toBe(0)
  })

  it('costs a throwing handler its own arrival and nothing else', () => {
    const { store, committed } = storeWithChat()
    const frames = manualFrames()
    const errors: unknown[] = []
    const ingest = createIngest({
      store,
      frames,
      visibility: fakeVisibility('visible'),
      onError: error => errors.push(error)
    })

    ingest.push(() => ingest.chats.getState().enqueue('bot', { id: 'e1', text: 'e1' }))
    ingest.push(() => {
      throw new Error('broken handler')
    })
    ingest.push(() => ingest.chats.getState().enqueue('bot', { id: 'e2', text: 'e2' }))

    frames.run()

    expect(committed()).toEqual(['e1', 'e2'])
    expect(errors).toHaveLength(1)
  })

  it('commits nothing when a frame changed nothing', () => {
    const { store, notified } = storeWithChat()
    const frames = manualFrames()
    const ingest = createIngest({ store, frames, visibility: fakeVisibility('visible') })

    // `dropQueued` of an id that is not there answers the state itself.
    ingest.push(() => ingest.chats.getState().dropQueued('bot', 'absent'))
    frames.run()

    expect(notified()).toBe(0)
    expect(ingest.commits).toBe(0)
  })

  it('flushes on dispose, hands the actions back, and writes straight to the store afterwards', () => {
    const { store, committed } = storeWithChat()
    const frames = manualFrames()
    const visibility = fakeVisibility('visible')
    const ingest = createIngest({ store, frames, visibility })

    expect(store.routedTo).not.toBeNull()

    ingest.push(() => ingest.chats.getState().enqueue('bot', { id: 'e1', text: 'e1' }))
    ingest.dispose()

    expect(committed()).toEqual(['e1'])
    expect(store.routedTo).toBeNull()
    expect(visibility.listeners).toBe(0)

    // A late RPC answer to a stopped controller.
    ingest.chats.getState().enqueue('bot', { id: 'late', text: 'late' })
    expect(committed()).toEqual(['e1', 'late'])
    expect(frames.waiting).toBe(0)
  })

  it('drops a write that comes through its view after dispose, so a late answer cannot refill an emptied store', () => {
    const { store, committed } = storeWithChat()
    const ingest = createIngest({ store, frames: manualFrames(), visibility: fakeVisibility('visible') })

    ingest.dispose()
    store.getState().reset()

    // The view's own `setState` is what a late answer to a stopped controller goes through.
    ingest.chats.setState({ queues: { bot: [{ id: 'late', text: 'late' }] } })
    ingest.push(() => undefined)

    expect(committed()).toEqual([])
    expect(store.getState().chats).toEqual({})
    expect(ingest.dirty).toBe(false)
  })

  it('with immediate frames, commits every write at once, as the Expo store did', () => {
    const { store, notified, committed } = storeWithChat()
    const ingest = createIngest({ store, frames: immediateFrames, visibility: fakeVisibility('visible') })

    ingest.push(() => ingest.chats.getState().enqueue('bot', { id: 'e1', text: 'e1' }))
    expect(committed()).toEqual(['e1'])

    store.getState().enqueue('bot', { id: 'e2', text: 'e2' })
    expect(committed()).toEqual(['e1', 'e2'])
    expect(notified()).toBe(2)
  })
})

describe('the controller on the ingest', () => {
  const RESEARCHER = botFromProfileRow({
    name: 'researcher',
    path: '/root/.hermes/profiles/researcher',
    display_name: 'Researcher',
    canonical_session: {
      id: 'stored-researcher',
      resolved_id: 'stored-researcher',
      title: 'Bot Chat',
      last_active: 1_700_000_100,
      message_count: 2
    }
  })

  const controllers: ChatController[] = []

  beforeEach(() => {
    botsStore.getState().reset()
    botsStore.getState().setBots([RESEARCHER])
  })

  afterEach(() => {
    for (const controller of controllers.splice(0)) {
      controller.stop()
    }
  })

  async function openedChat() {
    const gateway = new FakeChatGateway()
    const store = createChatsStore()
    const frames = manualFrames()
    const controller = new ChatController({
      gateway,
      chats: store,
      bots: botsStore,
      botsController: new BotsController({ gateway, store: botsStore }),
      frames,
      visibility: fakeVisibility('visible')
    })

    controllers.push(controller)
    gateway
      .reply('session.resume', {
        session_id: 'runtime-1',
        stored_session_id: 'stored-researcher',
        message_count: 2,
        messages: [],
        messages_omitted: true,
        info: { desktop_contract: 7 },
        open_requests: []
      })
      .reply('session.history', {
        count: 2,
        messages: [
          { role: 'user', text: 'Introduce yourself.', row_id: 1, timestamp: 1_700_000_000 },
          { role: 'assistant', text: 'I am researcher.', row_id: 2, timestamp: 1_700_000_001 }
        ]
      })
      .reply('session.events.since', {
        events: [],
        latest_seq: 9,
        truncated: false,
        count: 0,
        epoch: 'e1',
        open_requests: []
      })
      .reply('subagent.list', { subagents: [] })
      .reply('approval.received', { acknowledged: true })
      .reply('approval.pending', { approvals: [] })
      .reply('session.interrupt', { status: 'interrupted', interrupted: true })
    gateway.restMessages = null

    controller.start()
    await controller.openChat(RESEARCHER)
    frames.run()

    let notified = 0

    store.subscribe(() => {
      notified += 1
    })

    return { gateway, store, frames, controller, notified: () => notified }
  }

  const streamed = (chat: ChatState | undefined): AssistantItem[] =>
    (chat?.order ?? [])
      .map(id => chat?.items[id])
      .filter((item): item is AssistantItem => item?.kind === 'assistant' && item.rowId === undefined)

  it('applies events, a server request and an RPC answer in wire order, and commits once per frame', async () => {
    const { gateway, store, frames, controller, notified } = await openedChat()
    const before = store.getState().chats.researcher

    gateway.emit({ type: 'message.start', session_id: 'runtime-1', seq: 10, payload: {} })
    gateway.emit({ type: 'message.delta', session_id: 'runtime-1', seq: 11, payload: { text: 'Hel' } })

    // The approval arrives behind the two events and is answered at once.
    const delivered = gateway.serverRequest('srq-1', 'approval', {
      session_id: 'runtime-1',
      request_id: 'appr-1',
      command: 'make clean',
      choices: ['once', 'deny']
    })

    expect(delivered.accepted).toBe(true)

    // Stop is asked for; before its answer is in, one more delta arrives.
    const stopping = controller.stopTurn('researcher')

    gateway.emit({ type: 'message.delta', session_id: 'runtime-1', seq: 12, payload: { text: 'lo' } })
    await stopping

    // Nothing has reached the store: no frame has run.
    expect(store.getState().chats.researcher).toBe(before)
    expect(notified()).toBe(0)

    frames.run()

    expect(notified()).toBe(1)

    const chat = store.getState().chats.researcher
    const [reply] = streamed(chat)
    const card = chat?.items[chat.byRequestId['srq-1'] ?? ''] as ApprovalItem | undefined

    // The two deltas both landed before the stop's answer did: the bubble has
    // the whole text and is the one marked interrupted.
    expect(reply).toMatchObject({ text: 'Hello', status: 'interrupted', streaming: false })
    // The request was placed after the events that arrived before it.
    expect(card).toMatchObject({ kind: 'approval', state: 'open' })
    expect(chat?.order.indexOf(card?.id ?? '')).toBeGreaterThan(chat?.order.indexOf(reply?.id ?? '') ?? -1)
  })

  it('reads what has arrived before deciding: a check made between frames sees the queued events', async () => {
    const { gateway, store, controller } = await openedChat()

    gateway.emit({ type: 'message.start', session_id: 'runtime-1', seq: 10, payload: {} })

    // Not committed yet...
    expect(store.getState().chats.researcher?.turn.active).toBe(false)

    // ...but the controller already treats the bot as busy, as the Expo one
    // would have: the message is parked behind the running turn.
    await controller.send('researcher', 'And another thing.')

    expect(store.getState().queues.researcher ?? []).toEqual([])
    expect(gateway.methodOrder()).not.toContain('prompt.submit')
  })
})
