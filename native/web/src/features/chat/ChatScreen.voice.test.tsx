/**
 * Reading aloud through the whole chat screen: the message menu offers "Read aloud" on what a bot said where the
 * browser can speak (and not where it cannot), choosing it says the reply flattened for the ear, the same row then
 * offers "Stop reading", a chat set to read on its own reads what arrives and not what was there, and the chat's
 * options say how. A fake `speechSynthesis` on the window; nothing is spoken.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetActiveLocale } from '../../i18n/active-locale'
import { botsStore } from '../../state/bots'
import { chatsStore } from '../../state/chats'
import { connectionStore } from '../../state/connection'
import { requestsStore } from '../../state/requests'
import { voiceSettingsStore } from '../../state/voice-settings'
import { assistantItem, chatWith, userItem } from '../../test-support/chat-fixtures'
import { aBot, resetShellStores, seedRoster } from '../../test-support/shell-stores'
import { voiceActivityStore } from '../voice/activity'
import { ChatRuntimeContext, type ChatScreenController } from './chat-runtime'
import { ChatScreen } from './ChatScreen'

interface Spoken {
  text: string
  lang: string
  rate: number
  onend: (() => void) | null
}

/** A synthesiser on the window; the utterances it was given are kept, to be finished by the test. */
function installSynthesis() {
  const spoken: Spoken[] = []
  let cancels = 0

  class FakeUtterance {
    lang = ''
    rate = 1
    onend: (() => void) | null = null
    onerror: (() => void) | null = null

    constructor(readonly text: string) {
      spoken.push(this as unknown as Spoken)
    }
  }

  Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: FakeUtterance })
  Object.defineProperty(window, 'speechSynthesis', {
    configurable: true,
    value: { speak: () => undefined, cancel: () => void (cancels += 1) }
  })

  return { spoken, cancels: () => cancels }
}

const removeSynthesis = (): void => {
  Reflect.deleteProperty(window, 'speechSynthesis')
  Reflect.deleteProperty(window, 'SpeechSynthesisUtterance')
}

function fakeController() {
  const controller = {
    openChat: vi.fn(async () => undefined),
    openSession: vi.fn(async () => ({ kind: 'current' as const })),
    openConversation: vi.fn(async () => undefined),
    loadOlder: vi.fn(async () => 'start' as const),
    readKeyFor: vi.fn((bot: string) => bot),
    closeChat: vi.fn(async () => undefined),
    send: vi.fn(async () => undefined),
    stopTurn: vi.fn(async () => undefined),
    editQueued: vi.fn((): string | undefined => undefined),
    deleteQueued: vi.fn(),
    steerQueued: vi.fn(async () => 'queued'),
    querySlash: vi.fn(async () => ({ items: [] })),
    runSlash: vi.fn(async () => ({})),
    slashRouteFor: vi.fn((): string | null => null),
    uploadFile: vi.fn(),
    uploadFileTo: vi.fn(),
    // What the options panel reads when it opens.
    modelOptions: vi.fn(async () => []),
    refreshOptions: vi.fn(async () => undefined),
    refreshUsage: vi.fn(async () => undefined),
    setOption: vi.fn(async () => ({}))
  }

  return controller as unknown as typeof controller & ChatScreenController
}

const ITEMS = [
  userItem('Say something', { rowId: 1 }, 'u1'),
  assistantItem('Autumn **moonlight**.', { rowId: 2 }, 'a1')
]

function mount() {
  render(
    <ChatRuntimeContext.Provider value={{ controller: fakeController(), gatewayBaseUrl: 'http://gateway.test' }}>
      <ChatScreen bot="researcher" />
    </ChatRuntimeContext.Provider>
  )
}

const message = (id: string): HTMLElement => document.querySelector<HTMLElement>(`[data-message-id="${id}"]`)!
const settle = (): Promise<void> => act(async () => undefined)

/** Open a message's menu and say which lines it has. */
async function menuOf(id: string): Promise<string[]> {
  fireEvent.contextMenu(message(id).querySelector('.hm-bubble') ?? message(id))

  return (await screen.findAllByRole('menuitem')).map(line => line.textContent ?? '')
}

beforeEach(() => {
  resetShellStores()
  resetActiveLocale()
  botsStore.getState().reset?.()
  requestsStore.getState().reset()
  connectionStore.getState().setStatus('ready', null)
  seedRoster([aBot('researcher', { displayName: 'Dr. Researcher' })])
  chatsStore.getState().hydrate('researcher', chatWith('researcher', ITEMS, { runtimeSessionId: 'rt-1' }))
})

afterEach(() => {
  removeSynthesis()
  voiceActivityStore.getState().setDictating(false)
  voiceSettingsStore.getState().reset()
})

describe('where the browser can speak', () => {
  it('offers Read aloud under the copies of a reply, and none on the reader’s own turn', async () => {
    installSynthesis()
    mount()
    await settle()

    expect(await menuOf('a1')).toEqual([
      'Copy text',
      'Copy as Markdown',
      'Read aloud',
      'Regenerate',
      'Branch from here'
    ])
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())

    expect(await menuOf('u1')).not.toContain('Read aloud')
  })

  it('says the reply flattened for the ear, and then offers Stop reading on that row', async () => {
    const { cancels, spoken } = installSynthesis()

    mount()
    await settle()
    await menuOf('a1')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Read aloud' }))

    await waitFor(() => expect(spoken).toHaveLength(1))
    expect(spoken[0]).toMatchObject({ text: 'Autumn moonlight.', rate: 1 })

    expect(await menuOf('a1')).toContain('Stop reading')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Stop reading' }))

    await waitFor(() => expect(cancels()).toBeGreaterThan(0))
    await waitFor(async () => expect(await menuOf('a1')).toContain('Read aloud'))
  })

  it('says it at the rate the reader chose', async () => {
    const { spoken } = installSynthesis()

    voiceSettingsStore.getState().setRate(1.5)
    mount()
    await settle()
    await menuOf('a1')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Read aloud' }))

    await waitFor(() => expect(spoken[0]?.rate).toBe(1.5))
  })

  it('has no Read aloud while the microphone is open', async () => {
    installSynthesis()
    voiceActivityStore.getState().setDictating(true)
    mount()
    await settle()

    expect(await menuOf('a1')).not.toContain('Read aloud')
  })

  it('reads what arrives in a chat that reads on its own, and not what was there', async () => {
    const { spoken } = installSynthesis()

    voiceSettingsStore.getState().setAutoRead('researcher', true)
    mount()
    await settle()
    // Seeded by the transcript on screen: the back catalogue is not read.
    await waitFor(() => expect(spoken).toHaveLength(0))

    act(() =>
      chatsStore.getState().hydrate(
        'researcher',
        chatWith('researcher', [...ITEMS, assistantItem('A new reply.', { rowId: 3 }, 'a2')], {
          runtimeSessionId: 'rt-1'
        })
      )
    )

    await waitFor(() => expect(spoken.map(entry => entry.text)).toEqual(['A new reply.']))
  })
})

describe('where it cannot', () => {
  it('has no Read aloud line on any message', async () => {
    mount()
    await settle()

    expect(await menuOf('a1')).toEqual(['Copy text', 'Copy as Markdown', 'Regenerate', 'Branch from here'])
  })

  it('has no read aloud option in the chat’s options either', async () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Chat options' }))

    const panel = await screen.findByRole('group', { name: 'What this conversation shows' })

    expect(within(panel).queryByRole('checkbox', { name: 'Read replies aloud' })).toBeNull()
  })
})

describe('the chat’s options', () => {
  it('switch the automatic read for this chat, on this browser', async () => {
    installSynthesis()
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Chat options' }))

    const panel = await screen.findByRole('group', { name: 'What this conversation shows' })
    const box = within(panel).getByRole('checkbox', { name: 'Read replies aloud' }) as HTMLInputElement

    expect(box.checked).toBe(false)
    expect(box.getAttribute('aria-describedby')).toBeTruthy()

    fireEvent.click(box)

    expect(voiceSettingsStore.getState().autoReadByChat).toEqual({ researcher: true })
    expect((within(panel).getByRole('checkbox', { name: 'Read replies aloud' }) as HTMLInputElement).checked).toBe(true)
  })

  it('offer a way to stop a read that is going, and only while one is', async () => {
    installSynthesis()
    mount()
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Chat options' }))

    const panel = await screen.findByRole('group', { name: 'What this conversation shows' })

    expect(within(panel).queryByRole('button', { name: 'Stop reading' })).toBeNull()

    // A read begun from a row, with the options open over the page.
    fireEvent.contextMenu(message('a1').querySelector('.hm-bubble') ?? message('a1'))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Read aloud' }))

    fireEvent.click(await within(panel).findByRole('button', { name: 'Stop reading' }))
    await waitFor(() => expect(within(panel).queryByRole('button', { name: 'Stop reading' })).toBeNull())
  })
})
