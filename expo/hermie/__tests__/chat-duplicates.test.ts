/**
 * A message the user sent, driven through the controller until the gateway has
 * described it back.
 *
 * `@hermie/transcript` owns the pairing and tests it directly; what these cases
 * cover is the wiring around it — which call the controller makes, in which
 * order, and what the store holds afterwards. That is where the reported bug
 * lived: not in a reducer that could not pair two items, but in a resume the
 * controller applies on top of a transcript that already had them.
 */
import { BotsController } from '../src/features/bots/bots-controller'
import { ChatController } from '../src/features/chats/chat-controller'
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

/** The message from the report: paragraphs, a blank line, an address, a URL. */
const LONG = [
  'Can you have a look at the box again.',
  '',
  'It answers on 192.168.1.44 but the panel at https://example.test/admin is empty.',
  '',
  'Tell me what you find.'
].join('\n')

const started: ChatController[] = []

function setup() {
  const gateway = new FakeChatGateway()
  const botsController = new BotsController({ gateway, store: useBotsStore, cache: null })
  const controller = new ChatController({
    gateway,
    chats: useChatsStore,
    bots: useBotsStore,
    botsController,
    cache: null
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
    .reply('approval.pending', { approvals: [] })
    .reply('prompt.submit', { status: 'streaming' })
    .reply('session.interrupt', { status: 'interrupted' })

  useBotsStore.getState().setBots([RESEARCHER])
  gateway.restMessages = null
  started.push(controller)

  return { gateway, controller }
}

beforeEach(() => {
  useChatsStore.getState().reset()
  useBotsStore.getState().reset()
})

afterEach(() => {
  for (const controller of started.splice(0)) {
    controller.stop()
  }
})

const chatOf = (name = 'researcher') => useChatsStore.getState().chats[name]!
const items = () =>
  chatOf()
    .order.map(id => chatOf().items[id]!)
    .map(item => `${item.kind}:${'text' in item ? item.text : ''}`)
const userTexts = () =>
  chatOf()
    .order.map(id => chatOf().items[id])
    .filter(item => item?.kind === 'user')
    .map(item => (item?.kind === 'user' ? item.text : ''))

describe('a message the user sent', () => {
  it('shows one bubble after the sweep that brings its row back', async () => {
    const { gateway, controller } = setup()

    controller.start()
    await controller.openChat(RESEARCHER)
    await controller.send('researcher', LONG)

    gateway.restMessages = [...HISTORY, { role: 'user', text: LONG, row_id: 3, timestamp: 1_700_000_060 }]
    await controller.reconcileTailFor('researcher')

    expect(userTexts()).toEqual(['Introduce yourself.', LONG])
  })

  it('shows one bubble when it carried a file', async () => {
    const { gateway, controller } = setup()

    controller.start()
    await controller.openChat(RESEARCHER)
    await controller.send('researcher', 'have a look', [
      { kind: 'file', filename: 'notes.txt', path: '/srv/work/uploads/hermie/2026-09-19/ab-notes.txt' }
    ])

    // What went out is the body with the directive appended; what comes back is
    // that same body, which the projection strips again.
    const body = gateway.lastCall('prompt.submit')?.text as string

    expect(body).toContain('@file:')

    gateway.restMessages = [...HISTORY, { role: 'user', text: body, row_id: 3 }]
    await controller.reconcileTailFor('researcher')

    expect(userTexts()).toEqual(['Introduce yourself.', 'have a look'])
  })

  it('shows one bubble after a reconnect resumes the turn it is still running', async () => {
    const { gateway, controller } = setup()

    controller.start()
    await controller.openChat(RESEARCHER)
    gateway.status('ready')
    await flush()

    await controller.send('researcher', LONG)
    gateway.emit({ type: 'message.start', session_id: 'runtime-1', seq: 10, payload: {} })
    gateway.emit({ type: 'message.delta', session_id: 'runtime-1', seq: 11, payload: { text: 'Looking' } })

    // The socket drops and comes back. The gateway rebuilt the session, so the
    // resume reports the same turn as in flight under a new runtime id.
    gateway.reply('session.resume', {
      session_id: 'runtime-2',
      stored_session_id: 'tip-researcher',
      message_count: 3,
      messages: [],
      info: { desktop_contract: 7 },
      inflight: { user: LONG, assistant: 'Looking', streaming: true },
      running: true,
      open_requests: []
    })
    gateway.status('reconnecting')
    gateway.status('ready')
    await flush()

    expect(userTexts()).toEqual(['Introduce yourself.', LONG])
    expect(items().filter(entry => entry.startsWith('assistant:'))).toEqual([
      'assistant:I am researcher.',
      'assistant:Looking'
    ])
  })

  it('shows one bubble when the chat is reopened while the turn runs', async () => {
    const { gateway, controller } = setup()

    controller.start()
    await controller.openChat(RESEARCHER)
    await controller.send('researcher', LONG)

    // Leaving and coming back re-reads history, which by now carries the row the
    // gateway wrote at submit time, while the resume still calls it in flight.
    useChatsStore.getState().reset()
    useBotsStore.getState().setBots([RESEARCHER])
    gateway.reply('session.history', {
      count: 3,
      messages: [...HISTORY, { role: 'user', text: LONG, row_id: 3, timestamp: 1_700_000_060 }]
    })
    gateway.reply('session.resume', {
      session_id: 'runtime-1',
      stored_session_id: 'tip-researcher',
      message_count: 3,
      messages: [],
      info: { desktop_contract: 7 },
      inflight: { user: LONG, assistant: 'Looking that up', streaming: true },
      running: true,
      open_requests: []
    })

    await controller.openChat(RESEARCHER)

    expect(userTexts()).toEqual(['Introduce yourself.', LONG])
    expect(chatOf().turn.active).toBe(true)
  })

  it('keeps a queued burst ours, with no empty bubble in front of it', async () => {
    const { gateway, controller } = setup()

    controller.start()
    await controller.openChat(RESEARCHER)

    gateway.reply('prompt.submit', { status: 'streaming' })
    await controller.send('researcher', 'one')
    gateway.emit({ type: 'message.start', session_id: 'runtime-1', seq: 10, payload: {} })

    gateway.reply('prompt.submit', { status: 'queued' })
    await controller.send('researcher', 'two')
    await controller.send('researcher', 'three')

    gateway.emit({ type: 'message.complete', session_id: 'runtime-1', seq: 11, payload: { text: 'a' } })
    gateway.emit({ type: 'message.start', session_id: 'runtime-1', seq: 12, payload: {} })
    gateway.emit({ type: 'message.complete', session_id: 'runtime-1', seq: 13, payload: { text: 'b' } })
    gateway.emit({ type: 'message.start', session_id: 'runtime-1', seq: 14, payload: {} })
    await flush()

    expect(userTexts()).toEqual(['Introduce yourself.', 'one', 'two', 'three'])
    expect(chatOf().turn.local).toBe(true)
  })

  it('still hands a turn nobody here started to a tail fetch', async () => {
    const { gateway, controller } = setup()

    controller.start()
    await controller.openChat(RESEARCHER)
    await controller.send('researcher', 'mine')
    await controller.stopTurn('researcher')

    gateway.emit({ type: 'message.start', session_id: 'runtime-1', seq: 10, payload: {} })

    expect(chatOf().turn.foreignReconcilePending).toBe(true)

    gateway.restMessages = [
      ...HISTORY,
      { role: 'user', text: 'mine', row_id: 3 },
      { role: 'user', text: 'Message from 🤖 Writer (@writer): the draft is ready.', row_id: 4 }
    ]
    gateway.emit({ type: 'message.complete', session_id: 'runtime-1', seq: 11, payload: { text: 'Noted.' } })
    await flush()

    expect(items()).toContain('bot_dm_in:the draft is ready.')
    expect(userTexts()).toEqual(['Introduce yourself.', 'mine'])
  })
})

/** Let every already-resolved promise settle. */
function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}
