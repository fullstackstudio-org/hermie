/**
 * Sub-chats: the controller side of "one live conversation per bot, under the
 * bot's key" (plan `subchats.md`, Task 4).
 *
 * Everything here runs over a hand-written gateway, the way `user-chats.test.ts`
 * does, so what is pinned is the order and the arguments of the calls: which
 * session the key is on, what is remembered, what is minted (only "New chat"
 * mints), and which watermark a read moves.
 */
import type { GatewayHttp } from '@hermie/gateway-client'
import { PLUGIN_CAPABILITIES } from '@hermie/gateway-client/plugin'

import { BotsController } from '../src/features/bots/bots-controller'
import { ChatController, ConversationBusyError } from '../src/features/chats/chat-controller'
import type { Conversation } from '../src/features/sessions/session-model'
import { UserChatDirectory } from '../src/features/user-chats/user-chat-directory'
import { userChatSwitch } from '../src/features/user-chats/user-chat-switch'
import { MemoryChatCache } from '../src/platform/chat-cache'
import { botFromProfileRow, isOwnUnread, useBotsStore, type Bot } from '../src/store/bots'
import { useChatsStore } from '../src/store/chats'
import { usePluginStore } from '../src/store/plugin'
import { FakeChatGateway } from './support/fake-chat-gateway'

const GROUP = 'stored-group'
const LEAD = 'Chat · Ada Lovelace'
const IDENTITY = { userId: 'ada@example.invalid', displayName: 'Ada Lovelace' }
/** Fixed, so every stamp this run writes is one it can read back. */
const NOW = 1_790_000_000_000

const ROW = {
  name: 'researcher',
  path: '/root/.hermes/profiles/researcher',
  display_name: 'Researcher',
  canonical_session: {
    id: GROUP,
    resolved_id: GROUP,
    title: 'Bot Chat',
    preview: 'Everyone can read this.',
    last_active: 1_700_000_100,
    message_count: 3
  }
}

interface Row {
  id: string
  title: string
  message_count?: number
  started_at?: number
}

const started: ChatController[] = []

afterEach(() => {
  for (const controller of started.splice(0)) {
    controller.stop()
  }

  useBotsStore.getState().reset()
  useChatsStore.getState().reset()
  usePluginStore.getState().reset()
})

const bot = (): Bot => useBotsStore.getState().byName.researcher!
const chat = () => useChatsStore.getState().chats.researcher

/** The reader's memory, as `chat-layout` keeps it: an id per bot, or a legacy entry. */
function memory(initial: { current?: Record<string, string>; legacy?: string[] } = {}) {
  const current: Record<string, string> = { ...initial.current }
  const legacy = new Set(initial.legacy ?? [])
  /** Every write, with whether it was a chore (never outranks a choice) or a dated choice. */
  const writes: { name: string; id: string | null; chore: boolean }[] = []

  return {
    current,
    legacy,
    writes,
    target: (name: string): string | null | undefined => current[name] ?? (legacy.has(name) ? null : undefined),
    remember: (name: string, id: string | null) => {
      if (id === null) {
        delete current[name]
        legacy.delete(name)
      } else {
        current[name] = id
        legacy.add(name)
      }
    }
  }
}

function setup(
  options: {
    rows?: Row[]
    memory?: ReturnType<typeof memory>
    titleRefusals?: number
    http?: GatewayHttp
  } = {}
) {
  const gateway = new FakeChatGateway()
  const rows: Row[] = [{ id: GROUP, title: 'Bot Chat', message_count: 3 }, ...(options.rows ?? [])]
  const mind = options.memory ?? memory()
  let refusals = options.titleRefusals ?? 0
  let minted = 0

  gateway
    .reply('profiles.list', { profiles: [ROW] })
    .reply('session.list', () => ({ sessions: rows.map(row => ({ ...row, resolved_id: row.id })) }))
    .reply('session.resume', params => {
      const id = String(params.session_id)

      return {
        session_id: `runtime-${id}`,
        stored_session_id: id,
        message_count: rows.find(row => row.id === id)?.message_count ?? 0,
        messages: [],
        messages_omitted: true,
        info: { desktop_contract: 7 },
        open_requests: []
      }
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
    .reply('subagent.list', { subagents: [] })
    .reply('approval.pending', { approvals: [] })
    .reply('session.create', params => {
      minted += 1
      const id = `stored-new-${minted}`

      // Upstream persists no row for an empty draft: it appears only once titled.
      return { session_id: `runtime-${id}`, stored_session_id: id, pending_title: params.title }
    })
    .reply('session.title', params => {
      if (refusals > 0) {
        refusals -= 1
        throw Object.assign(new Error('Title is already in use'), { code: 4022 })
      }

      const runtime = String(params.session_id)
      const id = runtime.replace(/^runtime-/u, '')
      const title = String(params.title)
      const existing = rows.find(row => row.id === id)

      if (existing) {
        existing.title = title
      } else {
        rows.push({ id, title, message_count: 0 })
      }

      return { pending: false, title }
    })
    .reply('session.delete', params => {
      const at = rows.findIndex(row => row.id === params.session_id)

      if (at >= 0) {
        rows.splice(at, 1)
      }

      return { deleted: true }
    })
    .reply('session.set_hidden', params => ({ hidden: params.hidden === true }))
    .reply('session.close', { closed: true })
    .reply('prompt.submit', { status: 'streaming' })

  gateway.restMessages = null

  const cache = new MemoryChatCache()
  const directory = new UserChatDirectory({
    gateway,
    identity: () => IDENTITY,
    choice: name => (mind.target(name) !== undefined ? 'mine' : 'shared'),
    target: name => mind.target(name)
  })
  const switched = userChatSwitch({
    available: () => directory.available,
    title: () => directory.title,
    chose: name => directory.chose(name),
    cached: name => directory.cached(name),
    resolve: row => directory.resolve(row),
    remember: (name, choice) => {
      if (choice === 'mine') {
        mind.legacy.add(name)
      } else {
        mind.remember(name, null)
      }
    },
    target: name => directory.target(name),
    resolveTarget: row => directory.resolveTarget(row),
    rememberCurrent: (name, id, options) => {
      mind.writes.push({ name, id, chore: options?.chore === true })
      mind.remember(name, id)
    }
  })
  const botsController = new BotsController({
    gateway,
    store: useBotsStore,
    chats: useChatsStore,
    cache,
    userChats: switched
  })
  const controller = new ChatController({
    gateway,
    chats: useChatsStore,
    bots: useBotsStore,
    botsController,
    cache,
    userChats: switched,
    now: () => NOW,
    ...(options.http ? { http: options.http } : {})
  })

  controller.start()
  started.push(controller)
  useBotsStore.getState().setBots([botFromProfileRow(ROW)])

  return { botsController, cache, controller, gateway, mind, rows }
}

const own = (id: string, title: string, messageCount = 0): Conversation => ({
  id,
  resolvedId: id,
  title,
  preview: '',
  messageCount,
  lastActive: 0,
  kind: 'mine'
})

describe('opening a bot', () => {
  it('opens the group chat when the reader is on no chat of their own', async () => {
    const { controller, gateway } = setup()

    await controller.openChat(bot())

    expect(chat()?.storedSessionId).toBe(GROUP)
    expect(bot().current).toBeUndefined()
    expect(controller.readKeyFor('researcher')).toBe('researcher')
    expect(gateway.callsOf('session.create')).toHaveLength(0)
  })

  it('opens the own chat the reader is on, and leaves the canonical alone', async () => {
    const { controller, gateway } = setup({
      rows: [{ id: 'own-1', title: `${LEAD} · Ideas`, message_count: 4 }],
      memory: memory({ current: { researcher: 'own-1' } })
    })

    await controller.openChat(bot())

    expect(chat()?.storedSessionId).toBe('own-1')
    expect(bot().current?.id).toBe('own-1')
    expect(bot().canonical?.id).toBe(GROUP)
    expect(controller.readKeyFor('researcher')).toBe('researcher#own-1')
    expect(gateway.callsOf('session.create')).toHaveLength(0)

    // Opened on this device: the list's order, and the own chat's watermarks —
    // never the group chat's.
    const state = useBotsStore.getState()

    expect(state.lastOpened['own-1']).toBe(Math.floor(NOW / 1000))
    expect(state.lastSeen['researcher#own-1']).toBe(Math.floor(NOW / 1000))
    expect(state.seenCounts['researcher#own-1']).toBe(4)
    expect(state.lastSeen.researcher).toBeUndefined()
  })

  it('forgets a remembered id the listing no longer holds and opens the group chat', async () => {
    const mind = memory({ current: { researcher: 'own-gone' } })
    const { controller, gateway } = setup({ memory: mind })

    await controller.openChat(bot())

    expect(chat()?.storedSessionId).toBe(GROUP)
    expect(mind.target('researcher')).toBeUndefined()
    expect(gateway.callsOf('session.create')).toHaveLength(0)
  })

  it('resolves a legacy entry to the bare-lead chat by title and remembers its id', async () => {
    const mind = memory({ legacy: ['researcher'] })
    const { controller } = setup({ rows: [{ id: 'own-legacy', title: LEAD }], memory: mind })

    await controller.openChat(bot())

    expect(chat()?.storedSessionId).toBe('own-legacy')
    expect(mind.current.researcher).toBe('own-legacy')
  })

  it('mints nothing for a legacy entry whose chat is gone', async () => {
    const mind = memory({ legacy: ['researcher'] })
    const { botsController, controller, gateway } = setup({ memory: mind })

    await botsController.placeCurrentChats()
    await controller.openChat(bot())

    expect(chat()?.storedSessionId).toBe(GROUP)
    expect(gateway.callsOf('session.create')).toHaveLength(0)
  })
})

describe('switching conversations', () => {
  it('moves the key, remembers the choice and round-trips through the per-conversation cache', async () => {
    const { cache, controller, mind } = setup({ rows: [{ id: 'own-1', title: `${LEAD} · Ideas` }] })
    const forget = jest.spyOn(cache, 'forget')
    const read = jest.spyOn(cache, 'read')

    await controller.openChat(bot())
    await controller.selectConversation(bot(), own('own-1', `${LEAD} · Ideas`))

    expect(mind.current.researcher).toBe('own-1')
    expect(chat()?.storedSessionId).toBe('own-1')
    expect(bot().current?.id).toBe('own-1')
    expect(bot().canonical?.id).toBe(GROUP)
    // The group chat was written to ITS key on the way out.
    expect(await cache.read('researcher')).not.toBeNull()

    read.mockClear()
    await controller.selectConversation(bot(), null)

    expect(mind.target('researcher')).toBeUndefined()
    expect(chat()?.storedSessionId).toBe(GROUP)
    expect(bot().current).toBeUndefined()
    expect(read).toHaveBeenCalledWith('researcher')
    expect(await cache.read('researcher#own-1')).not.toBeNull()
    expect(forget).not.toHaveBeenCalled()
  })

  it('is a no-op on the conversation the bot is already on', async () => {
    const { controller, gateway } = setup({ rows: [{ id: 'own-1', title: `${LEAD} · Ideas` }] })

    await controller.openChat(bot())
    await controller.selectConversation(bot(), own('own-1', `${LEAD} · Ideas`))

    const resumes = gateway.callsOf('session.resume').length

    await controller.selectConversation(bot(), own('own-1', `${LEAD} · Ideas`))

    expect(gateway.callsOf('session.resume')).toHaveLength(resumes)
  })

  it('puts the memory and the previous conversation back when the switch is refused', async () => {
    const { cache, controller, gateway, mind } = setup({ rows: [{ id: 'own-1', title: `${LEAD} · Ideas` }] })

    await controller.openChat(bot())

    const forget = jest.spyOn(cache, 'forget')
    const resume = gateway.responders.get('session.resume')!

    gateway.reply('session.resume', params => {
      if (params.session_id === 'own-1') {
        throw new Error('gateway is restarting')
      }

      return resume(params)
    })

    await expect(controller.selectConversation(bot(), own('own-1', `${LEAD} · Ideas`))).rejects.toThrow(/restarting/u)
    expect(mind.target('researcher')).toBeUndefined()
    expect(bot().current).toBeUndefined()
    // On screen again, and live, by the time the refusal is reported.
    expect(chat()?.storedSessionId).toBe(GROUP)
    expect(chat()?.hydration).toBe('live')
    // Its cache entry was written on the way out and never forgotten.
    expect(forget).not.toHaveBeenCalled()
    expect(await cache.read('researcher')).not.toBeNull()
    // Written back as a dated choice, so a device that followed follows back.
    expect(mind.writes.at(-1)).toEqual({ name: 'researcher', id: null, chore: false })
  })

  it('writes the watermark of the conversation the reader leaves, not the group chat', async () => {
    const { controller } = setup({
      rows: [{ id: 'own-1', title: `${LEAD} · Ideas` }],
      memory: memory({ current: { researcher: 'own-1' } })
    })

    await controller.openChat(bot())
    useBotsStore.getState().reset()
    useBotsStore.getState().setBots([botFromProfileRow(ROW)])
    useBotsStore.getState().setCurrent('researcher', {
      id: 'own-1',
      resolvedId: 'own-1',
      preview: '',
      lastActive: 0,
      messageCount: 0
    })

    await controller.closeChat('researcher')

    expect(useBotsStore.getState().lastSeen['researcher#own-1']).toBe(Math.floor(NOW / 1000))
    expect(useBotsStore.getState().lastSeen.researcher).toBeUndefined()
  })
})

describe('New chat', () => {
  it('creates, titles at once on the runtime id, selects, and lists it', async () => {
    const { controller, gateway, mind } = setup()

    await controller.openChat(bot())

    const created = await controller.startOwnChat(bot())

    const create = gateway.lastCall('session.create')

    expect(create).toMatchObject({
      profile: 'researcher',
      hidden: false,
      follow_profile_config: true,
      parent_session_id: GROUP
    })
    expect(String(create?.title)).toMatch(/^Chat · Ada Lovelace · \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/u)
    expect(gateway.lastCall('session.title')).toMatchObject({
      session_id: 'runtime-stored-new-1',
      title: create?.title
    })
    expect(created.id).toBe('stored-new-1')
    expect(mind.current.researcher).toBe('stored-new-1')
    expect(chat()?.storedSessionId).toBe('stored-new-1')
    expect(useBotsStore.getState().lastOpened['stored-new-1']).toBe(Math.floor(NOW / 1000))

    const list = await controller.listBotConversations(bot())

    expect(list.group?.id).toBe(GROUP)
    expect(list.own.map(row => row.id)).toEqual(['stored-new-1'])
    expect(list.canCreate).toBe(true)
  })

  it('retries a title clash once with a seconds stamp', async () => {
    const { controller, gateway } = setup({ titleRefusals: 1 })

    await controller.openChat(bot())
    await controller.startOwnChat(bot())

    const titles = gateway.callsOf('session.title').map(call => String(call.title))

    expect(titles).toHaveLength(2)
    expect(titles[1]).toMatch(/ \d{2}:\d{2}:\d{2}$/u)
    expect(chat()?.storedSessionId).toBe('stored-new-1')
  })

  it('relabels a stamp from the first message, and leaves a given name alone', async () => {
    const { controller, gateway } = setup()

    await controller.openChat(bot())
    await controller.startOwnChat(bot())
    await controller.send('researcher', 'Plan the garden for next spring please')
    await new Promise<void>(resolve => setTimeout(resolve, 0))

    expect(String(gateway.lastCall('session.title')?.title)).toBe(`${LEAD} · Plan the garden for next spring`)

    await controller.renameOwnChat(bot(), 'stored-new-1', 'Garden')
    const before = gateway.callsOf('session.title').length

    useChatsStore.getState().settleTurn('researcher', { status: 'idle' })
    useChatsStore.getState().interrupt('researcher')
    await controller.send('researcher', 'And the orchard too')
    await new Promise<void>(resolve => setTimeout(resolve, 0))

    expect(gateway.callsOf('session.title')).toHaveLength(before)
  })

  it('refuses on a gateway that named nobody', async () => {
    const gateway = new FakeChatGateway()
    const controller = new ChatController({
      gateway,
      chats: useChatsStore,
      bots: useBotsStore,
      botsController: new BotsController({ gateway, store: useBotsStore })
    })

    started.push(controller)
    useBotsStore.getState().setBots([botFromProfileRow(ROW)])

    await expect(controller.startOwnChat(bot())).rejects.toThrow(/has not said who you are/u)
    expect(gateway.callsOf('session.create')).toHaveLength(0)
  })
})

describe('rename and delete', () => {
  it('renames the label only, on the runtime id', async () => {
    const { controller, gateway } = setup({ rows: [{ id: 'own-1', title: `${LEAD} · Ideas` }] })

    await controller.openChat(bot())

    await expect(controller.renameOwnChat(bot(), 'own-1', 'Plans')).resolves.toBe(`${LEAD} · Plans`)
    expect(gateway.lastCall('session.title')).toMatchObject({
      session_id: 'runtime-own-1',
      title: `${LEAD} · Plans`
    })
    await expect(controller.renameOwnChat(bot(), 'own-1', '   ')).rejects.toThrow(/needs a name/u)
    await expect(controller.renameOwnChat(bot(), GROUP, 'Mine now')).rejects.toThrow(/group chat/u)
  })

  it('falls back to the group chat when the current chat is deleted', async () => {
    const { cache, controller, gateway, mind } = setup({
      rows: [{ id: 'own-1', title: `${LEAD} · Ideas` }],
      memory: memory({ current: { researcher: 'own-1' } })
    })

    await controller.openChat(bot())
    expect(chat()?.storedSessionId).toBe('own-1')

    await controller.deleteOwnChat(bot(), 'own-1')

    expect(chat()?.storedSessionId).toBe(GROUP)
    expect(bot().current).toBeUndefined()
    expect(mind.target('researcher')).toBeUndefined()
    expect(gateway.lastCall('session.delete')).toMatchObject({ session_id: 'own-1', profile: 'researcher' })
    expect(await cache.read('researcher#own-1')).toBeNull()

    const state = useBotsStore.getState()

    expect(state.lastSeen['researcher#own-1']).toBeUndefined()
    expect(state.seenCounts['researcher#own-1']).toBeUndefined()
    expect(state.lastOpened['own-1']).toBeUndefined()
    expect((await controller.listBotConversations(bot())).own).toEqual([])
  })

  it('never deletes the group chat', async () => {
    const { controller, gateway } = setup()

    await controller.openChat(bot())

    await expect(controller.deleteOwnChat(bot(), GROUP)).rejects.toThrow(/group chat/u)
    expect(gateway.callsOf('session.delete')).toHaveLength(0)
  })
})

describe('/new', () => {
  it('starts another own chat inside an own chat and never touches the Bot Chat', async () => {
    const { controller, gateway, rows } = setup({
      rows: [{ id: 'own-1', title: `${LEAD} · Ideas` }],
      memory: memory({ current: { researcher: 'own-1' } })
    })

    await controller.openChat(bot())
    await controller.listBotConversations(bot())
    await controller.startNewConversation('researcher')

    expect(gateway.callsOf('session.set_hidden')).toHaveLength(0)
    expect(gateway.callsOf('session.create')).toHaveLength(1)
    expect(gateway.lastCall('session.create')).toMatchObject({ hidden: false, parent_session_id: GROUP })
    expect(chat()?.storedSessionId).toBe('stored-new-1')
    expect(rows.find(row => row.id === GROUP)?.title).toBe('Bot Chat')
    expect(rows.find(row => row.id === 'own-1')?.title).toBe(`${LEAD} · Ideas`)
    expect(bot().canonical?.id).toBe(GROUP)

    const said = chat()!
      .order.map(id => chat()!.items[id])
      .filter(item => item?.kind === 'notice')
      .map(item => JSON.stringify(item))
      .join('\n')

    expect(said).toMatch(/New chat started/u)
    expect(said).toMatch(/Ideas/u)
  })

  it('retires and re-mints the Bot Chat in the group chat, as before', async () => {
    const { controller, gateway, mind } = setup()

    await controller.openChat(bot())
    await controller.startNewConversation('researcher')

    expect(gateway.callsOf('session.create')).toHaveLength(1)
    expect(gateway.lastCall('session.create')).toMatchObject({ title: 'Bot Chat', hidden: true })
    expect(mind.target('researcher')).toBeUndefined()
    expect(bot().current).toBeUndefined()
  })
})

describe('the turn claim', () => {
  it('carries the runtime id of the conversation the bot is on', async () => {
    const posts: { path: string; body: unknown }[] = []
    const http = {
      baseUrl: 'https://gateway.example.invalid',
      requestHeaders: async () => ({}),
      post: async (path: string, body?: unknown) => {
        posts.push({ path, body })
      }
    } as unknown as GatewayHttp

    usePluginStore.getState().apply({
      version: '0.8.0',
      capabilities: [PLUGIN_CAPABILITIES.contextTurnClaim],
      modules: {},
      limits: {},
      updatedAt: 0
    })

    const { controller, gateway } = setup({ rows: [{ id: 'own-1', title: `${LEAD} · Ideas` }], http })

    await controller.openChat(bot())
    await controller.selectConversation(bot(), own('own-1', `${LEAD} · Ideas`))
    await controller.send('researcher', 'Hello there')

    expect(posts.at(-1)?.body).toEqual({ session_id: 'runtime-own-1' })
    expect(gateway.lastCall('prompt.submit')).toMatchObject({ session_id: 'runtime-own-1', profile: 'researcher' })
  })
})

describe('a choice made on another device', () => {
  it('never moves a chat open here, and applies when the reader next opens it', async () => {
    const mind = memory()
    const { botsController, controller } = setup({ rows: [{ id: 'own-1', title: `${LEAD} · Ideas` }], memory: mind })

    await controller.openChat(bot())
    expect(chat()?.storedSessionId).toBe(GROUP)

    // Another device picked one of the reader's own chats.
    mind.current.researcher = 'own-1'
    await botsController.placeCurrentChats()

    expect(chat()?.storedSessionId).toBe(GROUP)
    expect(bot().current).toBeUndefined()
    expect(controller.readKeyFor('researcher')).toBe('researcher')

    // A share, a Shortcut or a push tap reaching for the live chat: not moved.
    await controller.openChat(bot())
    expect(chat()?.storedSessionId).toBe(GROUP)

    // The reader opening the chat screen: that is the next open.
    await controller.closeChat('researcher')
    await controller.openChat(bot(), { follow: true })

    expect(chat()?.storedSessionId).toBe('own-1')
    expect(bot().current?.id).toBe('own-1')
  })

  it('is placed on the roster for a bot that is not open here', async () => {
    const mind = memory()
    const { botsController } = setup({ rows: [{ id: 'own-1', title: `${LEAD} · Ideas` }], memory: mind })

    mind.current.researcher = 'own-1'
    await botsController.placeCurrentChats()

    expect(bot().current?.id).toBe('own-1')
    expect(bot().canonical?.id).toBe(GROUP)
  })
})

describe('openSession', () => {
  it('lands an own chat in the chat, a branch in the viewer, and an unknown id on the current', async () => {
    const { controller } = setup({
      rows: [
        { id: 'own-1', title: `${LEAD} · Ideas` },
        { id: 'branch-1', title: 'Bot Chat · branch' }
      ]
    })

    await controller.openChat(bot())

    await expect(controller.openSession(bot(), 'own-1')).resolves.toEqual({ kind: 'current' })
    expect(chat()?.storedSessionId).toBe('own-1')
    await expect(controller.openSession(bot(), 'branch-1')).resolves.toEqual({ kind: 'viewer' })
    await expect(controller.openSession(bot(), 'nobody')).resolves.toEqual({ kind: 'current' })
    expect(chat()?.storedSessionId).toBe('own-1')
  })
})

describe('the old switch, until it goes', () => {
  it('picks a row instead of pinning the canonical', async () => {
    const { controller, mind } = setup({ rows: [{ id: 'own-legacy', title: LEAD }] })

    await controller.openChat(bot())
    await controller.chooseChat(bot(), 'mine')

    expect(chat()?.storedSessionId).toBe('own-legacy')
    expect(mind.current.researcher).toBe('own-legacy')
    expect(bot().current?.id).toBe('own-legacy')
    expect(bot().canonical?.id).toBe(GROUP)

    await controller.chooseChat(bot(), 'shared')

    expect(chat()?.storedSessionId).toBe(GROUP)
    expect(mind.target('researcher')).toBeUndefined()
  })
})

/** A `prompt.submit` that answers only when the test says so. */
function heldSubmit(gateway: FakeChatGateway): () => void {
  let release: () => void = () => undefined

  gateway.reply(
    'prompt.submit',
    () =>
      new Promise(resolve => {
        release = () => resolve({ status: 'streaming' })
      })
  )

  return () => release()
}

const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0))

describe('review: a switch never lands on a send in flight', () => {
  it('refuses to leave while a send is on its way, and relabels only the chat it was sent in', async () => {
    const { controller, gateway } = setup()

    await controller.openChat(bot())
    await controller.startOwnChat(bot())

    const release = heldSubmit(gateway)
    const sending = controller.send('researcher', 'Plan the garden for next spring please')

    await settle()
    await expect(controller.selectConversation(bot(), null)).rejects.toBeInstanceOf(ConversationBusyError)
    await expect(controller.startOwnChat(bot())).rejects.toBeInstanceOf(ConversationBusyError)

    release()
    await sending
    await settle()

    // Still in the own chat, and the rename went to IT, never to the Bot Chat.
    expect(chat()?.storedSessionId).toBe('stored-new-1')
    expect(gateway.callsOf('session.create')).toHaveLength(1)
    expect(gateway.callsOf('session.title').map(call => call.session_id)).toEqual([
      'runtime-stored-new-1',
      'runtime-stored-new-1'
    ])
  })
})

describe('review: switching is refused while something would be lost', () => {
  const busyChat = async () => {
    const context = setup({ rows: [{ id: 'own-1', title: `${LEAD} · Ideas` }] })

    await context.controller.openChat(bot())
    await context.controller.send('researcher', 'First')

    return context
  }

  it('while a reply runs', async () => {
    const { controller, gateway, mind } = await busyChat()

    await expect(controller.selectConversation(bot(), own('own-1', `${LEAD} · Ideas`))).rejects.toBeInstanceOf(
      ConversationBusyError
    )
    await expect(controller.openSession(bot(), 'own-1')).rejects.toBeInstanceOf(ConversationBusyError)
    await expect(controller.startOwnChat(bot())).rejects.toBeInstanceOf(ConversationBusyError)
    expect(gateway.callsOf('session.create')).toHaveLength(0)
    expect(mind.target('researcher')).toBeUndefined()
    expect(chat()?.storedSessionId).toBe(GROUP)
  })

  it('while the queue holds a message, and keeps it', async () => {
    const { controller } = await busyChat()

    await controller.send('researcher', 'Queued behind the reply')
    useChatsStore.getState().interrupt('researcher')
    expect(chat()?.turn.active).toBe(false)

    await expect(controller.selectConversation(bot(), own('own-1', `${LEAD} · Ideas`))).rejects.toBeInstanceOf(
      ConversationBusyError
    )
    expect(useChatsStore.getState().queues.researcher).toHaveLength(1)
    expect(chat()?.storedSessionId).toBe(GROUP)
  })

  it('when deleting the open chat', async () => {
    const { controller, gateway } = setup({
      rows: [{ id: 'own-1', title: `${LEAD} · Ideas` }],
      memory: memory({ current: { researcher: 'own-1' } })
    })

    await controller.openChat(bot())
    await controller.send('researcher', 'Still going')

    await expect(controller.deleteOwnChat(bot(), 'own-1')).rejects.toBeInstanceOf(ConversationBusyError)
    expect(gateway.callsOf('session.delete')).toHaveLength(0)
    expect(chat()?.storedSessionId).toBe('own-1')
  })
})

describe('review: delete waits for an open in the air', () => {
  it('leaves the chat being opened for the group chat before deleting it', async () => {
    const { controller, gateway } = setup({
      rows: [{ id: 'own-1', title: `${LEAD} · Ideas` }],
      memory: memory({ current: { researcher: 'own-1' } })
    })

    const opening = controller.openChat(bot())

    await controller.deleteOwnChat(bot(), 'own-1')
    await opening

    expect(chat()?.storedSessionId).toBe(GROUP)

    const order = gateway.calls.map(call => `${call.method}:${String(call.params.session_id ?? '')}`)

    expect(order.indexOf(`session.resume:${GROUP}`)).toBeLessThan(order.indexOf('session.delete:own-1'))
    expect(order.indexOf('session.resume:own-1')).toBeLessThan(order.indexOf(`session.resume:${GROUP}`))
  })
})

describe('review: a chat just read is never unread', () => {
  it('counts messages streamed in live when the reader leaves', async () => {
    const { controller } = setup({
      rows: [{ id: 'own-1', title: `${LEAD} · Ideas`, message_count: 0 }],
      memory: memory({ current: { researcher: 'own-1' } })
    })

    await controller.openChat(bot())
    await controller.send('researcher', 'Hello')
    useChatsStore.getState().interrupt('researcher')
    await controller.selectConversation(bot(), null)

    expect(isOwnUnread(useBotsStore.getState(), 'researcher#own-1', 1)).toBe(false)
  })

  it('takes the gateway count for the live chat once it is read to the end', async () => {
    const { controller, rows } = setup({
      rows: [{ id: 'own-1', title: `${LEAD} · Ideas`, message_count: 0 }],
      memory: memory({ current: { researcher: 'own-1' } })
    })

    await controller.openChat(bot())
    rows[1]!.message_count = 5
    await controller.closeChat('researcher')
    await controller.listBotConversations(bot())

    expect(isOwnUnread(useBotsStore.getState(), 'researcher#own-1', 5)).toBe(false)
  })
})

describe('review: resolution never fails an open', () => {
  it('clears a legacy entry that finds nothing, once', async () => {
    const mind = memory({ legacy: ['researcher'] })
    const { controller, gateway } = setup({ memory: mind })

    await controller.openChat(bot())

    expect(mind.target('researcher')).toBeUndefined()
    expect(mind.writes.at(-1)).toEqual({ name: 'researcher', id: null, chore: true })

    const listings = gateway.callsOf('session.list').length

    useChatsStore.getState().reset()
    await controller.openChat(bot())

    expect(gateway.callsOf('session.list')).toHaveLength(listings)
  })

  it('opens the group chat when the listing fails', async () => {
    const mind = memory({ current: { researcher: 'own-1' } })
    const { controller, gateway } = setup({ memory: mind })

    gateway.reply('session.list', () => {
      throw new Error('gateway is restarting')
    })

    await controller.openChat(bot())

    expect(chat()?.storedSessionId).toBe(GROUP)
    // Nothing was learnt, so nothing is forgotten.
    expect(mind.current.researcher).toBe('own-1')
  })
})

describe('review: /new <name> keeps the name through a clash', () => {
  it('numbers the name instead of stamping it', async () => {
    const { controller, gateway } = setup({ titleRefusals: 1 })

    await controller.openChat(bot())
    await controller.startOwnChat(bot(), { label: 'Ideas' })

    expect(gateway.callsOf('session.title').map(call => call.title)).toEqual([`${LEAD} · Ideas`, `${LEAD} · Ideas (2)`])
  })
})

describe('review: adopting from an own chat', () => {
  it('leaves the own chat under its own key before the key forgets it', async () => {
    const { cache, controller, gateway } = setup({
      rows: [
        { id: 'own-1', title: `${LEAD} · Ideas` },
        { id: 'past-1', title: 'Bot Chat · 2026-09-01 10:00' }
      ],
      memory: memory({ current: { researcher: 'own-1' } })
    })

    gateway.reply('session.set_title', { ok: true })
    await controller.openChat(bot())
    await controller.adoptAsCanonical('researcher', 'past-1')

    expect(await cache.read('researcher#own-1')).not.toBeNull()
    expect(useBotsStore.getState().lastSeen['researcher#own-1']).toBe(Math.floor(NOW / 1000))
    expect(chat()?.storedSessionId).toBe('past-1')
  })
})
