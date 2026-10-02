/**
 * Landing on the row a search hit was about.
 *
 * The gateway matched a CONVERSATION and cannot say which row (see
 * `features/search`), so this is the half that has to find it again from the
 * query — and, when it cannot, say so out loud. A chat that opens at the bottom
 * with no explanation is how a working search reads as a broken one.
 */
import { screen, waitFor } from '@testing-library/react-native'
import { FlatList } from 'react-native'

import { ChatScreen } from '../src/features/chats/ChatScreen'
import { type Bot, useBotsStore } from '../src/store/bots'
import { useChatsStore } from '../src/store/chats'
import { useSettingsStore } from '../src/store/settings'

import { renderScreen } from './support/render'

let mockController: Record<string, jest.Mock>
let mockRuntime: {
  controller: Record<string, jest.Mock>
  bots: Record<string, never>
  push: { setOpenChat: jest.Mock }
}

jest.mock('../src/gateway', () => ({
  useGateway: () => ({ config: { baseUrl: 'https://gateway.example.com' }, http: null, status: 'ready' })
}))

jest.mock('../src/features/chats/ChatRuntime', () => ({ useChatRuntime: () => mockRuntime }))
jest.mock('../src/platform/haptics', () => ({ haptic: jest.fn() }))
jest.mock('../src/features/chats/attachments', () => ({
  MAX_ATTACHMENT_EDGE: 1568,
  openAppSettings: jest.fn(),
  pickAttachment: jest.fn(async () => null)
}))

const BOT: Bot = {
  name: 'researcher',
  displayName: 'Researcher',
  description: '',
  model: 'example-provider/example-model',
  provider: 'example-provider',
  isDefault: false,
  hasAvatar: false,
  uiMetaRevision: 0,
  canonical: { id: 'stored-researcher', resolvedId: 'stored-researcher', preview: '', lastActive: 1, messageCount: 2 }
}

/** Two assistant turns, so "the newest match" has something to be newer than. */
function seedChat(texts: string[]) {
  useBotsStore.getState().reset()
  useChatsStore.getState().reset()
  useSettingsStore.getState().reset()
  useBotsStore.getState().setBots([BOT])

  const chats = useChatsStore.getState()

  chats.ensure('researcher', { storedSessionId: 'stored-researcher', resolvedSessionId: 'stored-researcher' })
  chats.bindRuntime('researcher', 'runtime-1')
  chats.setHydration('researcher', 'live')

  for (const text of texts) {
    chats.dispatchEvent('researcher', {
      type: 'message.complete',
      session_id: 'runtime-1',
      payload: { text, status: 'ok' }
    })
  }
}

beforeEach(() => {
  mockController = {
    openChat: jest.fn(async () => undefined),
    closeChat: jest.fn(async () => undefined),
    readKeyFor: (name: string) => name,
    loadOlder: jest.fn(async () => 'start' as const),
    refreshOptions: jest.fn(async () => null),
    knowsSlashCommand: jest.fn(() => false),
    querySlash: jest.fn(async () => ({ items: [] })),
    setOption: jest.fn(async () => ({})),
    modelOptions: jest.fn(async () => [])
  }
  mockRuntime = { bots: {}, controller: mockController, push: { setOpenChat: jest.fn() } }
})

describe('opening a chat on a search hit', () => {
  it('scrolls to the newest row that carries the words, and lights it up', async () => {
    const scrollToIndex = jest.spyOn(FlatList.prototype, 'scrollToIndex').mockImplementation(() => {})

    try {
      seedChat(['the invoice service is red', 'nothing to do with it', 'invoices again, sorry'])
      renderScreen(<ChatScreen bot="researcher" findText="invoice" />)

      await waitFor(() => expect(scrollToIndex).toHaveBeenCalled())
      // Inverted list: the newest match is the row nearest index 0, and it is
      // centred rather than put at an edge.
      expect(scrollToIndex).toHaveBeenCalledWith(expect.objectContaining({ viewPosition: 0.5 }))
      await waitFor(() => expect(screen.getByTestId('transcript-list-highlight')).toBeTruthy())
    } finally {
      scrollToIndex.mockRestore()
    }
  })

  it('reads more history before it gives up', async () => {
    seedChat(['nothing here'])
    renderScreen(<ChatScreen bot="researcher" findText="invoice" />)

    await waitFor(() => expect(mockController.loadOlder).toHaveBeenCalledWith('researcher'))
  })

  it('says the row is further back rather than sitting at the bottom in silence', async () => {
    seedChat(['nothing here'])
    renderScreen(<ChatScreen bot="researcher" findText="invoice" />)

    await waitFor(() => expect(screen.getByText(/further back/)).toBeTruthy())
  })

  it('does nothing at all when nobody asked it to find anything', async () => {
    const scrollToIndex = jest.spyOn(FlatList.prototype, 'scrollToIndex').mockImplementation(() => {})

    try {
      seedChat(['the invoice service is red'])
      renderScreen(<ChatScreen bot="researcher" />)

      await waitFor(() => expect(screen.getByTestId('chat-header')).toBeTruthy())

      expect(scrollToIndex).not.toHaveBeenCalled()
      expect(mockController.loadOlder).not.toHaveBeenCalled()
    } finally {
      scrollToIndex.mockRestore()
    }
  })
})
