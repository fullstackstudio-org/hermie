/**
 * The chats field, searching messages as well as names.
 *
 * Driven through the real hook and the real controller against a stubbed http,
 * because the three things worth asserting are all about timing and shape: the
 * debounce, the section landing BELOW the name matches, and a tap carrying the
 * query into the chat.
 */
import { act, fireEvent, screen } from '@testing-library/react-native'

import { BotsScreen } from '../src/features/bots'
import { SEARCH_DEBOUNCE_MS } from '../src/features/search'
import { type Bot, useBotsStore } from '../src/store/bots'
import { useChatLayoutStore } from '../src/store/chat-layout'
import { useChatsStore } from '../src/store/chats'
import { renderScreen } from './support/render'

const asked: string[] = []
let answers: Record<string, unknown> = {}

/**
 * `mockGateway`, and the stub http inside it, and both spellings are forced.
 *
 * `babel-plugin-jest-hoist` lifts the declarations a `jest.mock` factory
 * mentions to the top of the file, so a `const http` declared beside a plain
 * `gateway` is still undefined when the gateway literal is evaluated — the hook
 * then sees a gateway with no REST surface and searches nothing, silently, with
 * every test still rendering. Putting the stub inside the object fixes that and
 * makes the declaration un-hoistable (it calls `jest.fn`), which is what the
 * `mock` prefix is the documented escape hatch for.
 */
const mockGateway = {
  status: 'ready',
  config: { baseUrl: 'https://gateway.example.com', authMode: 'native_pkce' },
  http: {
    get: jest.fn(async (path: string) => {
      const profile = new URL(path, 'http://x').searchParams.get('profile') ?? ''

      asked.push(profile)

      return answers[profile] ?? { results: [] }
    })
  }
}

const http = mockGateway.http

jest.mock('../src/gateway', () => ({
  useGateway: () => mockGateway,
  hostOf: (url: string) => url.replace(/^https:\/\//, '')
}))

jest.mock('../src/gateway/GatewayProvider', () => ({
  useGateway: () => ({
    ...mockGateway,
    adoptTokens: jest.fn(),
    signOut: jest.fn(),
    changeGateway: jest.fn(),
    extraHeaders: {}
  })
}))

jest.mock('../src/features/chats/ChatRuntime', () => ({ useChatRuntime: () => null }))

const bot = (name: string, displayName: string): Bot => ({
  name,
  displayName,
  description: '',
  model: 'm',
  provider: 'p',
  isDefault: false,
  hasAvatar: false,
  uiMetaRevision: 0,
  canonical: { id: `stored-${name}`, resolvedId: `stored-${name}`, preview: '', lastActive: 0, messageCount: 2 }
})

const ROSTER = [bot('researcher', 'Researcher'), bot('writer', 'Writer')]

/** Let the debounce fire and the fan-out settle. */
async function settle() {
  await act(async () => {
    jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS + 10)
  })
  await act(async () => Promise.resolve())
}

beforeEach(() => {
  jest.useFakeTimers()
  asked.length = 0
  http.get.mockClear()
  answers = {}
  useBotsStore.getState().reset()
  useChatsStore.getState().reset()
  useChatLayoutStore.getState().reset()
  useBotsStore.getState().setBots(ROSTER)
})

afterEach(() => {
  jest.useRealTimers()
})

describe('searching messages from the chats field', () => {
  it('asks nothing until the field has been still', async () => {
    renderScreen(<BotsScreen />)

    fireEvent.changeText(screen.getByTestId('bots-search'), 'inv')
    fireEvent.changeText(screen.getByTestId('bots-search'), 'invo')
    fireEvent.changeText(screen.getByTestId('bots-search'), 'invoice')

    expect(http.get).not.toHaveBeenCalled()

    await settle()

    // One round per bot, and only for the query that survived the typing.
    expect(asked.sort()).toEqual(['researcher', 'writer'])
    expect(http.get.mock.calls.every(call => String(call[0]).includes('q=invoice'))).toBe(true)
  })

  it('shows the matches under a heading, with the gateway’s own snippet', async () => {
    answers = {
      writer: {
        results: [
          {
            session_id: 'stored-writer',
            snippet: 'about the >>>invoice<<< again',
            last_active: Math.floor(Date.now() / 1000) - 60
          }
        ]
      }
    }

    renderScreen(<BotsScreen />)
    fireEvent.changeText(screen.getByTestId('bots-search'), 'invoice')
    await settle()

    expect(screen.getByTestId('message-matches-header')).toBeTruthy()
    expect(screen.getByTestId('message-match-writer')).toBeTruthy()
    // The matched run is its own `Text`, which is what lets it be emphasised:
    // the markers are the gateway's account of what FTS5 hit, and a prefix term
    // hits a longer word than the one that was typed.
    expect(screen.getByText('invoice')).toBeTruthy()
    expect(screen.getByText(/about the/)).toBeTruthy()
  })

  it('still says "no conversation matches" when only a message matched', async () => {
    // The line used to be the list's empty component, and a list with a message
    // section in it is never empty. A name search that found nothing has to keep
    // saying so.
    answers = { writer: { results: [{ session_id: 'stored-writer', snippet: '>>>invoice<<<' }] } }

    renderScreen(<BotsScreen />)
    fireEvent.changeText(screen.getByTestId('bots-search'), 'invoice')
    await settle()

    expect(screen.getByTestId('bots-empty')).toBeTruthy()
    expect(screen.getByTestId('message-match-writer')).toBeTruthy()
  })

  it('opens that bot’s chat carrying the query, so the chat can find the row', async () => {
    answers = { writer: { results: [{ session_id: 'stored-writer', snippet: '>>>invoice<<<' }] } }

    const onOpenBot = jest.fn()

    renderScreen(<BotsScreen onOpenBot={onOpenBot} />)
    fireEvent.changeText(screen.getByTestId('bots-search'), 'invoice')
    await settle()

    fireEvent.press(screen.getByTestId('message-match-writer'))

    expect(onOpenBot).toHaveBeenCalledWith(expect.objectContaining({ name: 'writer' }), { findText: 'invoice' })
  })

  it('clears the section the moment the field is emptied', async () => {
    answers = { writer: { results: [{ session_id: 'stored-writer', snippet: '>>>invoice<<<' }] } }

    renderScreen(<BotsScreen />)
    fireEvent.changeText(screen.getByTestId('bots-search'), 'invoice')
    await settle()

    expect(screen.getByTestId('message-match-writer')).toBeTruthy()

    fireEvent.changeText(screen.getByTestId('bots-search'), '')

    expect(screen.queryByTestId('message-matches-header')).toBeNull()
  })
})
