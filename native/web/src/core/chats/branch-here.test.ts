/**
 * Branching from a row of the transcript, against the real controller on the
 * fake chat gateway: the count and the title a row stands for reach
 * `session.branch`, and what the controller answers comes back as the branch.
 *
 * The method has no row id (`ChatController.branchFrom`), so what is pinned here
 * is the one reading the app is built on: the branch starts with as many of the
 * parent's persisted messages as there are at or before the row
 * (`session-branch.test.ts` holds the assumption's own caveat).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { BotsController } from '../bots-controller'
import { ChatController } from '../chat-controller'
import { immediateFrames } from '../ingest'
import { MemoryChatCache } from '../../platform/chat-cache'
import { botFromProfileRow, botsStore } from '../../state/bots'
import { chatsStore } from '../../state/chats'
import { FakeChatGateway } from '../../test-support/fake-chat-gateway'
import { branchChatAt } from './branch-here'

const CANONICAL = 'stored-canonical'
const BRANCH = 'stored-branch'

const RESEARCHER = botFromProfileRow({
  name: 'researcher',
  path: '/root/.hermes/profiles/researcher',
  display_name: 'Researcher',
  canonical_session: {
    id: CANONICAL,
    resolved_id: CANONICAL,
    title: 'Bot Chat',
    last_active: 1_700_000_100,
    message_count: 4
  }
})

const HISTORY = [
  { role: 'user', text: 'Which way should we take this?', row_id: 1, timestamp: 1_700_000_000 },
  { role: 'assistant', text: 'The first way.', row_id: 2, timestamp: 1_700_000_001 },
  { role: 'user', text: 'And the second?', row_id: 3, timestamp: 1_700_000_002 },
  { role: 'assistant', text: 'Also possible.', row_id: 4, timestamp: 1_700_000_003 }
]

const started: ChatController[] = []

function setup(branchReply: (params: Record<string, unknown>) => Record<string, unknown> | Error) {
  const gateway = new FakeChatGateway()
  const cache = new MemoryChatCache()
  const botsController = new BotsController({ gateway, store: botsStore, cache })
  const controller = new ChatController({
    frames: immediateFrames,
    gateway,
    chats: chatsStore,
    bots: botsStore,
    botsController,
    cache,
    now: () => 1_790_000_000_000
  })

  gateway
    .reply('session.resume', {
      session_id: 'runtime-canonical',
      stored_session_id: CANONICAL,
      message_count: HISTORY.length,
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
    .reply('subagent.list', { subagents: [] })
    .reply('profiles.list', { profiles: [] })
    .reply('approval.pending', { approvals: [] })
    .reply('session.branch', params => {
      const answer = branchReply(params)

      if (answer instanceof Error) {
        throw answer
      }

      return answer
    })

  botsStore.getState().setBots([RESEARCHER])
  gateway.restMessages = null
  started.push(controller)

  return { gateway, controller }
}

const made = (params: Record<string, unknown>): Record<string, unknown> => ({
  session_id: 'runtime-branch',
  stored_session_id: BRANCH,
  title: String(params.name ?? ''),
  parent: CANONICAL,
  message_count: Number(params.count ?? 0),
  messages: [],
  info: { desktop_contract: 7 }
})

beforeEach(() => {
  chatsStore.getState().reset()
  botsStore.getState().reset()
})

afterEach(() => {
  for (const controller of started.splice(0)) {
    controller.stop()
  }
})

describe('branching from a row', () => {
  it('asks for the messages up to and including the row, named after its words, and returns the branch', async () => {
    const { gateway, controller } = setup(made)

    await controller.openChat(RESEARCHER)

    const chat = chatsStore.getState().chats.researcher
    const replies = chat?.order.filter(id => chat.items[id]?.kind === 'assistant') ?? []

    expect(replies).toHaveLength(2)

    const first = chat?.items[replies[0]!]
    const branch = await branchChatAt(controller, 'researcher', chat, replies[0]!, 'The first way.')

    expect(first?.kind).toBe('assistant')
    expect(gateway.lastCall('session.branch')).toMatchObject({
      session_id: 'runtime-canonical',
      profile: 'researcher',
      name: 'Branch · The first way.',
      count: 2
    })
    expect(branch).toMatchObject({ id: BRANCH, title: 'Branch · The first way.', kind: 'branch' })
  })

  it('branches the turn’s own row with one message fewer than the reply under it', async () => {
    const { gateway, controller } = setup(made)

    await controller.openChat(RESEARCHER)

    const chat = chatsStore.getState().chats.researcher
    const turns = chat?.order.filter(id => chat.items[id]?.kind === 'user') ?? []

    await branchChatAt(controller, 'researcher', chat, turns[1]!, 'And the second?')
    expect(gateway.lastCall('session.branch')).toMatchObject({ name: 'Branch · And the second?', count: 3 })
  })

  it('takes the count off the whole transcript, and the whole of it for a row it does not know', async () => {
    const { gateway, controller } = setup(made)

    await controller.openChat(RESEARCHER)
    await branchChatAt(controller, 'researcher', chatsStore.getState().chats.researcher, 'nowhere', 'x')
    expect(gateway.lastCall('session.branch')?.count).toBe(4)

    // Nothing open for the key at all: a branch of nothing is floored to one message by the controller.
    await branchChatAt(controller, 'researcher', undefined, 'nowhere', '')
    expect(gateway.lastCall('session.branch')).toMatchObject({ name: 'Branch', count: 1 })
  })

  it('lets a refusal through for the screen to show, and a gateway that names no branch', async () => {
    const refused = setup(() => new Error('gateway said no'))

    await refused.controller.openChat(RESEARCHER)
    await expect(
      branchChatAt(refused.controller, 'researcher', chatsStore.getState().chats.researcher, 'nowhere', 'x')
    ).rejects.toThrow()

    chatsStore.getState().reset()
    botsStore.getState().reset()

    const nameless = setup(() => ({ session_id: 'runtime-branch' }))

    await nameless.controller.openChat(RESEARCHER)
    await expect(
      branchChatAt(nameless.controller, 'researcher', chatsStore.getState().chats.researcher, 'nowhere', 'x')
    ).rejects.toThrow('without returning its id')
  })
})
