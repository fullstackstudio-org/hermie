/**
 * Per-user chats beside the shared Bot Chat (ADR-0007, amended): the part that cannot be looked at. The title a
 * private chat is born with, the ORDER of the three resolution steps, the flags it is minted with, a lookup that
 * failed read as a failure and not as "no chat", one resolution however many callers ask, and the memory that goes
 * with the person.
 *
 * Ported from the Expo app's `__tests__/user-chats.test.ts` (jest) to vitest: the title, the resolution and the
 * directory. The roster and the switch they sit under are `sub-chats-controller.test.ts`'s.
 */
import { describe, expect, it } from 'vitest'

import { botFromProfileRow, type Bot } from '../../state/bots'
import { FakeChatGateway } from '../../test-support/fake-chat-gateway'
import {
  canHaveUserChat,
  isUserChatTitle,
  lookupOwnChatById,
  resolveUserChat,
  USER_CHAT_TITLE_MAX,
  userChatTitle
} from './user-chat'
import { UserChatDirectory } from './user-chat-directory'

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

describe('the title is the identity', () => {
  it('prefers the display name and falls back to the user id', () => {
    expect(userChatTitle(IDENTITY)).toBe(TITLE)
    expect(userChatTitle({ userId: 'ada@example.invalid', displayName: '' })).toBe('Chat · ada@example.invalid')
    // A gateway without sign-in names the owner and nobody else; that is still a name, so it gets a chat of its own.
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
    // Twice, and only then a create: a backend still warming up answers the first lookup with an empty list, and
    // minting on that forks the chat.
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

  it('refuses a created chat that came back without an id', async () => {
    const gateway = new FakeChatGateway()

    gateway.reply('session.list', () => ({ sessions: [] }))
    gateway.reply('session.create', () => ({}))

    await expect(resolveUserChat({ gateway, profile: 'researcher', title: TITLE })).rejects.toThrow(
      /without returning its id/u
    )
  })

  it('finds a remembered chat by its id, only while it still wears the reader’s title', async () => {
    const gateway = new FakeChatGateway()

    gateway.reply('session.list', () => ({
      sessions: [
        { id: 'stored-a', title: `${TITLE} · Trip planning` },
        { id: 'stored-b', title: 'Chat · Somebody Else' }
      ]
    }))

    expect(
      await lookupOwnChatById({ gateway, profile: 'researcher', lead: TITLE, storedId: 'stored-a' })
    ).toMatchObject({
      id: 'stored-a'
    })
    expect(await lookupOwnChatById({ gateway, profile: 'researcher', lead: TITLE, storedId: 'stored-b' })).toBeNull()
    expect(await lookupOwnChatById({ gateway, profile: 'researcher', lead: TITLE, storedId: 'gone' })).toBeNull()
  })

  it('says a failed listing failed, and does not answer that the chat is gone', async () => {
    const gateway = new FakeChatGateway()

    gateway.reply('session.list', () => {
      throw new Error('timed out')
    })

    await expect(
      lookupOwnChatById({ gateway, profile: 'researcher', lead: TITLE, storedId: 'stored-a' })
    ).rejects.toThrow(/Could not list researcher's conversations/u)
  })

  it('resolves once however many callers ask at the same time', async () => {
    const gateway = new FakeChatGateway()

    gateway.reply('session.list', () => ({ sessions: [] }))
    gateway.reply('session.create', () => ({ session_id: 'runtime-mine', stored_session_id: 'stored-mine' }))

    const directory = new UserChatDirectory({ gateway, identity: () => IDENTITY, choice: () => 'mine' })
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

describe('the directory', () => {
  const directory = (identity: { userId: string; displayName: string } | null, mine = false) =>
    new UserChatDirectory({
      gateway: new FakeChatGateway(),
      identity: () => identity,
      choice: () => (mine ? 'mine' : 'shared'),
      target: () => undefined
    })

  it('has no private chat to offer where nobody was named, and refuses to make one', async () => {
    const none = directory(null)

    expect(none.available).toBe(false)
    expect(none.chose('researcher')).toBe(false)
    await expect(none.resolve(bot())).rejects.toThrow(/has not said who you are/u)
  })

  it('says a bot is on the private chat only while the gateway names the reader', () => {
    expect(directory(IDENTITY, true).chose('researcher')).toBe(true)
    expect(directory(IDENTITY, false).chose('researcher')).toBe(false)
    expect(directory(null, true).chose('researcher')).toBe(false)
  })

  it('knows it tracks sub-chats only when it was given the memory', () => {
    expect(directory(IDENTITY).tracksCurrent).toBe(true)
    expect(
      new UserChatDirectory({ gateway: new FakeChatGateway(), identity: () => IDENTITY, choice: () => 'shared' })
        .tracksCurrent
    ).toBe(false)
  })
})
