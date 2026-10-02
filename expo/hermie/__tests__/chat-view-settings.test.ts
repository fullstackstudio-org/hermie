import { keyValueStore } from '../src/platform/key-value-store'
import { DEFAULT_NAME_ORDER } from '../src/store/bot-names'
import { CHAT_VIEW_KEY, chatViewFor, DEFAULT_CHAT_VIEW, useSettingsStore } from '../src/store/settings'

import { NS_A } from './support/gateway-namespace'

beforeEach(async () => {
  useSettingsStore.getState().reset()
  await keyValueStore.delete(NS_A.key(CHAT_VIEW_KEY))
})

/** The store serialises its writes; this waits for the one just queued. */
const settled = () => new Promise(resolve => setTimeout(resolve, 0))

describe('chat view settings', () => {
  it('starts at Normal, bot-to-bot on, thinking off', () => {
    expect(DEFAULT_CHAT_VIEW).toEqual({ level: 'quiet', showBotToBot: true, showThinking: false })
  })

  it('lets a chat without an override follow the default as it moves', () => {
    useSettingsStore.getState().setDefaults({ level: 'verbose' })

    expect(chatViewFor(useSettingsStore.getState(), 'researcher').level).toBe('verbose')
  })

  it('pins a chat that has an override', () => {
    useSettingsStore.getState().setChatView('researcher', { level: 'quiet' })
    useSettingsStore.getState().setDefaults({ level: 'verbose' })

    expect(chatViewFor(useSettingsStore.getState(), 'researcher').level).toBe('quiet')
    expect(chatViewFor(useSettingsStore.getState(), 'writer').level).toBe('verbose')

    useSettingsStore.getState().resetChatView('researcher')

    expect(chatViewFor(useSettingsStore.getState(), 'researcher').level).toBe('verbose')
  })

  it('reads its settings back from the key-value store', async () => {
    // Hydrated first, because that is what tells the store which gateway these
    // settings belong to. Nothing is written before it knows.
    await useSettingsStore.getState().hydrate(NS_A)
    useSettingsStore.getState().setDefaults({ showThinking: true })
    useSettingsStore.getState().setChatView('writer', { level: 'quiet' })
    await settled()

    useSettingsStore.getState().reset()
    await useSettingsStore.getState().hydrate(NS_A)

    expect(useSettingsStore.getState().defaults.showThinking).toBe(true)
    expect(chatViewFor(useSettingsStore.getState(), 'writer').level).toBe('quiet')
  })

  /**
   * The default moved from `profile` to `display`, so a reader who had already
   * chosen the one that used to be the default must not be moved with it.
   * `undefined` and `'profile'` are the two cases that used to look alike.
   */
  it('keeps a stored name order that happens to equal the old default', async () => {
    await keyValueStore.setJson(NS_A.key(CHAT_VIEW_KEY), { botNameOrder: 'profile' })
    await useSettingsStore.getState().hydrate(NS_A)

    expect(useSettingsStore.getState().botNameOrder).toBe('profile')

    useSettingsStore.getState().reset()
    await keyValueStore.setJson(NS_A.key(CHAT_VIEW_KEY), {})
    await useSettingsStore.getState().hydrate(NS_A)

    expect(useSettingsStore.getState().botNameOrder).toBe(DEFAULT_NAME_ORDER)
    expect(DEFAULT_NAME_ORDER).toBe('display')
  })

  it('falls back to the defaults when the stored blob is from another build', async () => {
    await keyValueStore.setJson(NS_A.key(CHAT_VIEW_KEY), {
      defaults: { level: 'shouty' },
      perChat: { writer: 'nonsense' }
    })

    await useSettingsStore.getState().hydrate(NS_A)

    expect(useSettingsStore.getState().defaults).toEqual(DEFAULT_CHAT_VIEW)
    expect(useSettingsStore.getState().perChat).toEqual({})
  })
})
