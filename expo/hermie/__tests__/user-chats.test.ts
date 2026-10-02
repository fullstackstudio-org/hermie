/**
 * Per-user chats beside the shared Bot Chat — ADR-0007, amended 2026-09-22.
 *
 * What is pinned here is the part that cannot be looked at: the title a private
 * chat is born with, the ORDER of the three resolution steps, the flags it is
 * minted with, and the two places where getting it wrong splits a conversation
 * in half — a lookup that failed being read as "no chat", and a roster short
 * circuit opening the shared transcript for a bot the reader moved.
 */
import { BotsController } from '../src/features/bots/bots-controller'
import { ChatController } from '../src/features/chats/chat-controller'
import { classifyConversations, conversationActions } from '../src/features/sessions/session-model'
import { MemoryChatCache } from '../src/platform/chat-cache'
import { useChatsStore } from '../src/store/chats'
import {
  canHaveUserChat,
  isUserChatTitle,
  resolveUserChat,
  USER_CHAT_TITLE_MAX,
  userChatTitle
} from '../src/features/user-chats'
import { UserChatDirectory } from '../src/features/user-chats/user-chat-directory'
import { userChatSwitch } from '../src/features/user-chats/user-chat-switch'
import { botFromProfileRow, useBotsStore, type Bot } from '../src/store/bots'
import { FakeChatGateway } from './support/fake-chat-gateway'

const ROW = {
  name: 'researcher',
  path: '/root/.hermes/profiles/researcher',
  display_name: 'Researcher',
  model: 'example-provider/example-model',
  provider: 'example-provider',
  canonical_session: {
    id: 'stored-shared',
    resolved_id: 'stored-shared',
    title: 'Bot Chat',
    preview: 'Everyone can read this.',
    last_active: 1_700_000_100,
    message_count: 12
  }
}

const bot = (): Bot => botFromProfileRow(ROW)

const IDENTITY = { userId: 'ada@example.invalid', displayName: 'Ada Lovelace' }
const TITLE = 'Chat · Ada Lovelace'

const started: ChatController[] = []

afterEach(() => {
  for (const controller of started.splice(0)) {
    controller.stop()
  }

  useBotsStore.getState().reset()
  useChatsStore.getState().reset()
})

describe('the title is the identity', () => {
  it('prefers the display name and falls back to the user id', () => {
    expect(userChatTitle(IDENTITY)).toBe(TITLE)
    expect(userChatTitle({ userId: 'ada@example.invalid', displayName: '' })).toBe('Chat · ada@example.invalid')
    // A session-token gateway names the owner and nobody else; that is still a
    // name, so that deployment gets a private chat like any other.
    expect(userChatTitle({ userId: 'owner', displayName: '' })).toBe('Chat · owner')
  })

  it('offers nothing at all when the gateway named nobody', () => {
    expect(userChatTitle({ userId: '', displayName: 'Ada' })).toBe('')
    expect(userChatTitle(null)).toBe('')
    expect(canHaveUserChat({ userId: '', displayName: '' })).toBe(false)
    expect(canHaveUserChat(IDENTITY)).toBe(true)
  })

  it('cuts a very long name on a word boundary rather than mid-word', () => {
    const long = userChatTitle({ userId: 'x', displayName: 'Wilhelmina Alexandra Montgomery Fitzwilliam Bartholomew' })

    expect(long.startsWith('Chat · Wilhelmina Alexandra Montgomery')).toBe(true)
    expect(long.length).toBeLessThanOrEqual('Chat · '.length + USER_CHAT_TITLE_MAX)
    expect(long.endsWith(' ')).toBe(false)
    expect(isUserChatTitle(long)).toBe(true)
  })
})

describe('resolving one', () => {
  it('looks the title up before it creates anything, and mints it visible under the shared chat', async () => {
    const gateway = new FakeChatGateway()
    gateway.reply('session.list', () => ({ sessions: [] }))
    gateway.reply('session.create', () => ({ session_id: 'runtime-mine', stored_session_id: 'stored-mine' }))

    const session = await resolveUserChat({
      gateway,
      profile: 'researcher',
      title: TITLE,
      parentSessionId: 'stored-shared'
    })

    expect(session.id).toBe('stored-mine')
    // Twice, and only then a create: a backend still warming up answers the
    // first lookup with an empty list, and minting on that forks the chat.
    expect(gateway.methodOrder()).toEqual(['session.list', 'session.list', 'session.create'])
    expect(gateway.lastCall('session.list')).toMatchObject({
      profile: 'researcher',
      title: TITLE,
      include_hidden: true
    })
    expect(gateway.lastCall('session.create')).toMatchObject({
      profile: 'researcher',
      title: TITLE,
      hidden: false,
      follow_profile_config: true,
      parent_session_id: 'stored-shared'
    })
  })

  it('takes the existing row and creates nothing', async () => {
    const gateway = new FakeChatGateway()
    gateway.reply('session.list', () => ({
      sessions: [{ id: 'stored-mine', resolved_id: 'tip-mine', title: TITLE, preview: 'Only me.', message_count: 4 }]
    }))

    const session = await resolveUserChat({ gateway, profile: 'researcher', title: TITLE })

    expect(session).toMatchObject({ id: 'stored-mine', resolvedId: 'tip-mine', preview: 'Only me.', messageCount: 4 })
    expect(gateway.methodOrder()).toEqual(['session.list'])
  })

  it('fails closed when the registry cannot be read, rather than minting a second chat', async () => {
    const gateway = new FakeChatGateway()
    gateway.reply('session.list', () => {
      throw new Error('gateway is restarting')
    })

    await expect(resolveUserChat({ gateway, profile: 'researcher', title: TITLE })).rejects.toThrow(
      /not starting a new chat/u
    )
    expect(gateway.callsOf('session.create')).toHaveLength(0)
  })

  it('resolves once however many callers ask at the same time', async () => {
    const gateway = new FakeChatGateway()
    gateway.reply('session.list', () => ({ sessions: [] }))
    gateway.reply('session.create', () => ({ session_id: 'runtime-mine', stored_session_id: 'stored-mine' }))

    const directory = new UserChatDirectory({
      gateway,
      identity: () => IDENTITY,
      choice: () => 'mine'
    })

    const [first, second] = await Promise.all([directory.resolve(bot()), directory.resolve(bot())])

    expect(first.id).toBe('stored-mine')
    expect(second.id).toBe('stored-mine')
    expect(gateway.callsOf('session.create')).toHaveLength(1)

    // And a third ask, after the fact, is free.
    await directory.resolve(bot())
    expect(gateway.callsOf('session.create')).toHaveLength(1)
  })

  it('forgets what it resolved when the gateway names somebody else', async () => {
    const gateway = new FakeChatGateway()
    let identity = IDENTITY
    gateway.reply('session.list', params => ({
      sessions: [{ id: `stored-${String(params.title)}`, title: params.title }]
    }))

    const directory = new UserChatDirectory({ gateway, identity: () => identity, choice: () => 'mine' })

    expect((await directory.resolve(bot())).id).toBe(`stored-${TITLE}`)

    identity = { userId: 'grace@example.invalid', displayName: 'Grace' }

    expect(directory.cached('researcher')).toBeNull()
    expect((await directory.resolve(bot())).id).toBe('stored-Chat · Grace')
  })
})

describe('the roster follows the chosen chat', () => {
  const controllerWith = (gateway: FakeChatGateway, chose: () => boolean) => {
    const directory = new UserChatDirectory({
      gateway,
      identity: () => IDENTITY,
      choice: () => (chose() ? 'mine' : 'shared')
    })

    return new BotsController({
      gateway,
      store: useBotsStore,
      userChats: userChatSwitch({
        available: () => directory.available,
        title: () => directory.title,
        chose: name => directory.chose(name),
        cached: name => directory.cached(name),
        resolve: row => directory.resolve(row),
        remember: () => undefined
      })
    })
  }

  it('points the row at the private chat, so its preview and unread are the reader’s own', async () => {
    const gateway = new FakeChatGateway()
    gateway.reply('profiles.list', () => ({ profiles: [ROW] }))
    gateway.reply('session.list', () => ({
      sessions: [{ id: 'stored-mine', title: TITLE, preview: 'Only me.', message_count: 2 }]
    }))

    const controller = controllerWith(gateway, () => true)
    await controller.refresh()
    await controller.placeUserChats()

    expect(useBotsStore.getState().byName.researcher?.canonical?.id).toBe('stored-mine')
    expect(useBotsStore.getState().byName.researcher?.canonical?.preview).toBe('Only me.')
  })

  it('opens the private chat even before the roster has been re-pointed', async () => {
    const gateway = new FakeChatGateway()
    gateway.reply('session.list', () => ({ sessions: [{ id: 'stored-mine', title: TITLE }] }))

    const controller = controllerWith(gateway, () => true)
    // `bot()` still carries the SHARED canonical from `profiles.list`, which is
    // exactly the state a cold launch is in. A short circuit on it here is the
    // bug this asserts against.
    const resolved = await controller.resolveCanonical(bot())

    expect(resolved.id).toBe('stored-mine')
  })

  it('leaves every bot on the shared chat when the reader has not chosen otherwise', async () => {
    const gateway = new FakeChatGateway()
    gateway.reply('profiles.list', () => ({ profiles: [ROW] }))

    const controller = controllerWith(gateway, () => false)
    await controller.refresh()
    await controller.placeUserChats()

    expect(useBotsStore.getState().byName.researcher?.canonical?.id).toBe('stored-shared')
    expect(gateway.callsOf('session.list')).toHaveLength(0)
  })

  it('finds the shared chat again even while the roster is pinned to the private one', async () => {
    const gateway = new FakeChatGateway()
    gateway.reply('session.list', params =>
      String(params.title) === 'Bot Chat'
        ? { sessions: [{ id: 'stored-shared', title: 'Bot Chat' }] }
        : { sessions: [] }
    )

    const controller = controllerWith(gateway, () => true)
    const pinned: Bot = {
      ...bot(),
      canonical: { id: 'stored-mine', resolvedId: 'stored-mine', preview: '', lastActive: 0, messageCount: 0 }
    }

    expect((await controller.resolveShared(pinned)).id).toBe('stored-shared')
  })
})

describe('the Conversations page', () => {
  const rows = [
    { id: 'stored-shared', title: 'Bot Chat', preview: 'Shared.' },
    { id: 'stored-mine', title: TITLE, preview: 'Mine.' },
    { id: 'stored-past', title: 'Bot Chat · 2026-09-21 23:16', preview: 'Retired.' }
  ]

  it('gives the private chat a group of its own and leaves the canonical one canonical', () => {
    /*
      The roster's canonical is PINNED to the private chat while the reader is
      in it, which is why `canonicalId` is deliberately not passed here — see
      `ChatController.listConversations`. Without the `mine` test running first,
      `Bot Chat` would land in `past`, where Delete is offered.
    */
    const groups = classifyConversations({ rows, userChatId: 'stored-mine', userChatTitle: TITLE })

    expect(groups.mine?.id).toBe('stored-mine')
    expect(groups.mine?.kind).toBe('mine')
    expect(groups.canonical?.id).toBe('stored-shared')
    expect(groups.past.map(row => row.id)).toEqual(['stored-past'])
  })

  it('finds it by title on the first listing, before any id is known', () => {
    const groups = classifyConversations({ rows, userChatTitle: TITLE })

    expect(groups.mine?.id).toBe('stored-mine')
    expect(groups.canonical?.id).toBe('stored-shared')
  })

  it('has no such group on a gateway that named nobody', () => {
    const groups = classifyConversations({ rows })

    expect(groups.mine).toBeNull()
    // And the row is still listed, under the name whoever made it gave it.
    expect([...groups.past.map(row => row.id)].sort()).toEqual(['stored-mine', 'stored-past'])
  })

  it('offers the private chat nothing but Open', () => {
    const groups = classifyConversations({ rows, userChatTitle: TITLE })

    expect(conversationActions(groups.mine!)).toEqual(['open'])
    expect(conversationActions(groups.canonical!)).toEqual([])
    expect(conversationActions(groups.past[0]!)).toEqual(['open', 'rename', 'delete', 'adopt'])
  })
})

describe('the switch', () => {
  /** Enough of a gateway for one hydration, so the switch can be seen through. */
  const wired = (gateway: FakeChatGateway) =>
    gateway
      .reply('profiles.list', { profiles: [ROW] })
      .reply('session.resume', params => ({
        session_id: `runtime-${String(params.session_id)}`,
        stored_session_id: String(params.session_id),
        message_count: 0,
        messages: [],
        messages_omitted: true,
        info: { desktop_contract: 7 },
        open_requests: []
      }))
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

  const setup = (chosen: Record<string, true>) => {
    const gateway = new FakeChatGateway()
    wired(gateway)

    const cache = new MemoryChatCache()
    const directory = new UserChatDirectory({
      gateway,
      identity: () => IDENTITY,
      choice: name => (chosen[name] ? 'mine' : 'shared')
    })
    const switched = userChatSwitch({
      available: () => directory.available,
      title: () => directory.title,
      chose: name => directory.chose(name),
      cached: name => directory.cached(name),
      resolve: row => directory.resolve(row),
      remember: (name, choice) => {
        if (choice === 'mine') {
          chosen[name] = true
        } else {
          delete chosen[name]
        }
      }
    })
    const botsController = new BotsController({ gateway, store: useBotsStore, cache, userChats: switched })
    const controller = new ChatController({
      gateway,
      chats: useChatsStore,
      bots: useBotsStore,
      botsController,
      cache,
      userChats: switched
    })

    controller.start()
    started.push(controller)
    useBotsStore.getState().setBots([bot()])

    return { cache, chosen, controller, gateway }
  }

  it('moves the chat, the roster and the transcript cache together', async () => {
    const chosen: Record<string, true> = {}
    const { cache, controller, gateway } = setup(chosen)

    gateway.reply('session.list', () => ({ sessions: [{ id: 'stored-mine', title: TITLE }] }))
    await controller.openChat(bot())
    await cache.write({
      bot: 'researcher',
      itemsJson: '{}',
      lastRowId: null,
      lastSeq: null,
      epoch: null,
      updatedAt: 1
    })

    await controller.chooseChat(useBotsStore.getState().byName.researcher!, 'mine')

    expect(chosen.researcher).toBe(true)
    expect(useBotsStore.getState().byName.researcher?.canonical?.id).toBe('stored-mine')
    expect(useChatsStore.getState().chats.researcher?.storedSessionId).toBe('stored-mine')
    /*
      The disk cache is keyed by BOT, so what was on it is the conversation the
      reader has just left. Left there, the next cold open would paint the
      shared transcript under the private chat's ids.
    */
    expect(await cache.read('researcher')).toBeNull()
  })

  it('puts the choice back when the gateway refuses to resolve the chat', async () => {
    const chosen: Record<string, true> = {}
    const { controller, gateway } = setup(chosen)

    gateway.reply('session.list', () => {
      throw new Error('gateway is restarting')
    })

    await expect(controller.chooseChat(bot(), 'mine')).rejects.toThrow(/not starting a new chat/u)
    // A row that claimed the move happened while the transcript was still the
    // shared one is worse than the refusal.
    expect(chosen.researcher).toBeUndefined()
  })

  it('comes back to the shared chat by title, not by the pin it is sitting on', async () => {
    const chosen: Record<string, true> = { researcher: true }
    const { controller, gateway } = setup(chosen)

    gateway.reply('session.list', params =>
      String(params.title) === TITLE
        ? { sessions: [{ id: 'stored-mine', title: TITLE }] }
        : { sessions: [{ id: 'stored-shared', title: 'Bot Chat' }] }
    )

    await controller.openChat(bot())
    expect(useChatsStore.getState().chats.researcher?.storedSessionId).toBe('stored-mine')

    await controller.chooseChat(useBotsStore.getState().byName.researcher!, 'shared')

    expect(chosen.researcher).toBeUndefined()
    expect(useChatsStore.getState().chats.researcher?.storedSessionId).toBe('stored-shared')
  })

  it('refuses outright on a gateway that named nobody', async () => {
    const gateway = new FakeChatGateway()
    wired(gateway)

    const controller = new ChatController({
      gateway,
      chats: useChatsStore,
      bots: useBotsStore,
      botsController: new BotsController({ gateway, store: useBotsStore })
    })

    started.push(controller)

    await expect(controller.chooseChat(bot(), 'mine')).rejects.toThrow(/has not said who you are/u)
  })
})
