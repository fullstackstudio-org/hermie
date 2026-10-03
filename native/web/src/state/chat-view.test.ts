import { beforeEach, describe, expect, it } from 'vitest'

import { createKeyValueStore } from '../platform/key-value-store'
import {
  asViewPatch,
  CHAT_VIEW_KEY,
  chatViewFor,
  createChatViewStore,
  DEFAULT_CHAT_VIEW,
  hasChatViewOverride
} from './chat-view'

const NAMESPACE = '/test-chat-view'

beforeEach(() => {
  localStorage.clear()
})

const storage = () => createKeyValueStore({ namespace: NAMESPACE, storage: localStorage })

describe('the chat view', () => {
  it('follows the default until a chat pins its own, and then keeps it', () => {
    const store = createChatViewStore()

    store.getState().hydrate(storage())
    expect(chatViewFor(store.getState(), 'researcher')).toEqual(DEFAULT_CHAT_VIEW)
    expect(hasChatViewOverride(store.getState(), 'researcher')).toBe(false)

    store.getState().setChatView('researcher', { level: 'quiet' })
    store.getState().setDefaults({ showThinking: true, level: 'verbose' })

    // The override pins only what it names; the rest still follows the default.
    expect(chatViewFor(store.getState(), 'researcher')).toEqual({
      level: 'quiet',
      showBotToBot: true,
      showThinking: true
    })
    expect(chatViewFor(store.getState(), 'writer').level).toBe('verbose')

    store.getState().resetChatView('researcher')
    expect(hasChatViewOverride(store.getState(), 'researcher')).toBe(false)
    expect(chatViewFor(store.getState(), 'researcher').level).toBe('verbose')
  })

  it('is kept under an identity-bound key, and read back on the next visit', () => {
    const first = createChatViewStore()

    first.getState().hydrate(storage())
    first.getState().setChatView('researcher', { showBotToBot: false })

    expect(CHAT_VIEW_KEY.startsWith('device.')).toBe(false)

    const second = createChatViewStore()

    second.getState().hydrate(storage())
    expect(chatViewFor(second.getState(), 'researcher').showBotToBot).toBe(false)
  })

  it('reads what is stored defensively', () => {
    storage().setSync(
      CHAT_VIEW_KEY,
      JSON.stringify({
        defaults: { level: 'loud', showThinking: 'yes', showBotToBot: false },
        perChat: { researcher: { level: 'quiet', extra: 1 }, writer: 'nonsense', empty: {} }
      })
    )

    const store = createChatViewStore()

    store.getState().hydrate(storage())
    expect(store.getState().defaults).toEqual({ ...DEFAULT_CHAT_VIEW, showBotToBot: false })
    expect(store.getState().perChat).toEqual({ researcher: { level: 'quiet' } })

    storage().setSync(CHAT_VIEW_KEY, '{not json')
    store.getState().hydrate(storage())
    expect(store.getState().defaults).toEqual(DEFAULT_CHAT_VIEW)
    expect(asViewPatch(['quiet'])).toEqual({})
  })

  it('does not write anything for a reset of a chat that had no view of its own', () => {
    const store = createChatViewStore()

    store.getState().hydrate(storage())
    store.getState().resetChatView('toString')

    expect(storage().getSync(CHAT_VIEW_KEY)).toBeNull()
  })
})
