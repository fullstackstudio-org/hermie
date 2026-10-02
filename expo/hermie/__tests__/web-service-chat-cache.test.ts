/**
 * The service's copy of a chat, in the browser
 * ([ADR-0025](../../../docs/adr/0025-hermie-web-is-a-service-layer.md)).
 *
 * The claim is not "there is an extra cache". It is that a chat opened on a
 * device that has never seen it **paints before the socket answers, and then
 * does not move** — which is two properties with one test each, plus the
 * ordinary ones about not being fooled by a bad answer.
 *
 * The seam by its real name (`service-chat-cache.web`), as every web test here
 * does: under Jest the shared module resolves to the native chat cache, which
 * has no service behind it to ask.
 */
import { reconcile, rowsToItems, stateFromCache } from '@hermie/transcript'

import { BotsController } from '../src/features/bots/bots-controller'
import { ChatController } from '../src/features/chats/chat-controller'
import { MemoryChatCache } from '../src/platform/chat-cache'
import { ServiceChatCache, snapshotFromServiceAnswer } from '../src/platform/service-chat-cache.web'
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

/** What the gateway holds, and therefore what the service cached a moment ago. */
const ROWS = [
  { role: 'user', content: 'Introduce yourself.', id: 1, timestamp: 1_700_000_000 },
  { role: 'assistant', content: 'I am researcher.', id: 2, timestamp: 1_700_000_001 }
]

/** The same conversation as the RPC history route names it. */
const HISTORY = [
  { role: 'user', text: 'Introduce yourself.', row_id: 1, timestamp: 1_700_000_000 },
  { role: 'assistant', text: 'I am researcher.', row_id: 2, timestamp: 1_700_000_001 }
]

const answer = (over: Record<string, unknown> = {}) => ({
  sessionId: 'tip-researcher',
  bot: 'researcher',
  storedId: 'stored-researcher',
  shape: 'rest',
  updatedAt: 1_700_000_050,
  rows: ROWS,
  ...over
})

const jsonResponse = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response

const started: ChatController[] = []

beforeEach(() => {
  useChatsStore.getState().reset()
  useBotsStore.getState().reset()
})

afterEach(() => {
  for (const controller of started.splice(0)) {
    controller.stop()
  }
})

describe('the service cache seam', () => {
  it('asks the local store first, and the service only on a miss', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse(200, answer()))
    const local = new MemoryChatCache()
    const cache = new ServiceChatCache(local, { fetchImpl: fetchImpl as unknown as typeof fetch })

    await local.write({
      bot: 'researcher',
      itemsJson: JSON.stringify({ format: 1, items: [], subagents: [], lastSeq: 0, updatedAt: 1 }),
      lastRowId: null,
      lastSeq: 0,
      epoch: null,
      updatedAt: 1
    })

    // What this browser painted last time is the stillest possible first frame,
    // and it is already on disk. A round trip could not improve on it.
    expect(await cache.read('researcher')).not.toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()

    await local.forget('researcher')
    expect(await cache.read('researcher')).not.toBeNull()
    expect(fetchImpl).toHaveBeenCalledWith(
      '/hermie/cache/researcher',
      expect.objectContaining({ credentials: 'include' })
    )
  })

  it('reads by the bot’s name, which is all the seam has to go on', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse(200, answer()))
    const cache = new ServiceChatCache(new MemoryChatCache(), { fetchImpl: fetchImpl as unknown as typeof fetch })

    await cache.read('lance vance')

    // Encoded, because a profile name is not a path segment by nature.
    expect(fetchImpl).toHaveBeenCalledWith('/hermie/cache/lance%20vance', expect.anything())
  })

  it('costs a cold paint and nothing else when the service says no', async () => {
    const local = new MemoryChatCache()

    for (const bad of [
      jsonResponse(401, {}),
      jsonResponse(404, { error: 'not_cached' }),
      jsonResponse(200, { rows: [] }),
      jsonResponse(200, { detail: 'nope' })
    ]) {
      const cache = new ServiceChatCache(local, { fetchImpl: (async () => bad) as unknown as typeof fetch })

      expect(await cache.read('researcher')).toBeNull()
    }

    const thrown = new ServiceChatCache(local, {
      fetchImpl: (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch
    })

    expect(await thrown.read('researcher')).toBeNull()
  })

  it('never writes back into the service', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse(200, answer()))
    const local = new MemoryChatCache()
    const cache = new ServiceChatCache(local, { fetchImpl: fetchImpl as unknown as typeof fetch })

    await cache.write({ bot: 'researcher', itemsJson: '{}', lastRowId: null, lastSeq: 0, epoch: null, updatedAt: 1 })
    await cache.writeBots([{ name: 'researcher', json: '{}', avatarRev: 0, updatedAt: 1 }])
    await cache.clear()

    // A client telling a server what a transcript says is not a cache, it is a
    // write path nobody asked for.
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('the snapshot the seam builds', () => {
  it('projects the service’s rows through the same function a live history read uses', () => {
    const snapshot = snapshotFromServiceAnswer(answer() as never)

    expect(snapshot.items).toHaveLength(2)
    expect(snapshot.lastRowId).toBe(2)
    // Milliseconds, because that is what the cache row carries everywhere else.
    expect(snapshot.updatedAt).toBe(1_700_000_050_000)
  })

  it('claims no event watermark, so the hydration that follows cannot skip a turn', () => {
    const snapshot = snapshotFromServiceAnswer(answer() as never)

    expect(snapshot.lastSeq).toBe(0)
    // The absence is the point: `stateFromCache` only adopts a watermark when a
    // session id comes with it, so this snapshot is read as cold and the replay
    // adopts the gateway's number instead of trusting the service's.
    expect(snapshot.lastSeqSessionId).toBeUndefined()

    const state = stateFromCache(
      'researcher',
      { storedSessionId: 'stored-researcher', resolvedSessionId: 'tip-researcher' },
      snapshot
    )

    expect(state.lastSeq).toBe(0)
    expect(state.hydration).toBe('cached')
  })

  it('hands out the ids the real history will keep', () => {
    // The no-jump assertion from `reconcile.test.ts`, applied across the two
    // sources rather than twice to one: a paint from the service and a
    // hydration from the gateway have to agree on every id, or the thread
    // remounts under the reader on open.
    const painted = stateFromCache(
      'researcher',
      { storedSessionId: 'stored-researcher', resolvedSessionId: 'tip-researcher' },
      snapshotFromServiceAnswer(answer() as never)
    )
    const hydrated = reconcile(painted, rowsToItems(HISTORY, 'rpc'))

    expect(hydrated.order).toEqual(painted.order)
  })
})

describe('opening a chat that only the service has seen', () => {
  const setup = (fetchImpl: typeof fetch) => {
    const gateway = new FakeChatGateway()
    const cache = new ServiceChatCache(new MemoryChatCache(), { fetchImpl })
    const botsController = new BotsController({ gateway, store: useBotsStore, cache })
    const controller = new ChatController({
      gateway,
      chats: useChatsStore,
      bots: useBotsStore,
      botsController,
      cache
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

    useBotsStore.getState().setBots([RESEARCHER])
    gateway.restMessages = null
    started.push(controller)

    return { gateway, controller }
  }

  it('reads the service before it dials, and paints before the socket answers', async () => {
    const order: string[] = []
    const fetchImpl = (async () => {
      order.push('cache')

      return jsonResponse(200, answer())
    }) as unknown as typeof fetch

    const { gateway, controller } = setup(fetchImpl)
    const open = controller.openChat(RESEARCHER)

    await open

    order.push(...gateway.methodOrder())

    // The read is awaited inside `paintFromCache`, which runs before the resume
    // — so the first frame is the service's rows and not a spinner.
    expect(order[0]).toBe('cache')
    expect(order[1]).toBe('session.resume')
  })

  it('does not move the thread when the gateway’s own history arrives', async () => {
    const { controller } = setup((async () => jsonResponse(200, answer())) as unknown as typeof fetch)

    await controller.openChat(RESEARCHER)

    const chat = useChatsStore.getState().chats.researcher!

    expect(chat.hydration).toBe('live')
    expect(chat.order).toHaveLength(2)
    // The same two ids the service's rows were painted under: the reconcile
    // matched them on row id rather than handing out new ones.
    expect(chat.order.map(id => chat.items[id]!.rowId)).toEqual([1, 2])
  })

  it('opens exactly as it always did when there is no service copy', async () => {
    const { controller } = setup((async () => jsonResponse(404, { error: 'not_cached' })) as unknown as typeof fetch)

    await controller.openChat(RESEARCHER)

    const chat = useChatsStore.getState().chats.researcher!

    expect(chat.hydration).toBe('live')
    expect(chat.order).toHaveLength(2)
  })
})
