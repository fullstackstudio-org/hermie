/**
 * The session gaps (plan W-16, the native apps' PG-2) as the chat controller
 * handles them: a replay that cannot vouch for itself makes the chat be read again
 * in full, a deferred resume load reads it again when it completes, `/status`
 * reaches the gateway on every gateway, and what the gateway says beside the
 * transcript is handed over at its place among the chat's frames
 * (`onSessionSignal`).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { BotsController } from './bots-controller'
import { ChatController, type SessionSignal } from './chat-controller'
import { immediateFrames } from './ingest'
import { MemoryChatCache } from '../platform/chat-cache'
import { botFromProfileRow, botsStore } from '../state/bots'
import { chatsStore } from '../state/chats'
import { FakeChatGateway } from '../test-support/fake-chat-gateway'

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

/** What the gateway holds once a turn ran while nobody was listening. */
const HISTORY_AFTER = [
  ...HISTORY,
  { role: 'user', text: 'The night shift says all green.', row_id: 3, timestamp: 1_700_000_050 },
  { role: 'assistant', text: 'Thanks.', row_id: 4, timestamp: 1_700_000_051 }
]

const RESUME = {
  session_id: 'runtime-1',
  stored_session_id: 'tip-researcher',
  message_count: 2,
  messages: [],
  messages_omitted: true,
  info: { desktop_contract: 7 },
  open_requests: []
}

const REPLAY = { events: [], latest_seq: 7, truncated: false, count: 0, epoch: 'e1', open_requests: [] }

const started: ChatController[] = []

function setup() {
  const gateway = new FakeChatGateway()
  const cache = new MemoryChatCache()
  const botsController = new BotsController({ gateway, store: botsStore, cache })
  const controller = new ChatController({
    frames: immediateFrames,
    gateway,
    chats: chatsStore,
    bots: botsStore,
    botsController,
    cache
  })
  const signals: SessionSignal[] = []

  controller.onSessionSignal(signal => signals.push(signal))
  gateway
    .reply('session.resume', RESUME)
    .reply('session.history', { count: HISTORY.length, messages: HISTORY })
    .reply('session.events.since', REPLAY)
    .reply('profiles.list', { profiles: [] })
    .reply('approval.received', { acknowledged: true })
    .reply('approval.pending', { approvals: [] })
    .reply('subagent.list', { subagents: [] })

  botsStore.getState().setBots([RESEARCHER])
  gateway.restMessages = null
  started.push(controller)

  return { gateway, controller, signals }
}

beforeEach(() => {
  chatsStore.getState().reset()
  botsStore.getState().reset()
})

afterEach(() => {
  for (const controller of started.splice(0)) {
    controller.stop()
  }
})

const chatOf = (name = 'researcher') => chatsStore.getState().chats[name]!

/** Let every already-resolved promise settle. */
function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

const historyReads = (gateway: FakeChatGateway): number => gateway.callsOf('session.history').length

/** The texts of the user rows, in order. */
const userTexts = (): string[] =>
  chatOf()
    .order.map(id => chatOf().items[id])
    .flatMap(item => (item?.kind === 'user' ? [item.text] : []))

/** Open the chat, take the first ready (no reconnect), and hold a watermark on runtime-1. */
async function openLive(gateway: FakeChatGateway, controller: ChatController): Promise<void> {
  controller.start()
  await controller.openChat(RESEARCHER)
  gateway.status('ready')
  await flush()
  gateway.emit({ type: 'message.delta', session_id: 'runtime-1', seq: 8, payload: { text: '' } })
}

describe('a replay that cannot vouch for itself', () => {
  it('reads the chat again in full when a reconnect’s replay answers truncated, without doubling anything', async () => {
    const { gateway, controller } = setup()

    await openLive(gateway, controller)

    const before = historyReads(gateway)

    // Away: a turn ran on the gateway, and its ring dropped what the replay would have carried.
    gateway.reply('session.history', { count: HISTORY_AFTER.length, messages: HISTORY_AFTER })
    gateway.reply('session.events.since', { ...REPLAY, latest_seq: 30, truncated: true })
    gateway.status('reconnecting')
    gateway.status('ready')
    await flush()

    expect(historyReads(gateway)).toBe(before + 1)
    expect(userTexts()).toEqual(['Introduce yourself.', 'The night shift says all green.'])
    expect(new Set(chatOf().order).size).toBe(chatOf().order.length)
    expect(chatOf().hydration).toBe('live')
  })

  it('reads the chat again when the replay comes from a restarted gateway (another epoch)', async () => {
    const { gateway, controller } = setup()

    await openLive(gateway, controller)

    const before = historyReads(gateway)

    gateway.reply('session.events.since', { ...REPLAY, latest_seq: 2, epoch: 'e2' })
    gateway.status('reconnecting')
    gateway.status('ready')
    await flush()

    expect(historyReads(gateway)).toBe(before + 1)
  })

  it('reads nothing again when the replay vouches for itself', async () => {
    const { gateway, controller } = setup()

    await openLive(gateway, controller)

    const before = historyReads(gateway)

    gateway.reply('session.events.since', { ...REPLAY, latest_seq: 8 })
    gateway.status('reconnecting')
    gateway.status('ready')
    await flush()

    expect(historyReads(gateway)).toBe(before)
  })

  it('reads the chat again at once when the connection’s own replay reports a gap on a live socket', async () => {
    const { gateway, controller } = setup()

    await openLive(gateway, controller)

    const before = historyReads(gateway)

    gateway.reply('session.history', { count: HISTORY_AFTER.length, messages: HISTORY_AFTER })
    controller.noteReplayGap('runtime-1')
    // A second report while the first read is in the air joins it.
    controller.noteReplayGap('runtime-1')
    await flush()

    expect(historyReads(gateway)).toBe(before + 1)
    expect(userTexts()).toEqual(['Introduce yourself.', 'The night shift says all green.'])
  })

  it('leaves the gap a reconnect reports to the recovery, which reads the chat once, after its resume', async () => {
    const { gateway, controller } = setup()

    await openLive(gateway, controller)

    const before = historyReads(gateway)

    gateway.status('reconnecting')
    // The connection's replay answers before the chats recover: the socket is not ready for them yet.
    controller.noteReplayGap('runtime-1')
    await flush()
    expect(historyReads(gateway)).toBe(before)

    gateway.reply('session.events.since', { ...REPLAY, latest_seq: 8 })
    gateway.status('ready')
    await flush()

    expect(historyReads(gateway)).toBe(before + 1)
    const order = gateway.methodOrder()

    expect(order.lastIndexOf('session.history')).toBeGreaterThan(order.lastIndexOf('session.resume'))
  })

  it('keeps what the chat holds when the read again comes back empty', async () => {
    const { gateway, controller } = setup()

    await openLive(gateway, controller)
    gateway.reply('session.history', { count: 0, messages: [] })
    controller.noteReplayGap('runtime-1')
    await flush()

    expect(userTexts()).toEqual(['Introduce yourself.'])
  })

  it('ignores a gap for a session no chat holds, and one for a chat that is being opened', async () => {
    const { gateway, controller } = setup()

    controller.start()
    gateway.status('ready')
    controller.noteReplayGap('runtime-unknown')

    const opening = controller.openChat(RESEARCHER)

    await opening
    await flush()

    expect(historyReads(gateway)).toBe(1)
  })
})

describe('a resume whose load was deferred', () => {
  it('reads the chat again when the gateway says the load is complete', async () => {
    const { gateway, controller, signals } = setup()

    gateway.reply('session.resume', { ...RESUME, hydrating: true })
    controller.start()
    await controller.openChat(RESEARCHER)

    expect(signals).toContainEqual(
      expect.objectContaining({ kind: 'resumed', chat: 'researcher', runtimeSessionId: 'runtime-1', hydrating: true })
    )

    const before = historyReads(gateway)

    gateway.reply('session.history', { count: HISTORY_AFTER.length, messages: HISTORY_AFTER })
    gateway.emit({
      type: 'session.resume_progress',
      session_id: 'runtime-1',
      seq: 9,
      payload: { phase: 'history', status: 'loading' }
    })
    await flush()
    expect(historyReads(gateway)).toBe(before)

    gateway.emit({
      type: 'session.resume_progress',
      session_id: 'runtime-1',
      seq: 10,
      payload: { phase: 'history', status: 'complete', message_count: 4 }
    })
    await flush()

    expect(historyReads(gateway)).toBe(before + 1)
    expect(userTexts()).toContain('The night shift says all green.')
    expect(signals.filter(signal => signal.kind === 'resume.progress').map(signal => signal.payload.status)).toEqual([
      'loading',
      'complete'
    ])
  })

  it('reads nothing again for a complete that no deferred resume asked for', async () => {
    const { gateway, controller } = setup()

    controller.start()
    await controller.openChat(RESEARCHER)

    const before = historyReads(gateway)

    gateway.emit({
      type: 'session.resume_progress',
      session_id: 'runtime-1',
      seq: 9,
      payload: { phase: 'history', status: 'complete' }
    })
    await flush()

    expect(historyReads(gateway)).toBe(before)
  })
})

describe('what the gateway says beside the transcript', () => {
  it('hands over a notice with the chat whose session carried it, and one on no chat without', async () => {
    const { gateway, controller, signals } = setup()

    controller.start()
    await controller.openChat(RESEARCHER)
    gateway.emit({
      type: 'notification.show',
      session_id: 'runtime-1',
      seq: 8,
      payload: { text: 'Credits low', level: 'warn', kind: 'sticky', key: 'credits' }
    })
    gateway.emit({ type: 'notification.show', payload: { text: 'Starting the agent', level: 'info', kind: 'ttl' } })
    gateway.emit({ type: 'notification.clear', session_id: 'runtime-1', seq: 9, payload: { key: 'credits' } })

    expect(signals.filter(signal => signal.kind.startsWith('notice'))).toEqual([
      {
        kind: 'notice.show',
        chat: 'researcher',
        payload: { text: 'Credits low', level: 'warn', kind: 'sticky', key: 'credits' }
      },
      { kind: 'notice.show', chat: undefined, payload: { text: 'Starting the agent', level: 'info', kind: 'ttl' } },
      { kind: 'notice.clear', payload: { key: 'credits' } }
    ])
    // The engine still moved its watermark past them.
    expect(chatOf().lastSeq).toBe(9)
  })

  it('hands over a connection request and its updates on a chat’s session, once each, never a replayed copy', async () => {
    const { gateway, controller, signals } = setup()
    const request = {
      op_id: 'op-1',
      tool_call_id: 'tc-1',
      deadline_at: 2_000_000_000,
      timeout_seconds: 300,
      targets: [{ name: 'github', kind: 'connector', action: 'authorize', state: 'pending' }]
    }

    controller.start()
    await controller.openChat(RESEARCHER)
    gateway.emit({ type: 'connection.request', session_id: 'runtime-1', seq: 8, payload: request })
    gateway.emit({ type: 'connection.request', session_id: 'runtime-1', seq: 8, payload: request })
    gateway.emit({ type: 'connection.update', session_id: 'runtime-1', seq: 9, payload: { op_id: 'op-1', seq: 2 } })
    // Another session's operation is no chat's.
    gateway.emit({ type: 'connection.request', session_id: 'runtime-other', seq: 3, payload: request })

    expect(signals.filter(signal => signal.kind.startsWith('connection'))).toEqual([
      { kind: 'connection.request', chat: 'researcher', runtimeSessionId: 'runtime-1', payload: request },
      { kind: 'connection.update', chat: 'researcher', payload: { op_id: 'op-1', seq: 2 } }
    ])
  })

  it('hands over what a resume says is still open, and that nothing is', async () => {
    const { gateway, controller, signals } = setup()
    const pending = {
      op_id: 'op-2',
      tool_call_id: 'tc-2',
      deadline_at: 2_000_000_000,
      timeout_seconds: 300,
      targets: [{ name: 'linear', kind: 'connector', action: 'authorize', state: 'initiated' }]
    }

    gateway.reply('session.resume', { ...RESUME, pending_connection: pending })
    controller.start()
    await controller.openChat(RESEARCHER)

    expect(signals.filter(signal => signal.kind === 'resumed')).toEqual([
      {
        kind: 'resumed',
        chat: 'researcher',
        runtimeSessionId: 'runtime-1',
        pendingConnection: pending,
        hydrating: false
      }
    ])

    signals.length = 0
    gateway.status('ready')
    await flush()
    gateway.reply('session.resume', RESUME)
    gateway.status('reconnecting')
    gateway.status('ready')
    await flush()

    expect(signals.filter(signal => signal.kind === 'resumed')).toEqual([
      { kind: 'resumed', chat: 'researcher', runtimeSessionId: 'runtime-1', pendingConnection: null, hydrating: false }
    ])
  })

  it('stops telling a listener that left, and keeps going when one throws', async () => {
    const { gateway, controller, signals } = setup()
    const heard: SessionSignal[] = []

    controller.onSessionSignal(() => {
      throw new Error('somebody else’s feature')
    })
    const stop = controller.onSessionSignal(signal => heard.push(signal))

    controller.start()
    await controller.openChat(RESEARCHER)
    stop()
    gateway.emit({ type: 'notification.show', payload: { text: 'Hello', level: 'info', kind: 'sticky' } })

    expect(heard.filter(signal => signal.kind === 'notice.show')).toEqual([])
    expect(signals.filter(signal => signal.kind === 'notice.show')).toHaveLength(1)
  })
})

describe('/status', () => {
  it('asks the gateway for the session’s report when its catalogue does not list the command', async () => {
    const { gateway, controller } = setup()

    gateway
      .reply('commands.catalog', { pairs: [['/model', 'Switch the model']] })
      .reply('complete.slash', { items: [] })
      .reply('session.status', { output: 'Model: example-model\nTokens: 12' })

    controller.start()
    await controller.openChat(RESEARCHER)
    await controller.querySlash('researcher', '/')

    expect(controller.slashRouteFor('researcher', 'status')).toBe('local')

    await controller.runSlash('researcher', '/status')

    expect(gateway.lastCall('session.status')).toEqual({ session_id: 'runtime-1', profile: 'researcher' })
    expect(gateway.callsOf('slash.exec')).toEqual([])

    const notice = chatOf()
      .order.map(id => chatOf().items[id])
      .find(item => item?.kind === 'notice')

    expect(notice).toMatchObject({ noticeKind: 'command', title: '/status', body: 'Model: example-model\nTokens: 12' })
  })

  it('runs it through slash.exec like any command when the catalogue lists it', async () => {
    const { gateway, controller } = setup()

    gateway
      .reply('commands.catalog', { pairs: [['/status', 'Session status']] })
      .reply('complete.slash', { items: [] })
      .reply('slash.exec', { output: 'Hermes TUI Status' })

    controller.start()
    await controller.openChat(RESEARCHER)
    await controller.querySlash('researcher', '/')

    expect(controller.slashRouteFor('researcher', 'status')).toBe('exec')

    await controller.runSlash('researcher', '/status')

    expect(gateway.callsOf('session.status')).toEqual([])
    expect(gateway.callsOf('slash.exec')).toHaveLength(1)
  })

  it('says why when the gateway refuses the report', async () => {
    const { gateway, controller } = setup()

    gateway.reply('session.status', () => {
      throw new Error('session not found')
    })
    controller.start()
    await controller.openChat(RESEARCHER)

    await expect(controller.sessionStatus('researcher')).rejects.toThrow('session not found')
  })
})
