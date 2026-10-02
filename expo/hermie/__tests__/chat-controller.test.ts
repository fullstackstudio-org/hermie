import type { MessageAuthor, UserItem } from '@hermie/transcript'

import { BotsController } from '../src/features/bots/bots-controller'
import { ChatController } from '../src/features/chats/chat-controller'
import type { RpcFailure } from '../src/gateway/rpc-failures'
import { MemoryChatCache } from '../src/platform/chat-cache'
import { botFromProfileRow, useBotsStore } from '../src/store/bots'
import { useChatsStore } from '../src/store/chats'
import { FakeChatGateway } from './support/fake-chat-gateway'

const RESEARCHER = botFromProfileRow({
  name: 'researcher',
  path: '/root/.hermes/profiles/researcher',
  display_name: 'Researcher',
  canonical_session: {
    id: 'stored-researcher',
    resolved_id: 'tip-researcher',
    title: 'Bot Chat',
    last_active: 1_700_000_100,
    message_count: 2
  }
})

const HISTORY = [
  { role: 'user', text: 'Introduce yourself.', row_id: 1, timestamp: 1_700_000_000 },
  { role: 'assistant', text: 'I am researcher.', row_id: 2, timestamp: 1_700_000_001 }
]

const started: ChatController[] = []

function setup(
  options: {
    cache?: MemoryChatCache | null
    onRpcFailure?: (failure: RpcFailure) => void
    ownAuthor?: () => MessageAuthor | undefined
  } = {}
) {
  const gateway = new FakeChatGateway()
  const cache = options.cache === undefined ? new MemoryChatCache() : options.cache
  const botsController = new BotsController({ gateway, store: useBotsStore, cache })
  const controller = new ChatController({
    gateway,
    chats: useChatsStore,
    bots: useBotsStore,
    botsController,
    cache,
    ...(options.onRpcFailure ? { onRpcFailure: options.onRpcFailure } : {}),
    ...(options.ownAuthor ? { ownAuthor: options.ownAuthor } : {})
  })

  gateway
    .reply('session.resume', {
      session_id: 'runtime-1',
      stored_session_id: 'tip-researcher',
      message_count: 2,
      messages: [],
      messages_omitted: true,
      info: { desktop_contract: 7 },
      open_requests: []
    })
    .reply('session.history', { count: HISTORY.length, messages: HISTORY })
    .reply('session.events.since', {
      events: [],
      latest_seq: 7,
      truncated: false,
      count: 0,
      epoch: 'e1',
      open_requests: []
    })
    .reply('profiles.list', { profiles: [] })
    .reply('approval.received', { acknowledged: true })
    .reply('approval.pending', { approvals: [] })

  useBotsStore.getState().setBots([RESEARCHER])
  gateway.restMessages = null
  started.push(controller)

  return { gateway, cache, controller, botsController }
}

beforeEach(() => {
  useChatsStore.getState().reset()
  useBotsStore.getState().reset()
})

afterEach(() => {
  // The controller owns two timers (the sessions.changed debounce and the
  // approval poll); a test that leaves one running holds the whole run open.
  for (const controller of started.splice(0)) {
    controller.stop()
  }
})

const chatOf = (name = 'researcher') => useChatsStore.getState().chats[name]!

describe('opening a chat', () => {
  it('resumes, reads history, folds in the snapshot and only then replays', async () => {
    const { gateway, controller } = setup()

    await controller.openChat(RESEARCHER)

    // The roster read comes last on purpose: a chat opened halfway through a
    // delegation has to learn about children the event stream never replayed.
    expect(gateway.methodOrder()).toEqual([
      'session.resume',
      'session.history',
      'session.events.since',
      'subagent.list'
    ])
    expect(gateway.lastCall('session.resume')).toMatchObject({
      session_id: 'stored-researcher',
      profile: 'researcher',
      omit_messages: true,
      source: 'hermie'
    })
    expect(chatOf().hydration).toBe('live')
    expect(chatOf().order).toHaveLength(2)
  })

  it('resumes on the durable id and binds the runtime id events arrive under', async () => {
    const { controller } = setup()

    await controller.openChat(RESEARCHER)

    expect(chatOf().storedSessionId).toBe('stored-researcher')
    expect(chatOf().runtimeSessionId).toBe('runtime-1')
    expect(useChatsStore.getState().runtimeToBot).toEqual({ 'runtime-1': 'researcher' })
  })

  it('refuses a gateway whose desktop contract is too old', async () => {
    const { gateway, controller } = setup()

    gateway.reply('session.resume', {
      session_id: 'runtime-1',
      message_count: 0,
      messages: [],
      info: { desktop_contract: 5 }
    })

    await expect(controller.openChat(RESEARCHER)).rejects.toThrow(/desktop contract 5/)
  })

  // A bot that has never spoken has a live session with no stored row, and the
  // gateway resumes it as `{model, lazy: true, profile_name}` — no contract.
  it('opens a bot that has never spoken, whose lazy resume carries no contract', async () => {
    const { gateway, controller } = setup()

    gateway.reply('session.resume', {
      session_id: 'runtime-1',
      stored_session_id: '',
      message_count: 0,
      messages: [],
      info: { model: 'x', lazy: true, profile_name: 'researcher' }
    })

    await controller.openChat(RESEARCHER)

    expect(chatOf().hydration).toBe('live')
    expect(chatOf().runtimeSessionId).toBe('runtime-1')
  })

  it('holds a lazy resume to the contract this gateway reported earlier', async () => {
    const { gateway, controller } = setup()

    // A spoken chat first: the gateway says contract 6 there.
    gateway.reply('session.resume', {
      session_id: 'runtime-1',
      message_count: 0,
      messages: [],
      info: { desktop_contract: 6 }
    })
    await expect(controller.openChat(RESEARCHER)).rejects.toThrow(/desktop contract 6/)

    // The lazy resume of a new bot on the same gateway is refused on that memory.
    gateway.reply('session.resume', {
      session_id: 'runtime-2',
      message_count: 0,
      messages: [],
      info: { model: 'x', lazy: true }
    })
    await expect(controller.openChat(RESEARCHER)).rejects.toThrow(/desktop contract 6/)
  })

  it('reads the REST transcript instead of a full history when the chat is long', async () => {
    const { gateway, controller } = setup()

    gateway.restMessages = HISTORY
    gateway.reply('session.resume', {
      session_id: 'runtime-1',
      stored_session_id: 'tip-researcher',
      message_count: 900,
      messages: [],
      info: { desktop_contract: 7 }
    })

    await controller.openChat(RESEARCHER)

    expect(gateway.restCalls[0]).toEqual({ sessionId: 'tip-researcher', limit: 200, order: 'latest' })
    expect(gateway.methodOrder()).not.toContain('session.history')
  })

  it('paints the cached transcript before the gateway answers', async () => {
    const cache = new MemoryChatCache()

    await cache.write({
      bot: 'researcher',
      itemsJson: JSON.stringify({
        format: 1,
        items: [{ id: 'c1', kind: 'user', text: 'from the cache', seq: 0, version: 0, origin: 'history', rowId: 1 }],
        subagents: [],
        lastSeq: 0,
        updatedAt: 1
      }),
      lastRowId: 1,
      lastSeq: 0,
      epoch: null,
      updatedAt: 1
    })

    const { gateway, controller } = setup({ cache })
    const paints: string[] = []

    gateway.reply('session.history', () => {
      paints.push(chatOf().hydration)

      return { count: 0, messages: [] }
    })

    await controller.openChat(RESEARCHER)

    // The cached item was on screen while the gateway was still being asked,
    // and reconciliation kept its id rather than remounting the thread.
    expect(paints).toEqual(['hydrating'])
    expect(chatOf().items.c1).toBeDefined()
  })

  it('opens once when two taps land together', async () => {
    const { gateway, controller } = setup()

    await Promise.all([controller.openChat(RESEARCHER), controller.openChat(RESEARCHER)])

    expect(gateway.calls.filter(call => call.method === 'session.resume')).toHaveLength(1)
  })

  it('adopts the replay watermark on a cold open without re-applying the events', async () => {
    const { gateway, controller } = setup()

    gateway.reply('session.events.since', {
      events: [{ type: 'message.delta', session_id: 'runtime-1', seq: 6, payload: { text: 'replayed' } }],
      latest_seq: 7,
      truncated: false,
      count: 1,
      epoch: 'e1',
      open_requests: []
    })

    await controller.openChat(RESEARCHER)

    expect(chatOf().lastSeq).toBe(7)
    expect(JSON.stringify(chatOf().items)).not.toContain('replayed')
  })
})

describe('routing live traffic', () => {
  it('sends an event to the chat that owns its runtime session and nowhere else', async () => {
    const { gateway, controller } = setup()

    controller.start()
    await controller.openChat(RESEARCHER)

    gateway.emit({ type: 'message.delta', session_id: 'runtime-1', seq: 8, payload: { text: 'streamed' } })
    gateway.emit({ type: 'message.delta', session_id: 'runtime-unknown', seq: 9, payload: { text: 'nobody' } })

    expect(JSON.stringify(chatOf().items)).toContain('streamed')
    expect(JSON.stringify(chatOf().items)).not.toContain('nobody')
  })

  it('drops the runtime id and marks the chat stale when the session is reclaimed', async () => {
    const { gateway, controller } = setup()

    controller.start()
    await controller.openChat(RESEARCHER)

    gateway.emit({ type: 'session.reclaimed', session_id: 'runtime-1', seq: 9, payload: { reason: 'taken over' } })

    expect(chatOf().runtimeSessionId).toBeUndefined()
    expect(chatOf().hydration).toBe('stale')
    expect(useChatsStore.getState().runtimeToBot).toEqual({})
  })
})

describe('a foreign turn', () => {
  it('stands a placeholder in and fills it from a tail fetch', async () => {
    const { gateway, controller } = setup()

    controller.start()
    await controller.openChat(RESEARCHER)

    gateway.restMessages = [
      ...HISTORY,
      { role: 'user', text: 'Message from 🤖 Writer (@writer): the draft is ready.', row_id: 3 },
      { role: 'assistant', text: 'Noted.', row_id: 4 }
    ]

    // Nobody submitted locally, so this turn belongs to somebody else.
    gateway.emit({ type: 'message.start', session_id: 'runtime-1', seq: 10, payload: {} })

    const placeholder = chatOf()
      .order.map(id => chatOf().items[id])
      .find(item => item?.kind === 'user' && item.unknownAuthor)

    expect(placeholder).toBeDefined()
    expect(chatOf().turn.foreignReconcilePending).toBe(true)

    gateway.emit({ type: 'message.complete', session_id: 'runtime-1', seq: 11, payload: { text: 'Noted.' } })
    await flush()

    const kinds = chatOf().order.map(id => chatOf().items[id]?.kind)

    expect(kinds).toContain('bot_dm_in')
    expect(
      chatOf()
        .order.map(id => chatOf().items[id])
        .some(item => item?.kind === 'user' && item.unknownAuthor)
    ).toBe(false)
  })

  /**
   * The owner's report: a message he sent on his phone was not in the chat on
   * his Mac.
   *
   * `message.start` carries no author, so the second device stands an empty
   * `unknownAuthor` bubble in and waits to be told who spoke — and nothing on
   * the socket ever tells it, because the deltas that follow are the REPLY. The
   * only frame that used to fill the placeholder was `message.complete`, and the
   * sweep that could have filled it earlier skipped every chat that was mid-turn.
   * So for the whole of a turn the other device's message was not in the
   * transcript, and an empty placeholder draws nothing (`selectors.ts`), so there
   * was not even a gap to explain it.
   */
  it('a turn started on another device shows its user message here', async () => {
    jest.useFakeTimers()

    try {
      const { gateway, controller } = setup()

      controller.start()
      await controller.openChat(RESEARCHER)

      // Mid-turn the gateway has written the PROMPT and nothing else: the reply
      // is still arriving on the socket.
      gateway.restMessages = [...HISTORY, { role: 'user', text: 'Sent from the phone.', row_id: 3 }]

      gateway.emit({ type: 'message.start', session_id: 'runtime-1', seq: 10, payload: {} })
      gateway.emit({ type: 'message.delta', session_id: 'runtime-1', seq: 11, payload: { text: 'Looking…' } })
      gateway.emit({ type: 'sessions.changed', payload: {} })

      jest.advanceTimersByTime(600)
      await flushFakeTimers()

      const items = chatOf().order.map(id => chatOf().items[id])

      // The prompt is there, above the reply that is still streaming, and the
      // placeholder it filled is gone rather than left standing beside it.
      expect(items.map(item => `${item?.kind}:${(item as { text?: string } | undefined)?.text ?? ''}`)).toEqual([
        'user:Introduce yourself.',
        'assistant:I am researcher.',
        'user:Sent from the phone.',
        'assistant:Looking…'
      ])
      expect(items.some(item => item?.kind === 'user' && item.unknownAuthor)).toBe(false)
      expect(chatOf().turn.active).toBe(true)
    } finally {
      jest.useRealTimers()
    }
  })

  it('reconciles every live chat on a debounced sessions.changed, but not one mid-turn', async () => {
    jest.useFakeTimers()

    try {
      const { gateway, controller } = setup()

      controller.start()
      await controller.openChat(RESEARCHER)

      gateway.restMessages = HISTORY
      gateway.emit({ type: 'sessions.changed', payload: {} })
      gateway.emit({ type: 'sessions.changed', payload: {} })
      gateway.emit({ type: 'sessions.changed', payload: {} })

      expect(gateway.restCalls).toHaveLength(0)

      jest.advanceTimersByTime(600)
      await flushFakeTimers()

      // Three broadcasts, one sweep.
      expect(gateway.restCalls).toHaveLength(1)
    } finally {
      jest.useRealTimers()
    }
  })
})

describe('sending', () => {
  it('paints the message, attaches images first and settles on the submit status', async () => {
    const { gateway, controller } = setup()

    gateway.reply('image.attach_bytes', { attached: true }).reply('prompt.submit', { status: 'streaming' })

    controller.start()
    await controller.openChat(RESEARCHER)
    await controller.send('researcher', 'have a look', [{ filename: 'shot.png', base64: 'AAA' }])

    const order = gateway.methodOrder()

    expect(order.indexOf('image.attach_bytes')).toBeLessThan(order.indexOf('prompt.submit'))
    expect(gateway.lastCall('prompt.submit')).toMatchObject({ session_id: 'runtime-1', text: 'have a look' })

    const user = chatOf()
      .order.map(id => chatOf().items[id])
      .find(item => item?.kind === 'user' && item.origin === 'optimistic')

    // A reference, not a display name: `attachments` is the same contract on
    // both sides of the wire, and the gateway appends `@image:<its own path>` to
    // the row it persists. The name is all the client can put in the path
    // position, and the name is what the two sides are compared on.
    expect(user).toMatchObject({ text: 'have a look', pending: false, attachments: ['@image:shot.png'] })
  })

  it('gives the optimistic bubble the reader’s own author, read when the turn begins (HERM-83)', async () => {
    const own: { current?: MessageAuthor } = {}
    const { gateway, controller } = setup({ ownAuthor: () => own.current })

    gateway.reply('prompt.submit', { status: 'streaming' })
    await controller.openChat(RESEARCHER)
    // Read at send time, not at construction: `/api/auth/me` answers later.
    own.current = { id: 'authentik:7f3a9c21', name: 'Alex Moreno' }
    await controller.send('researcher', 'ok')

    const user = chatOf()
      .order.map(id => chatOf().items[id])
      .find(item => item?.kind === 'user' && item.text === 'ok')

    expect(user).toMatchObject({ author: { id: 'authentik:7f3a9c21', name: 'Alex Moreno' } })
  })

  it('begins a turn unattributed while the reader’s own author is unknown', async () => {
    const { gateway, controller } = setup({ ownAuthor: () => undefined })

    gateway.reply('prompt.submit', { status: 'streaming' })
    await controller.openChat(RESEARCHER)
    await controller.send('researcher', 'ok')

    const user = chatOf()
      .order.map(id => chatOf().items[id])
      .find(item => item?.kind === 'user' && item.text === 'ok')

    expect(user && 'author' in user ? user.author : undefined).toBeUndefined()
  })

  it('keeps a queued prompt pending behind the running turn', async () => {
    const { gateway, controller } = setup()

    gateway.reply('prompt.submit', { status: 'queued' })
    await controller.openChat(RESEARCHER)
    await controller.send('researcher', 'and then this')

    expect(chatOf().queued).toEqual({ text: 'and then this', local: true })
  })

  it('stops the turn without throwing away the partial reply', async () => {
    const { gateway, controller } = setup()

    gateway.reply('prompt.submit', { status: 'streaming' }).reply('session.interrupt', { status: 'interrupted' })

    controller.start()
    await controller.openChat(RESEARCHER)
    await controller.send('researcher', 'go')
    gateway.emit({ type: 'message.delta', session_id: 'runtime-1', seq: 12, payload: { text: 'half a th' } })
    await controller.stopTurn('researcher')

    const assistants = chatOf()
      .order.map(id => chatOf().items[id])
      .filter(item => item?.kind === 'assistant')

    expect(assistants[assistants.length - 1]).toMatchObject({
      text: 'half a th',
      status: 'interrupted',
      streaming: false
    })
    expect(chatOf().turn.active).toBe(false)
  })
})

/**
 * The queue behind a running turn.
 *
 * `prompt.submit` will park a prompt on the gateway — it answers `queued` — and
 * that is exactly what the client cannot use: the gateway's queue is one opaque
 * prompt with no method to read it back, edit it or take it out. So a message
 * sent mid-turn is held HERE, drawn in the transcript as the reader's own
 * bubble, and submitted when the turn that was running finishes.
 */
describe('the queue behind a running turn', () => {
  const queueOf = (name = 'researcher') => useChatsStore.getState().queues[name] ?? []

  /** Open a chat and leave a turn running in it. */
  async function busy() {
    const kit = setup()

    kit.gateway.reply('prompt.submit', { status: 'streaming' })
    kit.controller.start()
    await kit.controller.openChat(RESEARCHER)
    await kit.controller.send('researcher', 'go')

    expect(chatOf().turn.active).toBe(true)

    return kit
  }

  const complete = (gateway: FakeChatGateway, seq: number) =>
    gateway.emit({ type: 'message.complete', session_id: 'runtime-1', seq, payload: {} })

  it('parks a message rather than submitting it, and submits it when the turn ends', async () => {
    const { gateway, controller } = await busy()
    const before = gateway.methodOrder().filter(method => method === 'prompt.submit').length

    await controller.send('researcher', 'and one more thing')

    // Nothing went to the gateway…
    expect(gateway.methodOrder().filter(method => method === 'prompt.submit')).toHaveLength(before)
    expect(queueOf()).toEqual([expect.objectContaining({ text: 'and one more thing' })])

    // …until the running turn finished.
    complete(gateway, 20)
    await Promise.resolve()
    await Promise.resolve()

    expect(gateway.lastCall('prompt.submit')).toMatchObject({ text: 'and one more thing' })
    expect(queueOf()).toEqual([])
  })

  it('sends several in the order they were written, one turn at a time', async () => {
    const { gateway, controller } = await busy()

    await controller.send('researcher', 'first')
    await controller.send('researcher', 'second')

    expect(queueOf().map(entry => entry.text)).toEqual(['first', 'second'])

    complete(gateway, 21)
    await Promise.resolve()
    await Promise.resolve()

    expect(gateway.lastCall('prompt.submit')).toMatchObject({ text: 'first' })
    // The second is still parked: it goes out after the reply to the first.
    expect(queueOf().map(entry => entry.text)).toEqual(['second'])

    complete(gateway, 22)
    await Promise.resolve()
    await Promise.resolve()

    expect(gateway.lastCall('prompt.submit')).toMatchObject({ text: 'second' })
    expect(queueOf()).toEqual([])
  })

  it('hands a parked message back for editing, and takes it out of the queue', async () => {
    const { controller } = await busy()

    await controller.send('researcher', 'wait, I meant')

    const id = queueOf()[0]!.id

    expect(controller.editQueued('researcher', id)).toBe('wait, I meant')
    expect(queueOf()).toEqual([])
    // A second attempt has nothing to hand back.
    expect(controller.editQueued('researcher', id)).toBeUndefined()
  })

  it('deletes one without sending anything', async () => {
    const { gateway, controller } = await busy()
    const before = gateway.methodOrder().filter(method => method === 'prompt.submit').length

    await controller.send('researcher', 'never mind')
    controller.deleteQueued('researcher', queueOf()[0]!.id)

    expect(queueOf()).toEqual([])

    // And the turn ending finds nothing to submit.
    complete(gateway, 23)
    await Promise.resolve()
    await Promise.resolve()

    expect(gateway.methodOrder().filter(method => method === 'prompt.submit')).toHaveLength(before)
  })

  it('steers one into the turn that is running, through session.steer', async () => {
    const { gateway, controller } = await busy()

    gateway.reply('session.steer', { status: 'queued', text: 'use the cached copy' })

    await controller.send('researcher', 'use the cached copy')
    const status = await controller.steerQueued('researcher', queueOf()[0]!.id)

    expect(status).toBe('queued')
    expect(gateway.lastCall('session.steer')).toMatchObject({
      session_id: 'runtime-1',
      text: 'use the cached copy'
    })
    expect(queueOf()).toEqual([])
  })

  it('puts a rejected steer back in the queue rather than losing it', async () => {
    // `session.steer` answers `rejected` when the turn is past its final tool
    // batch: there is nothing left to hand the text to. The message has not been
    // sent anywhere, so it goes back to where it was.
    const { gateway, controller } = await busy()

    gateway.reply('session.steer', { status: 'rejected', text: 'too late' })

    await controller.send('researcher', 'too late')

    expect(await controller.steerQueued('researcher', queueOf()[0]!.id)).toBe('rejected')
    expect(queueOf()).toEqual([expect.objectContaining({ text: 'too late' })])
  })

  /*
    Build 176: pressing Steer emptied the strip and put nothing on screen.

    The words left the only place they were visible and arrived nowhere, so the
    three tests below are about the BUBBLE rather than about the RPC — the RPC
    was always correct.
  */
  const steeredBubbles = (name = 'researcher') =>
    Object.values(chatOf(name).items).filter(
      (item): item is UserItem => item.kind === 'user' && item.displayKind === 'steer'
    )

  it('paints the steered message as a bubble instead of letting it vanish', async () => {
    const { gateway, controller } = await busy()

    gateway.reply('session.steer', { status: 'queued', text: 'use the cached copy' })

    await controller.send('researcher', 'use the cached copy')
    await controller.steerQueued('researcher', queueOf()[0]!.id)

    expect(steeredBubbles()).toEqual([
      expect.objectContaining({ kind: 'user', text: 'use the cached copy', displayKind: 'steer', origin: 'optimistic' })
    ])
    // It is not `pending`: pending means "parked behind the running turn", which
    // is what the strip already said and what this message stopped being.
    expect(steeredBubbles()[0]).not.toHaveProperty('pending', true)
  })

  it('does not claim the turn — a steer is folded into the one already running', async () => {
    const { gateway, controller } = await busy()
    const before = chatOf().turn

    gateway.reply('session.steer', { status: 'queued', text: 'narrower, please' })

    await controller.send('researcher', 'narrower, please')
    await controller.steerQueued('researcher', queueOf()[0]!.id)

    const after = chatOf().turn

    expect(after.active).toBe(before.active)
    expect(after.startedAt).toBe(before.startedAt)
    expect(after.local).toBe(before.local)
  })

  it('takes the bubble back off when the steer is refused', async () => {
    const { gateway, controller } = await busy()

    gateway.reply('session.steer', { status: 'rejected', text: 'too late' })

    await controller.send('researcher', 'too late')
    await controller.steerQueued('researcher', queueOf()[0]!.id)

    // Back in the strip, and NOT also on screen: one message, one place.
    expect(queueOf()).toEqual([expect.objectContaining({ text: 'too late' })])
    expect(steeredBubbles()).toEqual([])
  })

  it('takes the bubble back off when the steer RPC throws, and rethrows', async () => {
    const { gateway, controller } = await busy()

    gateway.reply('session.steer', () => {
      throw new Error('socket closed')
    })

    await controller.send('researcher', 'mid-flight')

    await expect(controller.steerQueued('researcher', queueOf()[0]!.id)).rejects.toThrow('socket closed')
    expect(queueOf()).toEqual([expect.objectContaining({ text: 'mid-flight' })])
    expect(steeredBubbles()).toEqual([])
  })
})

describe('approvals', () => {
  it('acknowledges the card, then answers the request the agent is waiting on', async () => {
    const { gateway, controller } = setup()

    controller.start()
    await controller.openChat(RESEARCHER)

    const delivered = gateway.serverRequest('srq-9', 'approval', {
      session_id: 'runtime-1',
      request_id: 'appr-1',
      command: 'rm -rf build',
      choices: ['once', 'deny']
    })

    expect(delivered.accepted).toBe(true)
    await flush()
    expect(gateway.lastCall('approval.received')).toEqual({ session_id: 'runtime-1', request_id: 'appr-1' })

    await controller.respondApproval('researcher', 'srq-9', 'once')

    expect(delivered.answer()).toEqual({ choice: 'once' })
    // Answering the request IS the answer; no second RPC goes out.
    expect(gateway.methodOrder()).not.toContain('approval.respond')

    const item = chatOf().items[chatOf().byRequestId['srq-9'] ?? '']

    expect(item).toMatchObject({ state: 'answered', answer: 'once' })
  })

  it('answers a queue entry with no request behind it through approval.respond', async () => {
    const { gateway, controller } = setup()

    // `pending_approval` is a queue entry the resume reports, not a request the
    // socket carried: there is no reply frame anywhere to answer it on.
    gateway.reply('session.resume', {
      session_id: 'runtime-1',
      stored_session_id: 'tip-researcher',
      message_count: 2,
      messages: [],
      info: { desktop_contract: 7 },
      pending_approval: { request_id: 'appr-7', command: 'rm -rf build', choices: ['once', 'deny'] },
      open_requests: []
    })
    gateway.reply('approval.respond', { resolved: 1 })

    controller.start()
    await controller.openChat(RESEARCHER)

    expect(chatOf().byRequestId['pending:appr-7']).toBeDefined()

    await controller.respondApproval('researcher', 'pending:appr-7', 'deny')

    expect(gateway.lastCall('approval.respond')).toMatchObject({
      session_id: 'runtime-1',
      choice: 'deny',
      request_id: 'appr-7'
    })
  })

  it('declines a method it has no surface for, so the agent is not parked', async () => {
    const { gateway, controller } = setup()

    controller.start()
    await controller.openChat(RESEARCHER)

    // Sudo, secret, vault, preview, terminal — nothing here can answer them,
    // and -32601 is the honest reply.
    expect(gateway.serverRequest('srq-y', 'sudo', { session_id: 'runtime-1' }).accepted).toBe(false)
    expect(gateway.declined.map(entry => entry.method)).toEqual(['sudo'])
  })

  it('holds an approval for a session it has not bound yet instead of declining it', async () => {
    const { gateway, controller } = setup()

    controller.start()
    await controller.openChat(RESEARCHER)

    // Declining would not read as "not mine": the gateway takes -32601 to mean
    // the client cannot answer approvals at all and WITHDRAWS the question.
    expect(gateway.serverRequest('srq-x', 'approval', { session_id: 'runtime-later' }).accepted).toBe(true)
    expect(gateway.declined).toHaveLength(0)

    // The first ready of the process is not a reconnect.
    gateway.status('ready')
    await flush()

    gateway.reply('session.resume', {
      session_id: 'runtime-later',
      stored_session_id: 'tip-researcher',
      message_count: 2,
      messages: [],
      info: { desktop_contract: 7 },
      open_requests: []
    })
    gateway.status('reconnecting')
    gateway.status('ready')
    await flush()

    expect(chatOf().byRequestId['srq-x']).toBeDefined()
  })

  it('takes the open requests a resume replays before it resolves', async () => {
    const { gateway, controller } = setup()

    // Exactly what the channel does: the requests reach the handlers a tick
    // before anything can know which bot owns the session they name.
    gateway.reply('session.resume', {
      session_id: 'runtime-1',
      stored_session_id: 'tip-researcher',
      message_count: 2,
      messages: [],
      info: { desktop_contract: 7 },
      open_requests: [
        {
          id: 'srq-inherited',
          method: 'approval',
          params: { session_id: 'runtime-1', request_id: 'appr-2', command: 'rm -rf build', choices: ['once', 'deny'] }
        }
      ]
    })

    controller.start()
    await controller.openChat(RESEARCHER)

    expect(gateway.declined).toHaveLength(0)

    const item = chatOf().items[chatOf().byRequestId['srq-inherited'] ?? '']

    expect(item).toMatchObject({ kind: 'approval', approvalId: 'appr-2', state: 'open' })

    // And the reply handle survived the parking, so the card answers the
    // request itself rather than going out as a second RPC.
    await controller.respondApproval('researcher', 'srq-inherited', 'deny')

    expect(gateway.answerFor('srq-inherited')).toEqual({ choice: 'deny' })
    expect(gateway.methodOrder()).not.toContain('approval.respond')
  })

  it('shows one card when the pending poll reports an approval already on screen', async () => {
    const { gateway, controller } = setup()

    controller.start()
    await controller.openChat(RESEARCHER)
    gateway.serverRequest('srq-9', 'approval', {
      session_id: 'runtime-1',
      request_id: 'appr-1',
      command: 'rm -rf build'
    })

    gateway.reply('approval.pending', {
      approvals: [{ request_id: 'appr-1', command: 'rm -rf build', choices: ['once', 'deny'] }]
    })

    await controller.onForeground()

    const approvals = chatOf()
      .order.map(id => chatOf().items[id])
      .filter(item => item?.kind === 'approval')

    expect(approvals).toHaveLength(1)
    expect(approvals[0]).toMatchObject({ requestId: 'srq-9', approvalId: 'appr-1' })
  })

  it('forgets the handles behind a card the gateway withdraws', async () => {
    const { gateway, controller } = setup()

    controller.start()
    await controller.openChat(RESEARCHER)
    gateway.serverRequest('srq-9', 'approval', {
      session_id: 'runtime-1',
      request_id: 'appr-1',
      command: 'rm -rf build'
    })
    await flush()

    gateway.emit({
      type: 'request.cancel',
      session_id: 'runtime-1',
      seq: 30,
      payload: { id: 'srq-9', method: 'approval', reason: 'timeout' }
    })

    expect(chatOf().items[chatOf().byRequestId['srq-9'] ?? '']).toMatchObject({ state: 'cancelled' })

    // The handle is gone, so answering the dead card cannot resolve a request
    // that no longer exists; it falls through to the queue instead.
    gateway.reply('approval.respond', { resolved: 0 })
    await controller.respondApproval('researcher', 'srq-9', 'once')

    expect(gateway.lastCall('approval.respond')).toMatchObject({ request_id: 'appr-1' })
  })
})

describe('clarify', () => {
  it('answers a replayed single-question clarify through request.answer', async () => {
    const { gateway, controller } = setup()

    gateway.reply('request.answer', { status: 'ok' })
    controller.start()
    await controller.openChat(RESEARCHER)

    // No live reply frame behind it, and `clarify.lock` is batch-only upstream:
    // it reports `expired` for a single question and the agent keeps waiting.
    useChatsStore.getState().dispatchServerRequest('researcher', {
      id: 'srq-clar',
      method: 'clarify',
      params: { session_id: 'runtime-1', request_id: 'c1', question: 'Which branch?' },
      replayed: true
    })

    await controller.respondClarify('researcher', 'srq-clar', { c1: 'main' })

    expect(gateway.methodOrder()).not.toContain('clarify.lock')
    expect(gateway.lastCall('request.answer')).toEqual({
      id: 'srq-clar',
      result: { answer: 'main' },
      profile: 'researcher'
    })
  })

  it('locks a batch clarify question by question while it is incomplete', async () => {
    const { gateway, controller } = setup()

    gateway.reply('clarify.lock', { status: 'ok', remaining: ['q2'] })
    controller.start()
    await controller.openChat(RESEARCHER)
    gateway.serverRequest('srq-batch', 'clarify', {
      session_id: 'runtime-1',
      questions: [
        { qid: 'q1', question: 'Which cluster?' },
        { qid: 'q2', question: 'Which branch?' }
      ]
    })

    await controller.respondClarify('researcher', 'srq-batch', { q1: 'staging' })

    expect(gateway.lastCall('clarify.lock')).toMatchObject({ request_id: 'srq-batch', question_id: 'q1' })
  })

  it('answers a live batch clarify on its own reply frame', async () => {
    const { gateway, controller } = setup()

    controller.start()
    await controller.openChat(RESEARCHER)

    const delivered = gateway.serverRequest('srq-batch', 'clarify', {
      session_id: 'runtime-1',
      questions: [{ qid: 'q1', question: 'Which cluster?' }]
    })

    await controller.respondClarify('researcher', 'srq-batch', { q1: 'staging' })

    expect(delivered.answer()).toEqual({ answers: { q1: 'staging' } })
  })
})

describe('reconnecting', () => {
  it('ignores the first ready and re-applies snapshots on the next one', async () => {
    const { gateway, controller } = setup()

    controller.start()
    await controller.openChat(RESEARCHER)

    gateway.status('ready')
    await flush()

    const afterFirst = gateway.calls.filter(call => call.method === 'session.resume').length

    expect(afterFirst).toBe(1)

    gateway.reply('session.resume', {
      session_id: 'runtime-2',
      stored_session_id: 'tip-researcher',
      message_count: 2,
      messages: [],
      info: { desktop_contract: 7 },
      open_requests: []
    })
    gateway.status('reconnecting')
    gateway.status('ready')
    await flush()

    expect(gateway.calls.filter(call => call.method === 'session.resume')).toHaveLength(2)
    expect(chatOf().runtimeSessionId).toBe('runtime-2')
    expect(useChatsStore.getState().runtimeToBot).toEqual({ 'runtime-2': 'researcher' })
  })

  it('refetches the tail only when the roster says rows were written while we were away', async () => {
    const { gateway, controller } = setup()

    controller.start()
    await controller.openChat(RESEARCHER)
    gateway.status('ready')
    await flush()

    gateway.restMessages = HISTORY
    gateway.reply('profiles.list', {
      profiles: [
        {
          name: 'researcher',
          path: '/p',
          canonical_session: { id: 'stored-researcher', resolved_id: 'tip-researcher', message_count: 40 }
        }
      ]
    })

    gateway.status('reconnecting')
    gateway.status('ready')
    await flush()

    expect(gateway.restCalls.some(call => call.limit === 30)).toBe(true)
  })
})

describe('the event watermark', () => {
  it('starts over when the gateway rebuilds the session under a new id', async () => {
    const { gateway, controller } = setup()

    controller.start()
    await controller.openChat(RESEARCHER)
    gateway.emit({ type: 'message.delta', session_id: 'runtime-1', seq: 41, payload: { text: 'a' } })

    expect(chatOf().lastSeq).toBe(41)

    // A rebuilt session numbers its events from 1 again. Carrying 41 over
    // would make the reducer drop the first forty of them as replay.
    gateway.status('ready')
    await flush()
    gateway.reply('session.resume', {
      session_id: 'runtime-2',
      stored_session_id: 'tip-researcher',
      message_count: 2,
      messages: [],
      info: { desktop_contract: 7 },
      open_requests: []
    })
    gateway.reply('session.events.since', {
      events: [],
      latest_seq: 3,
      truncated: false,
      count: 0,
      epoch: 'e1',
      open_requests: []
    })
    gateway.status('reconnecting')
    gateway.status('ready')
    await flush()

    expect(gateway.lastCall('session.events.since')).toMatchObject({ session_id: 'runtime-2', last_seen: 0 })
    expect(chatOf().lastSeqSessionId).toBe('runtime-2')

    gateway.emit({ type: 'message.delta', session_id: 'runtime-2', seq: 4, payload: { text: 'kept' } })

    expect(JSON.stringify(chatOf().items)).toContain('kept')
  })

  it('goes cold when the replay epoch says the gateway restarted', async () => {
    const { gateway, controller } = setup()

    controller.start()
    await controller.openChat(RESEARCHER)

    expect(chatOf().epoch).toBe('e1')

    gateway.emit({ type: 'message.delta', session_id: 'runtime-1', seq: 9, payload: { text: 'before' } })

    expect(chatOf().lastSeq).toBe(9)

    gateway.reply('session.events.since', {
      // A restarted gateway numbers from 1 again, so its `latest_seq` is BELOW
      // the watermark we hold and its events describe a different sequence.
      events: [{ type: 'message.delta', session_id: 'runtime-1', seq: 2, payload: { text: 'replayed' } }],
      latest_seq: 2,
      truncated: false,
      count: 1,
      epoch: 'e2',
      open_requests: []
    })

    // The same runtime id comes back, so nothing else says the numbering moved.
    gateway.status('ready')
    await flush()
    gateway.status('reconnecting')
    gateway.status('ready')
    await flush()

    expect(chatOf().epoch).toBe('e2')
    expect(chatOf().lastSeq).toBe(2)
    expect(JSON.stringify(chatOf().items)).not.toContain('replayed')
  })

  it('refuses a resume that comes back without a session id', async () => {
    const { gateway, controller } = setup()

    gateway.reply('session.resume', {
      session_id: '',
      message_count: 0,
      messages: [],
      info: { desktop_contract: 7 }
    })

    await expect(controller.openChat(RESEARCHER)).rejects.toThrow(/without a session id/)
    expect(chatOf().hydration).toBe('error')
  })
})

describe('chat options', () => {
  it('scopes yolo to this session rather than rewriting the gateway configuration', async () => {
    const { gateway, controller } = setup()

    gateway.reply('config.set', {
      key: 'yolo',
      value: 'on',
      scope: 'session',
      info: { desktop_contract: 7, yolo: true }
    })

    await controller.openChat(RESEARCHER)
    await controller.setOption('researcher', 'yolo', 'on')

    expect(gateway.lastCall('config.set')).toMatchObject({
      key: 'yolo',
      value: 'on',
      session_id: 'runtime-1',
      scope: 'session'
    })
  })

  it('reads the options back without resuming the session', async () => {
    const { gateway, controller } = setup()

    gateway.reply('config.set', { key: 'yolo', value: 'on' }).reply('config.get', params => {
      const key = String(params.key)

      return { value: key === 'model' ? 'example-provider/fast' : key === 'yolo' ? 'on' : '' }
    })

    controller.start()
    await controller.openChat(RESEARCHER)
    gateway.emit({
      type: 'session.info',
      session_id: 'runtime-1',
      seq: 30,
      payload: { desktop_contract: 7, model: 'example-provider/example-model', cwd: '/work' }
    })

    const resumesBefore = gateway.calls.filter(call => call.method === 'session.resume').length

    // `config.set` answered with no `info`, so the sheet re-reads the values.
    await controller.setOption('researcher', 'yolo', 'on')

    // Resuming is a write: it mints a new runtime id and rebuilds the agent.
    expect(gateway.calls.filter(call => call.method === 'session.resume')).toHaveLength(resumesBefore)
    expect(gateway.lastCall('config.get')).toMatchObject({ session_id: 'runtime-1', profile: 'researcher' })
    // The four keys land on top of what the session already reported rather
    // than in place of it: `session.info` replaces the whole record.
    expect(chatOf().info).toMatchObject({
      yolo: true,
      model: 'example-provider/fast',
      desktop_contract: 7,
      cwd: '/work'
    })
  })

  it('forgets the slash catalogue of a session that has been replaced', async () => {
    const { gateway, controller } = setup()

    gateway
      .reply('commands.catalog', { pairs: [['/model', 'Switch the model']] })
      .reply('complete.slash', { items: [] })

    controller.start()
    await controller.openChat(RESEARCHER)
    await controller.querySlash('researcher', '/mo')

    expect(controller.slashCatalog('researcher')).toBeDefined()

    gateway.status('ready')
    await flush()
    gateway.reply('session.resume', {
      session_id: 'runtime-2',
      stored_session_id: 'tip-researcher',
      message_count: 2,
      messages: [],
      info: { desktop_contract: 7 },
      open_requests: []
    })
    gateway.status('reconnecting')
    gateway.status('ready')
    await flush()

    // The catalogue belongs to the session that is gone, not to the bot.
    expect(controller.slashCatalog('researcher')).toBeUndefined()
  })

  it('hands an expensive-model confirmation back instead of confirming it', async () => {
    const { gateway, controller } = setup()

    gateway.reply('config.set', {
      key: 'model',
      value: 'expensive',
      confirm_required: true,
      confirm_message: 'That model is expensive.'
    })

    await controller.openChat(RESEARCHER)

    const result = await controller.setOption('researcher', 'model', 'expensive')

    expect(result).toEqual({ confirmRequired: true, confirmMessage: 'That model is expensive.' })
    expect(gateway.lastCall('config.set')).not.toHaveProperty('confirm_expensive_model')
  })
})

describe('slash commands', () => {
  it('fetches the catalogue once per session and completes per keystroke', async () => {
    const { gateway, controller } = setup()

    gateway.reply('commands.catalog', { pairs: [['/model', 'Switch the model']] }).reply('complete.slash', {
      items: [{ text: '/model' }]
    })

    await controller.openChat(RESEARCHER)
    await controller.querySlash('researcher', '/mo')
    await controller.querySlash('researcher', '/mod')

    expect(gateway.calls.filter(call => call.method === 'commands.catalog')).toHaveLength(1)
    expect(gateway.calls.filter(call => call.method === 'complete.slash')).toHaveLength(2)
  })

  /**
   * A refused completion call is a FACT the popover can draw, not a silence.
   *
   * The report this closes: on the owner's phone, against his real gateway,
   * typing `/` showed nothing, while the same build showed the list on the web
   * and on the simulator. Both calls were inside a `catch` that answered
   * `{ items: [] }`, which is indistinguishable from a gateway that simply has
   * no commands — so the app had recorded the refusal in the developer
   * screen's ring and told the reader nothing at all.
   */
  it('drops session_id from complete.slash after an older gateway refuses it, and stays without', async () => {
    const { gateway, controller } = setup()
    const refusal =
      '{"code":4000,"message":"invalid params for complete.slash: session_id: Extra inputs are not permitted — the client and the Hermes backend are out of sync (different versions); run `hermes update` and restart both"}'

    gateway.reply('commands.catalog', { pairs: [['/new', 'Start a new session']] }).reply('complete.slash', params => {
      // Hermes 0.21.3: `CompleteSlashParams` is `text` alone, validated with extra="forbid".
      if ('session_id' in params) {
        throw new Error(refusal)
      }

      return { items: [{ text: 'new', meta: 'Start a new session' }], replace_from: 1 }
    })

    await controller.openChat(RESEARCHER)

    expect(await controller.querySlash('researcher', '/ne')).toEqual({
      items: [{ text: 'new', meta: 'Start a new session' }],
      replaceFrom: 1
    })
    // Refused once, answered once — and the second query never names the session again.
    await controller.querySlash('researcher', '/new')

    const calls = gateway.calls.filter(call => call.method === 'complete.slash')

    expect(calls).toHaveLength(3)
    expect(calls.map(call => 'session_id' in call.params)).toEqual([true, false, false])
  })

  it('reports a refused complete.slash as a failure rather than an empty list', async () => {
    const { gateway, controller } = setup()

    gateway.reply('commands.catalog', { pairs: [['/model', 'Switch the model']] }).reply('complete.slash', () => {
      // The shape the real channel rejects with: the serialized JSON-RPC error.
      throw new Error('{"code":4018,"message":"skill command: use command.dispatch for /docx"}')
    })

    await controller.openChat(RESEARCHER)

    expect(await controller.querySlash('researcher', '/do')).toEqual({
      items: [],
      failure: { method: 'complete.slash', reason: '4018 skill command: use command.dispatch for /docx' }
    })
  })

  it('reports a timed-out complete.slash, which carries no code at all', async () => {
    const { gateway, controller } = setup()

    gateway.reply('commands.catalog', {}).reply('complete.slash', () => {
      // A transport failure, not a refusal: there was nobody to send a code.
      throw new Error('Timed out after 10000ms')
    })

    await controller.openChat(RESEARCHER)

    expect(await controller.querySlash('researcher', '/mo')).toEqual({
      items: [],
      failure: { method: 'complete.slash', reason: 'Timed out after 10000ms' }
    })
  })

  it('names the catalogue when that is the call that refused, and still paints the items', async () => {
    // The state that makes the list LOOK fine and Return do the wrong thing:
    // `complete.slash` answers from the session, but `knowsSlashCommand` routes
    // on the catalogue, so without it an accepted suggestion goes out as prose.
    const { gateway, controller } = setup()

    gateway
      .reply('commands.catalog', () => {
        throw new Error('{"code":5030,"message":"worker exited"}')
      })
      .reply('complete.slash', { items: [{ text: '/model' }] })

    await controller.openChat(RESEARCHER)

    expect(await controller.querySlash('researcher', '/mo')).toEqual({
      items: [{ text: '/model' }],
      failure: { method: 'commands.catalog', reason: '5030 worker exited' }
    })
    expect(controller.knowsSlashCommand('researcher', 'model')).toBe(false)
  })

  it('clears the failure on the next answer that works', async () => {
    const { gateway, controller } = setup()

    gateway.reply('commands.catalog', {}).reply('complete.slash', () => {
      throw new Error('{"code":5030,"message":"worker exited"}')
    })

    await controller.openChat(RESEARCHER)
    expect(await controller.querySlash('researcher', '/mo')).toHaveProperty('failure')

    gateway.reply('complete.slash', { items: [{ text: '/model' }] })

    expect(await controller.querySlash('researcher', '/mo')).toEqual({ items: [{ text: '/model' }] })
  })

  it('still records the refusal in the developer ring', async () => {
    // The ring is not replaced by the visible row: it is the thing that carries
    // every absorbed refusal in the session, and the row is about the last
    // answer to the line in front of the caret.
    const failures: RpcFailure[] = []
    const { gateway, controller } = setup({ onRpcFailure: failure => failures.push(failure) })

    gateway.reply('commands.catalog', {}).reply('complete.slash', () => {
      throw new Error('{"code":4018,"message":"nope"}')
    })

    await controller.openChat(RESEARCHER)
    await controller.querySlash('researcher', '/mo')

    expect(failures).toEqual([expect.objectContaining({ method: 'complete.slash', code: 4018, message: 'nope' })])
  })

  it('answers from the catalogue which names are commands and which are prose', async () => {
    const { gateway, controller } = setup()

    gateway
      .reply('commands.catalog', {
        pairs: [['/model', 'Switch the model']],
        canon: { compact: 'compact' },
        skills: { work: { usage: 2 } }
      })
      .reply('complete.slash', { items: [] })

    await controller.openChat(RESEARCHER)

    // Nothing has been fetched yet, so nothing is a command yet — which is the
    // safe answer: the line goes out as an ordinary prompt.
    expect(controller.knowsSlashCommand('researcher', 'model')).toBe(false)

    await controller.querySlash('researcher', '/mo')

    // A name, an alias and a skill are all things the gateway will run.
    expect(controller.knowsSlashCommand('researcher', 'model')).toBe(true)
    expect(controller.knowsSlashCommand('researcher', 'Model')).toBe(true)
    expect(controller.knowsSlashCommand('researcher', 'compact')).toBe(true)
    expect(controller.knowsSlashCommand('researcher', 'work')).toBe(true)

    // And a path is not.
    expect(controller.knowsSlashCommand('researcher', 'usr')).toBe(false)
    expect(controller.knowsSlashCommand('researcher', '')).toBe(false)
  })

  it('reports the column an accepted completion replaces from', async () => {
    // One call completes both halves: the command name while there is no
    // argument, and the argument once there is one. `replace_from` is how the
    // gateway says which.
    const { gateway, controller } = setup()

    gateway
      .reply('commands.catalog', {})
      .reply('complete.slash', { items: [{ text: 'example-large' }], replace_from: 7 })

    await controller.openChat(RESEARCHER)

    expect(await controller.querySlash('researcher', '/model exa')).toEqual({
      items: [{ text: 'example-large' }],
      replaceFrom: 7
    })
    expect(gateway.lastCall('complete.slash')).toMatchObject({ text: '/model exa' })
  })

  /**
   * One shape for every answer: the command typed is the title, the answer is
   * the body, and the kind is `command`.
   *
   * The kind is what carries the two fixes the owner asked for — the row
   * survives `quiet`, which is the level the app ships on, and it opens itself
   * (`selectors.ts`, `NoticePill`). A one-line answer used to go into the TITLE
   * with an empty body, which `NoticePill` then drew with no disclosure at all,
   * so the same command answered in two different shapes depending on how much
   * it had to say.
   */
  it('lands a slash result as a command row: the command titles it, the answer is the body', async () => {
    const { gateway, controller } = setup()

    gateway.reply('slash.exec', { output: 'model is example-model' })

    await controller.openChat(RESEARCHER)
    await controller.runSlash('researcher', '/model')

    const notice = chatOf()
      .order.map(id => chatOf().items[id])
      .find(item => item?.kind === 'notice')

    expect(notice).toMatchObject({ noticeKind: 'command', title: '/model', body: 'model is example-model' })
  })

  /**
   * Measured against `hermes serve` 0.21.3 on 2026-09-21: `/status` answers a
   * ten-line block and `/help` answers two hundred. Both used to be flattened
   * into the notice TITLE with an empty body, and `NoticePill` only offers a
   * disclosure when there IS a body — so the whole report was drawn as one
   * unfoldable run of text. The fake gateway answered every command with a
   * single short line, which is why no test ever saw it.
   */
  it('puts a multi-line command answer in the body, not in the title', async () => {
    const { gateway, controller } = setup()

    gateway.reply('slash.exec', { output: 'Hermes TUI Status\n\nModel: example-model\nTokens: 0' })

    await controller.openChat(RESEARCHER)
    await controller.runSlash('researcher', '/status')

    const notice = chatOf()
      .order.map(id => chatOf().items[id])
      .find(item => item?.kind === 'notice')

    expect(notice).toMatchObject({ noticeKind: 'command', title: '/status' })
    expect((notice as { body?: string }).body).toContain('Tokens: 0')
  })

  /**
   * The refusal that broke the feature on every real gateway. A profile's skills
   * are in `commands.catalog`, so `knowsSlashCommand` says yes to all of them —
   * and `slash.exec` answers every one with
   * `4018 skill command: use command.dispatch for /<name>`.
   */
  it('sends a skill command to command.dispatch rather than to slash.exec', async () => {
    const { gateway, controller } = setup()

    gateway
      .reply('commands.catalog', { pairs: [['/model', 'Switch the model']], skills: { '/docx': { usage: 0 } } })
      .reply('complete.slash', { items: [] })
      .reply('command.dispatch', { type: 'skill', name: 'docx', display: '/docx', message: 'the whole skill body' })
      .reply('prompt.submit', { status: 'streaming' })

    controller.start()
    await controller.openChat(RESEARCHER)
    await controller.querySlash('researcher', '/do')

    expect(controller.slashRouteFor('researcher', 'docx')).toBe('dispatch')
    expect(controller.slashRouteFor('researcher', 'model')).toBe('exec')

    await controller.runSlash('researcher', '/docx')

    expect(gateway.calls.filter(call => call.method === 'slash.exec')).toHaveLength(0)
    expect(gateway.lastCall('command.dispatch')).toMatchObject({ name: 'docx', arg: '' })
    // The expansion is what the gateway is sent; the invocation is what is shown.
    expect(gateway.lastCall('prompt.submit')).toMatchObject({ text: 'the whole skill body' })
    // The LAST user row: this chat opens with two rows of history behind it.
    expect(
      chatOf()
        .order.map(id => chatOf().items[id])
        .filter(item => item?.kind === 'user')
        .at(-1)
    ).toMatchObject({ text: '/docx' })
  })

  /**
   * `slash.exec` hands a rerouted built-in's directive straight back, so its
   * result can carry a `type` and no `output`. `/queue <text>` answers
   * `{type: 'send', message}` on a real gateway; reading `output ?? message`
   * rendered the message as though it were the answer and queued nothing.
   */
  it('acts on a directive rather than rendering the model-facing message', async () => {
    const { gateway, controller } = setup()

    gateway
      .reply('slash.exec', { type: 'send', message: 'write it up', notice: 'Queued.' })
      .reply('prompt.submit', { status: 'streaming' })

    controller.start()
    await controller.openChat(RESEARCHER)
    await controller.runSlash('researcher', '/queue write it up')

    expect(gateway.lastCall('prompt.submit')).toMatchObject({ text: 'write it up' })
    // The gateway's own notice is the command's answer too, so it is titled by
    // the command and not by itself.
    expect(
      chatOf()
        .order.map(id => chatOf().items[id])
        .filter(item => item?.kind === 'notice')
        .map(item => [(item as { title: string }).title, (item as { body?: string }).body])
    ).toContainEqual(['/queue write it up', 'Queued.'])
  })

  it('hands a prefill directive back to the caller instead of to the transcript', async () => {
    const { gateway, controller } = setup()

    gateway.reply('slash.exec', { type: 'prefill', message: 'the message being taken back', notice: '\u21b6 rewound' })

    await controller.openChat(RESEARCHER)

    expect(await controller.runSlash('researcher', '/undo')).toEqual({ prefill: 'the message being taken back' })
  })

  /**
   * One catalogue, however fast the typing. The `has()` check happened before an
   * await, so against a real gateway typing `/model` fired six concurrent
   * catalogue builds; against a fake that answers in the same tick it looked
   * like a cache.
   */
  it('shares one catalogue fetch between the keystrokes that arrive during it', async () => {
    const { gateway, controller } = setup()

    gateway
      .reply('commands.catalog', { pairs: [['/model', 'Switch the model']] })
      .reply('complete.slash', { items: [] })

    await controller.openChat(RESEARCHER)
    await Promise.all(['/m', '/mo', '/mod', '/mode', '/model'].map(typed => controller.querySlash('researcher', typed)))

    expect(gateway.calls.filter(call => call.method === 'commands.catalog')).toHaveLength(1)
  })

  /**
   * A refusal used to be cached as an EMPTY catalogue for the life of the
   * session: one bad answer and `knowsSlashCommand` said no forever, so every
   * `/model` after it went out as an ordinary prompt. That is half of the bug
   * report this test exists for.
   */
  it('retries a catalogue the gateway refused, and records the refusal', async () => {
    const failures: RpcFailure[] = []
    const { gateway, controller } = setup({ onRpcFailure: failure => failures.push(failure) })

    gateway
      .reply('commands.catalog', () => {
        throw new Error('{"code":5020,"message":"skill discovery unavailable"}')
      })
      .reply('complete.slash', { items: [] })

    await controller.openChat(RESEARCHER)
    await controller.querySlash('researcher', '/mo')

    expect(controller.slashCatalog('researcher')).toBeUndefined()
    expect(controller.knowsSlashCommand('researcher', 'model')).toBe(false)
    expect(failures).toMatchObject([{ method: 'commands.catalog', code: 5020 }])

    gateway.reply('commands.catalog', { pairs: [['/model', 'Switch the model']] })
    await controller.querySlash('researcher', '/mod')

    expect(controller.knowsSlashCommand('researcher', 'model')).toBe(true)
    expect(gateway.calls.filter(call => call.method === 'commands.catalog')).toHaveLength(2)
  })
})

describe('the cache', () => {
  it('writes the settled transcript when a turn completes', async () => {
    const { gateway, cache, controller } = setup()

    gateway.reply('prompt.submit', { status: 'streaming' })

    controller.start()
    await controller.openChat(RESEARCHER)
    await controller.send('researcher', 'hello')
    gateway.emit({ type: 'message.complete', session_id: 'runtime-1', seq: 20, payload: { text: 'hi' } })
    await flush()

    const row = await cache!.read('researcher')

    // The reply is in. The user's own bubble is still `optimistic` — the cache
    // deliberately stores only settled transcript — and joins the snapshot once
    // the row comes back from the gateway, which is what the sweep below does.
    expect(row?.itemsJson).toContain('hi')
    expect(row?.itemsJson).not.toContain('hello')
  })

  it("caches the user's own message once the gateway has echoed the row", async () => {
    const { gateway, cache, controller } = setup()

    gateway.reply('prompt.submit', { status: 'streaming' })

    controller.start()
    await controller.openChat(RESEARCHER)
    await controller.send('researcher', 'hello')
    gateway.emit({ type: 'message.complete', session_id: 'runtime-1', seq: 20, payload: { text: 'hi' } })
    await flush()

    gateway.restMessages = [
      ...HISTORY,
      { role: 'user', text: 'hello', row_id: 3 },
      { role: 'assistant', text: 'hi', row_id: 4 }
    ]
    await controller.reconcileTailFor('researcher')
    await controller.persist('researcher')

    await expect(cache!.read('researcher').then(entry => entry?.itemsJson)).resolves.toContain('hello')
  })
})

/** Let every already-resolved promise settle. */
function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

/** The fake-timer equivalent: drain the microtask queue without advancing time. */
async function flushFakeTimers(): Promise<void> {
  for (let round = 0; round < 8; round += 1) {
    await Promise.resolve()
  }
}

/**
 * Older history, one page at a time.
 *
 * The transcript used to be a tail that reconciles and nothing else: one call
 * could re-read the same conversation at the route's 500-row maximum, and that
 * was the floor on how far back anybody could get. These pin the three things
 * paging has to be true of, and the third is the one a bigger window could never
 * satisfy.
 */
describe('reading further back', () => {
  /** A conversation of `count` rows, oldest first, the way the route answers. */
  const conversation = (count: number) =>
    Array.from({ length: count }, (_, at) => ({
      id: at + 1,
      role: at % 2 === 0 ? 'user' : 'assistant',
      content: `row ${at + 1}`,
      timestamp: 1_700_000_000 + at
    }))

  async function openDeepChat(rows: number) {
    const parts = setup()

    parts.gateway.restPages = conversation(rows)
    parts.gateway.reply('session.resume', {
      session_id: 'runtime-1',
      stored_session_id: 'tip-researcher',
      // Past `REST_HISTORY_THRESHOLD`, so the REST transcript is what loads.
      message_count: rows,
      messages: [],
      messages_omitted: true,
      info: { desktop_contract: 7 },
      open_requests: []
    })

    await parts.controller.openChat(RESEARCHER)

    return parts
  }

  it('asks for the page BEFORE the one it holds, and puts it at the front', async () => {
    const { controller, gateway } = await openDeepChat(650)

    const first = chatOf().order.length
    const oldestBefore = chatOf().items[chatOf().order[0] as string]?.rowId

    expect(await controller.loadOlder('researcher')).toBe('grew')

    const paged = gateway.restCalls.filter(call => call.offset !== undefined)

    expect(paged).toHaveLength(1)
    expect(paged[0]).toMatchObject({ limit: 200, offset: 200, order: 'latest' })
    expect(chatOf().order.length).toBeGreaterThan(first)

    // The front of the list moved BACKWARDS. That is the whole difference
    // between a prepend and a re-hydration: nothing below it changed.
    const oldestAfter = chatOf().items[chatOf().order[0] as string]?.rowId

    expect(oldestAfter).toBeLessThan(oldestBefore as number)
    expect(oldestAfter).toBe(251)
  })

  it('walks all the way back, and then says so instead of asking again', async () => {
    const { controller, gateway } = await openDeepChat(650)

    expect(await controller.loadOlder('researcher')).toBe('grew')
    expect(await controller.loadOlder('researcher')).toBe('grew')
    // 200 + 200 + 200 = 600, and the last 50 rows are a short page: the route
    // has no `has_more` and no total, so a page shorter than the limit is the
    // only signal that the start has arrived.
    expect(await controller.loadOlder('researcher')).toBe('grew')
    expect(chatOf().items[chatOf().order[0] as string]?.rowId).toBe(1)

    const calls = gateway.restCalls.filter(call => call.offset !== undefined).length

    expect(await controller.loadOlder('researcher')).toBe('start')
    // It did not ask. Knowing there is nothing older is the point of keeping the
    // window, and a list that keeps firing `onEndReached` at the top must not
    // turn into a request per frame.
    expect(gateway.restCalls.filter(call => call.offset !== undefined)).toHaveLength(calls)
  })

  it('never pages a chat whose history came over the RPC', async () => {
    // `session.history` is unpaginated: what came back IS the conversation, so
    // there is nothing to page and the honest answer is that this cannot grow.
    const { controller, gateway } = setup()

    await controller.openChat(RESEARCHER)

    expect(await controller.loadOlder('researcher')).toBe('start')
    expect(gateway.restCalls.filter(call => call.offset !== undefined)).toHaveLength(0)
  })

  it('refuses a second page while one is in the air', async () => {
    const { controller, gateway } = await openDeepChat(650)

    const both = await Promise.all([controller.loadOlder('researcher'), controller.loadOlder('researcher')])

    expect(both).toEqual(['grew', 'grew'])
    // Two calls at the same offset are the same page twice, and `onEndReached`
    // fires more than once while a page is being fetched.
    expect(gateway.restCalls.filter(call => call.offset !== undefined)).toHaveLength(1)
  })

  it('drops rows it already holds rather than drawing them twice', async () => {
    const { controller } = await openDeepChat(650)

    await controller.loadOlder('researcher')

    const after = chatOf()
    const rowIds = after.order.map(id => after.items[id]?.rowId).filter(rowId => rowId !== undefined)

    expect(new Set(rowIds).size).toBe(rowIds.length)
  })
})
