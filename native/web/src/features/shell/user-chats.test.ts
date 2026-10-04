/**
 * The reader's own chats bound to this page's stores: who is asking is read when it is asked, the choice and the
 * memory are the arrangement's (`myChats`, `current`), the choice is written back as the reader's (dated) and a
 * correction as a chore, what talks to the gateway is a chunk that nothing fetches until it is needed, and the
 * roster is placed on the remembered chats whenever that memory changes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { botFromProfileRow } from '../../state/bots'
import { deviceContextStore } from '../../state/device-context'
import { layoutStore } from '../../state/layout'
import { FakeChatGateway } from '../../test-support/fake-chat-gateway'
import { followChosenChats, userChatsFor } from './user-chats'

beforeEach(() => {
  layoutStore.getState().reset()
  deviceContextStore.getState().reset()
})

afterEach(() => {
  layoutStore.getState().reset()
  deviceContextStore.getState().reset()
})

const named = (userId = 'ada@example.invalid', displayName = 'Ada Lovelace'): void =>
  deviceContextStore.getState().setIdentity({ gated: true, userId, displayName, email: '' })

const bot = (name = 'researcher') =>
  botFromProfileRow({ name, path: `/p/${name}`, display_name: name, canonical_session: undefined } as never)

describe('userChatsFor', () => {
  it('has no chat of the reader’s own until the gateway has said who they are, and reads that late', () => {
    const chats = userChatsFor(new FakeChatGateway())

    // Built before the identity was put in the store, as the session builds it.
    expect(chats.available).toBe(false)
    expect(chats.title).toBe('')

    named()
    expect(chats.available).toBe(true)
    expect(chats.title).toBe('Chat · Ada Lovelace')

    deviceContextStore.getState().retire()
    expect(chats.available).toBe(false)
  })

  it('names the owner on a gateway without sign-in', () => {
    deviceContextStore.getState().setIdentity({ gated: false, userId: 'owner', displayName: '', email: '' })

    expect(userChatsFor(new FakeChatGateway()).title).toBe('Chat · owner')
  })

  it('reads the choice and the memory from the arrangement', () => {
    named()

    const chats = userChatsFor(new FakeChatGateway())

    expect(chats.chose('researcher')).toBe(false)
    expect(chats.target?.('researcher')).toBeUndefined()

    layoutStore.getState().setCurrent('researcher', 'stored-mine')
    expect(chats.chose('researcher')).toBe(true)
    expect(chats.target?.('researcher')).toBe('stored-mine')

    layoutStore.getState().setCurrent('researcher', null)
    expect(chats.chose('researcher')).toBe(false)
    expect(chats.target?.('researcher')).toBeUndefined()
  })

  it('says nobody is on an own chat where nobody was named, whatever the arrangement remembers', () => {
    layoutStore.getState().setCurrent('researcher', 'stored-mine')

    const chats = userChatsFor(new FakeChatGateway())

    expect(chats.chose('researcher')).toBe(false)
    expect(chats.target?.('researcher')).toBeUndefined()
  })

  it('reads a legacy entry as the bare-lead chat, not yet an id', () => {
    named()
    layoutStore.getState().setMyChat('researcher', true)

    expect(userChatsFor(new FakeChatGateway()).target?.('researcher')).toBeNull()
  })

  it('writes the reader’s choice and the app’s own correction into the arrangement, the second as a chore', () => {
    named()

    const chats = userChatsFor(new FakeChatGateway())
    const before = layoutStore.getState().chores

    chats.remember('writer', 'mine')
    expect(layoutStore.getState().myChats.writer).toBe(true)
    chats.remember('writer', 'shared')
    expect(layoutStore.getState().myChats.writer).toBeUndefined()

    chats.rememberCurrent?.('researcher', 'stored-mine')
    expect(layoutStore.getState().current.researcher).toBe('stored-mine')
    expect(layoutStore.getState().chores).toBe(before)

    chats.rememberCurrent?.('researcher', null, { chore: true })
    expect(layoutStore.getState().current.researcher).toBeUndefined()
    expect(layoutStore.getState().chores).toBe(before + 1)
  })

  it('answers the group chat for a bot with nothing remembered without asking the gateway', async () => {
    named()

    const gateway = new FakeChatGateway()
    const chats = userChatsFor(gateway)

    expect(await chats.resolveTarget?.(bot())).toEqual({ kind: 'group' })
    expect(gateway.methodOrder()).toEqual([])
  })

  it('finds the chat the memory names by its id, in a listing, and forgets what is not there', async () => {
    named()

    const gateway = new FakeChatGateway()

    gateway.reply('session.list', () => ({ sessions: [{ id: 'stored-mine', title: 'Chat · Ada Lovelace' }] }))

    const chats = userChatsFor(gateway)

    layoutStore.getState().setCurrent('researcher', 'stored-mine')
    expect(await chats.resolveTarget?.(bot())).toMatchObject({
      kind: 'own',
      legacy: false,
      session: { id: 'stored-mine' }
    })

    layoutStore.getState().setCurrent('researcher', 'stored-gone')
    expect(await chats.resolveTarget?.(bot())).toEqual({ kind: 'missing', legacy: false })
  })

  it('resolves the reader’s chat on a bot once, keeps it for the list and forgets it with the person', async () => {
    named()

    const gateway = new FakeChatGateway()

    gateway.reply('session.list', () => ({ sessions: [] }))
    gateway.reply('session.create', () => ({ session_id: 'runtime-mine', stored_session_id: 'stored-mine' }))

    const chats = userChatsFor(gateway)

    expect(chats.cached('researcher')).toBeNull()

    const [first, second] = await Promise.all([chats.resolve(bot()), chats.resolve(bot())])

    expect(first.id).toBe('stored-mine')
    expect(second.id).toBe('stored-mine')
    expect(gateway.callsOf('session.create')).toHaveLength(1)
    expect(chats.cached('researcher')?.id).toBe('stored-mine')

    // Somebody else on the same page: nothing of the last person's is theirs.
    named('grace@example.invalid', 'Grace')
    expect(chats.cached('researcher')).toBeNull()
  })

  it('refuses to resolve where nobody was named', async () => {
    await expect(userChatsFor(new FakeChatGateway()).resolve(bot())).rejects.toThrow(/has not said who you are/u)
  })
})

describe('followChosenChats', () => {
  it('places the roster when the memory changes, and not for anything else', async () => {
    const bots = { placeCurrentChats: vi.fn(async () => undefined) }
    const stop = followChosenChats(bots)

    layoutStore.getState().setAccent('researcher', 'rose' as never)
    await Promise.resolve()
    expect(bots.placeCurrentChats).not.toHaveBeenCalled()

    layoutStore.getState().setCurrent('researcher', 'stored-mine')
    await Promise.resolve()
    expect(bots.placeCurrentChats).toHaveBeenCalledTimes(1)

    layoutStore.getState().setMyChat('writer', true)
    await Promise.resolve()
    expect(bots.placeCurrentChats).toHaveBeenCalledTimes(2)

    stop()
    layoutStore.getState().setCurrent('researcher', null)
    await Promise.resolve()
    expect(bots.placeCurrentChats).toHaveBeenCalledTimes(2)
  })

  it('does not fail the store when the placement does, or throws', async () => {
    const bots = { placeCurrentChats: vi.fn(() => Promise.reject(new Error('offline'))) }
    const stop = followChosenChats(bots)

    layoutStore.getState().setCurrent('researcher', 'stored-mine')
    await Promise.resolve()
    expect(layoutStore.getState().current.researcher).toBe('stored-mine')
    stop()

    const throwing = followChosenChats({
      placeCurrentChats: () => {
        throw new Error('sync')
      }
    })

    layoutStore.getState().setCurrent('researcher', null)
    await Promise.resolve()
    expect(layoutStore.getState().current.researcher).toBeUndefined()
    throwing()
  })
})
