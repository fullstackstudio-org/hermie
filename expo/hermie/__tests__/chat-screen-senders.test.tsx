/**
 * HERM-83 on the chat screen: whose message is whose, and where names are drawn.
 *
 * Two things the screen got wrong, both proven end to end here with the real
 * stores, the real transcript engine and the real `/api/auth/me` parser:
 *
 *  1. The reader's own id. `/api/auth/me` answers with the provider's bare
 *     `user_id`; the gateway stamps a row `"<provider>:<user_id>"`. Compared as
 *     they came, the two never matched, so the reader's own message was drawn on
 *     the left under their own name, the chat list read "Alex: ok", the export
 *     labelled their lines with their name, and their picture was fetched as a
 *     colleague's.
 *  2. The group-chat gate. It was read off the reader's remembered CHOICE,
 *     which says "group chat" for a legacy title-only `myChats` entry and moves
 *     before a switch has happened (or when it is then refused). It is read off
 *     what is actually bound under the key now.
 */
import { act, renderHook, screen, waitFor } from '@testing-library/react-native'
import { authPicturePath, ownAuthorOf } from '@hermie/gateway-client'
import {
  createChatState,
  exportTranscript,
  reconcile,
  rowsToItems,
  type TranscriptItem,
  type TranscriptRow
} from '@hermie/transcript'

import { senderLabel } from '../src/chat-ui'
import { useRowPreview } from '../src/features/bots/row-preview'
import { ChatScreen } from '../src/features/chats/ChatScreen'
import { ownAuthorOn, useOwnAuthorStore } from '../src/features/chats/own-author'
import { usePeoplePicturesStore } from '../src/features/people/people-pictures'
import { type Bot, useBotsStore } from '../src/store/bots'
import { useChatLayoutStore } from '../src/store/chat-layout'
import { useChatsStore } from '../src/store/chats'
import { useSettingsStore } from '../src/store/settings'
import { AUTH_ME_STAMP, httpAnsweringAuthMe } from './support/auth-me'
import { renderScreen } from './support/render'

const GATEWAY = 'gateway-one'
const COLLEAGUE = { id: 'authentik:0c1d2e3f-robin', name: 'Robin Vale' }

const mockFetchPicture = jest.fn(async (_path: string) => ({ kind: 'missing' as const }))
let mockController: Record<string, jest.Mock | ((name: string) => string)>
let mockRuntime: { controller: typeof mockController; bots: Record<string, never>; push: { setOpenChat: jest.Mock } }

jest.mock('../src/gateway', () => ({
  useGateway: () => ({
    config: { baseUrl: 'https://gateway.example.test' },
    gatewayId: 'gateway-one',
    http: { fetchAuthenticatedPicture: mockFetchPicture, requestHeaders: async () => ({}) },
    status: 'ready'
  })
}))

jest.mock('../src/features/chats/ChatRuntime', () => ({
  useChatRuntime: () => mockRuntime
}))

jest.mock('../src/platform/haptics', () => ({ haptic: jest.fn() }))

jest.mock('../src/platform/desktop-shortcuts', () => ({
  subscribeToShortcuts: () => () => undefined,
  setMenuBar: jest.fn(),
  isMenuBarInstalled: jest.fn(() => false)
}))

jest.mock('../src/features/chats/attachments', () => ({
  MAX_ATTACHMENT_EDGE: 1568,
  imageDimensions: jest.fn(async () => ({ height: 100, width: 100 })),
  openAppSettings: jest.fn(),
  pickAttachment: jest.fn(async () => null),
  resizeToBase64: jest.fn()
}))

jest.mock('../src/platform/native-paste', () => ({
  HAS_NATIVE_PASTEBOARD: false,
  readPasteboardAttachment: async () => []
}))

const GROUP = { id: 'stored-group', resolvedId: 'stored-group', preview: '', lastActive: 1, messageCount: 1 }
const OWN = { id: 'stored-own', resolvedId: 'stored-own', preview: '', lastActive: 2, messageCount: 1 }

const BOT: Bot = {
  name: 'researcher',
  displayName: 'Researcher',
  description: '',
  model: 'example-provider/example-model',
  provider: 'example-provider',
  isDefault: false,
  hasAvatar: false,
  uiMetaRevision: 0,
  canonical: GROUP
}

const colleagueRow: TranscriptRow = {
  role: 'user',
  row_id: 1,
  text: 'draft is ready',
  timestamp: 1_790_000_000,
  display_metadata: { author: COLLEAGUE }
}

function hydrateChat(rows: readonly TranscriptRow[], storedId = GROUP.id): void {
  useChatsStore
    .getState()
    .hydrate('researcher', reconcile(createChatState('researcher', storedId, storedId), rowsToItems(rows, 'rpc')))
}

/** Every sender label drawn, by the item id in its test id. */
function namedItemIds(): string[] {
  return screen
    .queryAllByTestId(/^user-sender-name-(?!a11y-)/u)
    .map(node => String(node.props.testID).replace('user-sender-name-', ''))
}

const itemsOf = (): TranscriptItem[] => {
  const chat = useChatsStore.getState().chats.researcher

  return chat ? chat.order.map(id => chat.items[id]).filter((item): item is TranscriptItem => Boolean(item)) : []
}

const renderChat = () => renderScreen(<ChatScreen bot="researcher" />)

beforeEach(async () => {
  // The controller is the one stand-in: everything past it is a socket.
  mockController = {
    openChat: jest.fn(async () => undefined),
    closeChat: jest.fn(async () => undefined),
    readKeyFor: (name: string) => name,
    send: jest.fn(async () => undefined),
    stopTurn: jest.fn(async () => undefined),
    querySlash: jest.fn(async () => ({ items: [] })),
    knowsSlashCommand: jest.fn(() => false),
    setOption: jest.fn(async () => ({})),
    refreshOptions: jest.fn(async () => null),
    refreshUsage: jest.fn(async () => null),
    modelOptions: jest.fn(async () => [])
  }
  mockRuntime = { bots: {}, controller: mockController, push: { setOpenChat: jest.fn() } }
  mockFetchPicture.mockClear()
  usePeoplePicturesStore.getState().reset()
  useBotsStore.getState().reset()
  useChatsStore.getState().reset()
  useSettingsStore.getState().reset()
  useChatLayoutStore.setState({ current: {}, myChats: {} })
  useBotsStore.getState().setBots([BOT])

  // What `ChatRuntimeProvider` does on a ready edge: the one `/api/auth/me`
  // read, through the one parser, filed under this gateway.
  useOwnAuthorStore.getState().reset()
  useOwnAuthorStore.getState().bind(GATEWAY)
  useOwnAuthorStore.getState().set(GATEWAY, ownAuthorOf(await httpAnsweringAuthMe().authMe()))
})

describe('ChatScreen, the reader’s own message (HERM-83, D3)', () => {
  it('stays the reader’s own from the optimistic bubble to the landed row, a reload, the preview and the export', async () => {
    hydrateChat([colleagueRow])
    // What `ChatController.send` does: the optimistic bubble carries the
    // reader's own author, read from the same store.
    useChatsStore.getState().beginTurn('researcher', 'ok', [], ownAuthorOn(GATEWAY))

    const optimistic = itemsOf().find(item => item.kind === 'user' && item.text === 'ok')

    expect(optimistic).toMatchObject({ author: { id: AUTH_ME_STAMP } })

    renderChat()

    await waitFor(() => expect(screen.getByText('ok')).toBeTruthy())
    // The colleague IS named — so the assertions below are not vacuous — and
    // the reader is not.
    expect(namedItemIds()).toEqual([itemsOf()[0]?.id])
    expect(screen.queryByTestId(`user-sender-${optimistic?.id}`)).toBeNull()

    // Its row lands, stamped by the gateway.
    const stamped: TranscriptRow = {
      role: 'user',
      row_id: 2,
      text: 'ok',
      timestamp: 1_790_000_100,
      display_metadata: { author: { id: AUTH_ME_STAMP, name: 'Alex Moreno' } }
    }

    act(() => {
      useChatsStore.getState().applyTail('researcher', rowsToItems([colleagueRow, stamped], 'rpc'))
    })

    expect(screen.getAllByText('ok')).toHaveLength(1)
    expect(itemsOf().find(item => item.kind === 'user' && item.text === 'ok')).toMatchObject({
      rowId: 2,
      author: { id: AUTH_ME_STAMP }
    })
    expect(namedItemIds()).toHaveLength(1)
    expect(screen.queryByText('Alex Moreno')).toBeNull()

    // A reload: the transcript is rebuilt from the rows alone.
    act(() => {
      useChatsStore.getState().forget('researcher')
      hydrateChat([colleagueRow, stamped])
    })

    await waitFor(() => expect(screen.getByText('ok')).toBeTruthy())
    expect(namedItemIds()).toHaveLength(1)
    expect(screen.queryByText('Alex Moreno')).toBeNull()

    // No picture was ever asked for the reader as if they were a colleague.
    await waitFor(() => expect(mockFetchPicture).toHaveBeenCalledWith(authPicturePath(COLLEAGUE.id)))
    expect(mockFetchPicture).not.toHaveBeenCalledWith(authPicturePath(AUTH_ME_STAMP))

    // The chat list, on the same rows: the reader's own last message is not
    // prefixed with their own name.
    const { result } = renderHook(() => useRowPreview('researcher', ''))

    expect(result.current.text).toBe('ok')

    // The export, with the id the screen reads: the reader's line is "You".
    const { text } = exportTranscript(itemsOf(), {
      botName: 'researcher',
      groupChat: true,
      ownAuthorId: useOwnAuthorStore.getState().byGateway[GATEWAY]?.id,
      resolveSenderName: senderLabel,
      selfName: 'You'
    })

    expect(text).toContain('Robin Vale:\ndraft is ready')
    expect(text).toContain('You:\nok')
    expect(text).not.toContain('Alex Moreno')
  })
})

describe('ChatScreen, where sender names are drawn (HERM-83, D6)', () => {
  it('names a colleague in the group chat', async () => {
    hydrateChat([colleagueRow])

    renderChat()

    await waitFor(() => expect(screen.getByText('draft is ready')).toBeTruthy())
    expect(namedItemIds()).toHaveLength(1)
  })

  it('names nobody in the reader’s own chat bound under the bot’s key', async () => {
    useChatLayoutStore.setState({ current: { researcher: OWN.id }, myChats: { researcher: true } })
    useBotsStore.getState().setCurrent('researcher', OWN)
    hydrateChat([colleagueRow], OWN.id)

    renderChat()

    await waitFor(() => expect(screen.getByText('draft is ready')).toBeTruthy())
    expect(namedItemIds()).toEqual([])
  })

  it('names nobody in a legacy title-only `myChats` entry, which has no id remembered', async () => {
    // The memory says "my chat" with no id yet; the controller found it by
    // title and bound it. `useCurrentConversation` is `undefined` here.
    useChatLayoutStore.setState({ current: {}, myChats: { researcher: true } })
    useBotsStore.getState().setCurrent('researcher', OWN)
    hydrateChat([colleagueRow], OWN.id)

    renderChat()

    await waitFor(() => expect(screen.getByText('draft is ready')).toBeTruthy())
    expect(namedItemIds()).toEqual([])
  })

  it('does not flip while a switch is attempted and refused', async () => {
    hydrateChat([colleagueRow])

    renderChat()

    await waitFor(() => expect(screen.getByText('draft is ready')).toBeTruthy())
    expect(namedItemIds()).toHaveLength(1)

    // `selectConversation` writes the memory FIRST; the switch is then refused
    // (`ConversationBusyError`) before the key is touched, and the memory is
    // put back. The group chat never left the screen.
    act(() => {
      useChatLayoutStore.setState({ current: { researcher: OWN.id }, myChats: { researcher: true } })
    })
    expect(namedItemIds()).toHaveLength(1)

    act(() => {
      useChatLayoutStore.setState({ current: {}, myChats: {} })
    })
    expect(namedItemIds()).toHaveLength(1)
  })

  it('keeps the settled answer while the key is empty mid-switch', async () => {
    useChatLayoutStore.setState({ current: { researcher: OWN.id }, myChats: { researcher: true } })
    useBotsStore.getState().setCurrent('researcher', OWN)
    hydrateChat([colleagueRow], OWN.id)

    renderChat()

    await waitFor(() => expect(screen.getByText('draft is ready')).toBeTruthy())
    expect(namedItemIds()).toEqual([])

    // A failed switch after the key was touched: the chat is dropped, the
    // roster's `current` put back, and the same conversation re-hydrated.
    act(() => {
      useChatsStore.getState().forget('researcher')
    })
    act(() => {
      useBotsStore.getState().setCurrent('researcher', OWN)
      hydrateChat([colleagueRow], OWN.id)
    })

    await waitFor(() => expect(screen.getByText('draft is ready')).toBeTruthy())
    expect(namedItemIds()).toEqual([])
  })
})
