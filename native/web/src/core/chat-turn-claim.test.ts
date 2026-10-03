/**
 * The turn claim: a courtesy call to the plugin before `prompt.submit` starts a
 * model turn, naming the runtime session id that submit is about to carry.
 *
 * Everything here is about WHEN the claim goes out and when it does not.
 * `chat-controller.ts`'s `send` is the only road to `prompt.submit`, so it is
 * also the only place a claim can belong: a slash command never reaches it (it
 * goes to `slash.exec` from the screen directly, see `ChatScreen.tsx`), and a
 * steer never opens a turn of its own (it folds into one already running,
 * through `session.steer`). Both are exercised here rather than assumed.
 *
 * Ported from the Expo app's `__tests__/chat-turn-claim.test.ts` (jest) to vitest. Differences:
 * the vanilla stores (`chatsStore`, `botsStore`, `pluginStore`) for the hooks,
 * and the controller runs on `immediateFrames`, so every write it makes is
 * committed to the store at once and these assertions read the store exactly
 * as the Expo ones did. The frame batching itself is `ingest.test.ts`’s.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { GatewayError, type GatewayHttp } from '@hermie/gateway-client'
import { PLUGIN_CAPABILITIES } from '@hermie/gateway-client/plugin'

import { BotsController } from './bots-controller'
import { ChatController } from './chat-controller'
import type { WebPluginAdvert } from './advert'
import { immediateFrames } from './ingest'
import { MemoryChatCache } from '../platform/chat-cache'
import { botFromProfileRow, botsStore } from '../state/bots'
import { chatsStore } from '../state/chats'
import { pluginStore } from '../state/plugin'
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
    message_count: 0
  }
})

const started: ChatController[] = []

/** A plugin advert that offers the claim route, and nothing else worth noting. */
const ADVERT_WITH_CLAIM: WebPluginAdvert = {
  version: '0.8.0',
  capabilities: [PLUGIN_CAPABILITIES.contextTurnClaim],
  modules: {},
  limits: {},
  updatedAt: 0,
  relayOrigins: [],
  web: null,
  webPush: null
}

/** A recorded `POST`, and the object `chat-controller.ts` calls it through. */
function fakeHttp(
  events: string[],
  onPost?: (path: string, body: unknown) => unknown
): { http: GatewayHttp; posts: { path: string; body: unknown }[] } {
  const posts: { path: string; body: unknown }[] = []

  const http = {
    baseUrl: 'https://gateway.example.invalid',
    requestHeaders: async () => ({}),
    post: async (path: string, body?: unknown) => {
      events.push('claim')
      posts.push({ path, body })

      if (onPost) {
        return onPost(path, body)
      }

      return undefined
    }
  } as unknown as GatewayHttp

  return { http, posts }
}

function setup(options: { http?: GatewayHttp | null } = {}) {
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
    ...(options.http !== undefined ? { http: options.http } : {})
  })

  gateway
    .reply('session.resume', {
      session_id: 'runtime-1',
      stored_session_id: 'tip-researcher',
      message_count: 0,
      messages: [],
      messages_omitted: true,
      info: { desktop_contract: 7 },
      open_requests: []
    })
    .reply('session.history', { count: 0, messages: [] })
    .reply('session.events.since', {
      events: [],
      latest_seq: 0,
      truncated: false,
      count: 0,
      epoch: 'e1',
      open_requests: []
    })
    .reply('profiles.list', { profiles: [] })
    .reply('approval.received', { acknowledged: true })
    .reply('approval.pending', { approvals: [] })

  botsStore.getState().setBots([RESEARCHER])
  gateway.restMessages = null
  started.push(controller)

  return { gateway, cache, controller }
}

const chatOf = () => chatsStore.getState().chats.researcher!
const queueOf = () => chatsStore.getState().queues.researcher ?? []

beforeEach(() => {
  chatsStore.getState().reset()
  botsStore.getState().reset()
  pluginStore.getState().reset()
})

afterEach(() => {
  for (const controller of started.splice(0)) {
    controller.stop()
  }
  pluginStore.getState().reset()
})

describe('a normal send, with the capability advertised', () => {
  it('claims the runtime session before prompt.submit, in that order', async () => {
    pluginStore.getState().apply(ADVERT_WITH_CLAIM)

    const events: string[] = []
    const { http, posts } = fakeHttp(events)
    const { gateway, controller } = setup({ http })

    gateway.reply('prompt.submit', () => {
      events.push('submit')

      return { status: 'streaming' }
    })

    controller.start()
    await controller.openChat(RESEARCHER)
    await controller.send('researcher', 'hello there')

    expect(events).toEqual(['claim', 'submit'])
    expect(posts).toEqual([{ path: '/api/plugins/hermie/context/turn', body: { session_id: 'runtime-1' } }])
    expect(gateway.lastCall('prompt.submit')).toMatchObject({ session_id: 'runtime-1', text: 'hello there' })
  })

  it('sends no claim when the plugin does not advertise the capability', async () => {
    // No `pluginStore.getState().apply(...)`: the default is "no advert".
    const events: string[] = []
    const { http, posts } = fakeHttp(events)
    const { gateway, controller } = setup({ http })

    gateway.reply('prompt.submit', { status: 'streaming' })

    controller.start()
    await controller.openChat(RESEARCHER)
    await controller.send('researcher', 'hello there')

    expect(posts).toEqual([])
    expect(gateway.lastCall('prompt.submit')).toMatchObject({ text: 'hello there' })
  })

  it('sends no claim for a slash command, which never reaches prompt.submit', async () => {
    pluginStore.getState().apply(ADVERT_WITH_CLAIM)

    const events: string[] = []
    const { http, posts } = fakeHttp(events)
    const { gateway, controller } = setup({ http })

    gateway.reply('slash.exec', { output: 'noted' })

    controller.start()
    await controller.openChat(RESEARCHER)
    await controller.runSlash('researcher', '/me')

    expect(posts).toEqual([])
    expect(gateway.methodOrder()).not.toContain('prompt.submit')
    expect(gateway.methodOrder()).toContain('slash.exec')
  })
})

describe('a claim that does not land', () => {
  it('still submits exactly once on a 404', async () => {
    pluginStore.getState().apply(ADVERT_WITH_CLAIM)

    const events: string[] = []
    const { http, posts } = fakeHttp(events, () => {
      throw new GatewayError('protocol', 'no such route', { status: 404 })
    })
    const { gateway, controller } = setup({ http })

    gateway.reply('prompt.submit', () => {
      events.push('submit')

      return { status: 'streaming' }
    })

    controller.start()
    await controller.openChat(RESEARCHER)
    await controller.send('researcher', 'hello there')

    expect(posts).toHaveLength(1)
    expect(gateway.methodOrder().filter(method => method === 'prompt.submit')).toHaveLength(1)
    expect(events).toEqual(['claim', 'submit'])
  })

  it('still submits exactly once on a timeout, without retrying the claim', async () => {
    pluginStore.getState().apply(ADVERT_WITH_CLAIM)

    const events: string[] = []
    const { http, posts } = fakeHttp(events, () => {
      throw new GatewayError('timeout', 'did not answer in time')
    })
    const { gateway, controller } = setup({ http })

    gateway.reply('prompt.submit', () => {
      events.push('submit')

      return { status: 'streaming' }
    })

    controller.start()
    await controller.openChat(RESEARCHER)
    await controller.send('researcher', 'hello there')

    expect(posts).toHaveLength(1)
    expect(gateway.methodOrder().filter(method => method === 'prompt.submit')).toHaveLength(1)
    expect(events).toEqual(['claim', 'submit'])
  })
})

describe('the queue behind a running turn', () => {
  /** Open a chat and leave a turn running in it. */
  async function busy(http: GatewayHttp) {
    const kit = setup({ http })

    kit.gateway.reply('prompt.submit', { status: 'streaming' })
    kit.controller.start()
    await kit.controller.openChat(RESEARCHER)
    await kit.controller.send('researcher', 'go')

    expect(chatOf().turn.active).toBe(true)

    return kit
  }

  it('claims a queued prompt when it is drained, after the running turn ends', async () => {
    pluginStore.getState().apply(ADVERT_WITH_CLAIM)

    const events: string[] = []
    const { http, posts } = fakeHttp(events)
    const { gateway, controller } = await busy(http)

    // The first `send`, which started the running turn, claimed once already.
    expect(posts).toHaveLength(1)

    await controller.send('researcher', 'and one more thing')
    expect(queueOf()).toEqual([expect.objectContaining({ text: 'and one more thing' })])
    // Parked, not sent: no second claim yet.
    expect(posts).toHaveLength(1)

    gateway.emit({ type: 'message.complete', session_id: 'runtime-1', seq: 20, payload: {} })
    await Promise.resolve()
    await Promise.resolve()

    expect(queueOf()).toEqual([])
    expect(posts).toHaveLength(2)
    expect(posts[1]).toEqual({ path: '/api/plugins/hermie/context/turn', body: { session_id: 'runtime-1' } })
    expect(gateway.lastCall('prompt.submit')).toMatchObject({ text: 'and one more thing' })
  })

  it('sends no claim for a message steered into the turn that is running', async () => {
    pluginStore.getState().apply(ADVERT_WITH_CLAIM)

    const events: string[] = []
    const { http, posts } = fakeHttp(events)
    const { gateway, controller } = await busy(http)

    // The running turn's own claim.
    expect(posts).toHaveLength(1)

    gateway.reply('session.steer', { status: 'queued', text: 'use the cached copy' })

    await controller.send('researcher', 'use the cached copy')
    const status = await controller.steerQueued('researcher', queueOf()[0]!.id)

    expect(status).toBe('queued')
    expect(gateway.lastCall('session.steer')).toMatchObject({
      session_id: 'runtime-1',
      text: 'use the cached copy'
    })
    // Steering never opens a turn of its own: no second claim.
    expect(posts).toHaveLength(1)
  })
})
