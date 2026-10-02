/**
 * How full the context window is, from the gateway to the two rows that say so.
 *
 * The interesting half is the ABSENCE. A gateway that does not report a window
 * has to leave the app with one fewer row and nothing else — no error card, no
 * ring at zero, and no second RPC per chat the reader opens.
 */
import { screen } from '@testing-library/react-native'

import { BotsController } from '../src/features/bots/bots-controller'
import { ChatController } from '../src/features/chats/chat-controller'
import type { RpcFailure } from '../src/gateway/rpc-failures'
import { MemoryChatCache } from '../src/platform/chat-cache'
import { botFromProfileRow, useBotsStore } from '../src/store/bots'
import { useChatsStore } from '../src/store/chats'
import { ChatOptionsSheet } from '../src/ui/sheets'
import { FakeChatGateway } from './support/fake-chat-gateway'
import { renderScreen } from './support/render'

const RESEARCHER = botFromProfileRow({
  name: 'researcher',
  path: '/root/.hermes/profiles/researcher',
  display_name: 'Researcher',
  canonical_session: {
    id: 'stored-researcher',
    resolved_id: 'tip-researcher',
    title: 'Bot Chat',
    last_active: 1_700_000_100,
    message_count: 0
  }
})

const started: ChatController[] = []

function setup(options: { onRpcFailure?: (failure: RpcFailure) => void } = {}) {
  const gateway = new FakeChatGateway()
  const cache = new MemoryChatCache()
  const botsController = new BotsController({ gateway, store: useBotsStore, cache })
  const controller = new ChatController({
    gateway,
    chats: useChatsStore,
    bots: useBotsStore,
    botsController,
    cache,
    ...(options.onRpcFailure ? { onRpcFailure: options.onRpcFailure } : {})
  })

  gateway
    .reply('session.resume', {
      session_id: 'runtime-1',
      stored_session_id: 'tip-researcher',
      message_count: 0,
      messages: [],
      info: { desktop_contract: 7 },
      open_requests: []
    })
    .reply('session.history', { count: 0, messages: [] })
    .reply('session.events.since', {
      events: [],
      latest_seq: 1,
      truncated: false,
      count: 0,
      epoch: 'e1',
      open_requests: []
    })
    .reply('profiles.list', { profiles: [] })
    .reply('approval.pending', { approvals: [] })

  useBotsStore.getState().setBots([RESEARCHER])
  gateway.restMessages = null
  started.push(controller)

  return { controller, gateway }
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

const chatOf = () => useChatsStore.getState().chats.researcher!

describe('asking the gateway how full the window is', () => {
  it('folds the answer into the chat the same way a live tick would', async () => {
    const { controller, gateway } = setup()

    gateway.reply('session.usage', {
      context_max: 200_000,
      context_used: 42_000,
      total: 1_200
    })

    await controller.openChat(RESEARCHER)
    await controller.refreshUsage('researcher')

    expect(chatOf().usage?.context_used).toBe(42_000)
    expect(chatOf().usage?.context_max).toBe(200_000)
  })

  it('asks once and never again when the gateway does not have the method', async () => {
    const failures: RpcFailure[] = []
    const { controller, gateway } = setup({ onRpcFailure: failure => failures.push(failure) })

    // No responder is how `FakeChatGateway` spells "this gateway refuses the
    // call", which is the shape a method a gateway does not implement takes.
    await controller.openChat(RESEARCHER)

    expect(await controller.refreshUsage('researcher')).toBeNull()
    expect(await controller.refreshUsage('researcher')).toBeNull()

    const attempts = gateway.calls.filter(call => call.method === 'session.usage')

    // One attempt for the connection, not one per call and not one per chat.
    expect(attempts).toHaveLength(1)
    // Absorbed for the reader, recorded for whoever has to diagnose it later —
    // the rule `rpc-failures.ts` exists for.
    expect(failures.map(failure => failure.method)).toEqual(['session.usage'])
  })

  it('says nothing at all before a chat has bound a runtime session', async () => {
    const { controller, gateway } = setup()

    gateway.reply('session.usage', { context_max: 200_000, context_used: 1 })

    expect(await controller.refreshUsage('researcher')).toBeNull()
    expect(gateway.calls.some(call => call.method === 'session.usage')).toBe(false)
  })
})

const OPTIONS = {
  accent: 'default' as const,
  botName: 'Researcher',
  fast: false,
  model: 'example-provider/example-model',
  modelOptions: [],
  mutedUntil: null,
  onChangeAccent: () => undefined,
  onChangeFast: () => undefined,
  onChangeModel: () => undefined,
  onChangeMute: () => undefined,
  onChangeReasoningEffort: () => undefined,
  onChangeShowBotToBot: () => undefined,
  onChangeShowThinking: () => undefined,
  onChangeVerbosity: () => undefined,
  onChangeYolo: () => undefined,
  onClose: () => undefined,
  reasoningEffort: 'medium',
  reasoningOptions: [],
  showBotToBot: true,
  showThinking: false,
  verbosity: 'normal' as const,
  visible: true,
  yolo: false
}

describe('the row in the chat options sheet', () => {
  it('states the percentage and both counts', () => {
    renderScreen(
      <ChatOptionsSheet
        {...OPTIONS}
        contextUsage={{ estimated: false, fraction: 0.82, limit: 200_000, percent: 82, used: 164_000 }}
      />
    )

    expect(screen.getByTestId('option-context')).toBeTruthy()
    expect(screen.getByText('82%')).toBeTruthy()
    expect(screen.getByText('164k / 200k')).toBeTruthy()
  })

  it('carries the gateway’s own caveat when there is one', () => {
    renderScreen(
      <ChatOptionsSheet
        {...OPTIONS}
        contextUsage={{ estimated: true, fraction: 0.1, limit: 100_000, percent: 10, used: 10_000 }}
      />
    )

    expect(screen.getByText('(estimated)')).toBeTruthy()
  })

  it('is absent entirely on a gateway that does not report a window', () => {
    renderScreen(<ChatOptionsSheet {...OPTIONS} />)

    // Absent, not empty: a ring at zero would say the session is fresh.
    expect(screen.queryByTestId('option-context')).toBeNull()
    expect(screen.queryByTestId('context-meter')).toBeNull()
    // And the rest of the sheet is untouched.
    expect(screen.getByTestId('option-model')).toBeTruthy()
  })
})
