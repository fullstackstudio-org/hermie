/**
 * Which box a board lands in.
 *
 * R18 measured the defect this covers: `KanbanScreen` lays its columns out side
 * by side above 700pt and gains a card drag there, and every door in the app
 * rendered it IN PLACE — inside the 520pt settings overlay, or inside the
 * 300–340pt sidebar. So the side-by-side layout was correct code no window
 * could reach.
 *
 * The fix is a routing decision and nothing else, which is why it is tested
 * here rather than photographed: the board goes in the CONTENT column, the slot
 * a chat and the Conversations page already use, and a shell with no such slot
 * (the phone) keeps the in-place page it had.
 *
 * The board itself is never loaded: the gateway mock has no `http`, so
 * `KanbanScreen` sits on "Reading the boards…" under its own header. That is
 * enough and it is the point — this file is about WHERE the screen is mounted,
 * and `kanban.test.ts` owns what it says once it has data.
 */
import { fireEvent, screen, within } from '@testing-library/react-native'
import { useWindowDimensions } from 'react-native'

import { RegularShell } from '../src/app/RegularShell'
import { resetSettledWidth } from '../src/app/useLayoutMode'
import { BotsScreen } from '../src/features/bots'
import { kanbanStrings } from '../src/features/kanban'
import { strings } from '../src/i18n/strings'
import { type Bot, useBotsStore } from '../src/store/bots'
import { useChatLayoutStore } from '../src/store/chat-layout'
import { useChatsStore } from '../src/store/chats'
import { renderScreen } from './support/render'

const gateway = { status: 'ready', config: { baseUrl: 'https://gateway.example.com', authMode: 'native_pkce' } }

jest.mock('../src/gateway', () => ({
  useGateway: () => gateway,
  hostOf: (url: string) => url.replace(/^https:\/\//, '')
}))

jest.mock('../src/gateway/GatewayProvider', () => ({
  useGateway: () => ({
    ...gateway,
    adoptTokens: jest.fn(),
    changeGateway: jest.fn(),
    extraHeaders: {},
    signOut: jest.fn()
  })
}))

jest.mock('../src/features/chats/ChatRuntime', () => ({
  useChatRuntime: () => null
}))

jest.mock('../src/platform/runs-on-mac', () => ({ RUNS_ON_MAC: false }))

jest.mock('react-native/Libraries/Utilities/useWindowDimensions')

const mockDimensions = useWindowDimensions as unknown as jest.Mock

const bot = (name: string, displayName: string): Bot => ({
  name,
  displayName,
  description: '',
  model: 'example-provider/example-model',
  provider: 'example-provider',
  isDefault: false,
  hasAvatar: false,
  uiMetaRevision: 0,
  canonical: { id: `stored-${name}`, resolvedId: `stored-${name}`, preview: 'Hello.', lastActive: 1, messageCount: 2 }
})

beforeEach(() => {
  resetSettledWidth()
  useBotsStore.getState().reset()
  useChatsStore.getState().reset()
  useChatLayoutStore.getState().reset()
  useBotsStore.getState().setBots([bot('researcher', 'Researcher'), bot('writer', 'Writer')])
  mockDimensions.mockReturnValue({ width: 1024, height: 1366, scale: 2, fontScale: 1 })
})

/** The board's own header line, which only the Boards screen paints. */
const board = () => kanbanStrings.subtitle

/**
 * The chat list's door to Boards, which is a menu entry rather than a button.
 *
 * R23 took the head row down to a `…` and Edit at every width, so Boards is one
 * level in. The door is what this file is about, not where it is drawn, so the
 * two presses live here rather than in every case.
 */
function openBoardsFromChatList() {
  fireEvent.press(screen.getByTestId('bots-head-overflow'))
  fireEvent.press(screen.getByTestId('bots-head-overflow-boards'))
}

describe('Boards on a wide window', () => {
  it('lands in the content column and not in the sidebar it was opened from', () => {
    renderScreen(<RegularShell />)

    openBoardsFromChatList()

    expect(within(screen.getByTestId('shell-content')).getByText(board())).toBeTruthy()
    expect(within(screen.getByTestId('shell-sidebar-content')).queryByText(board())).toBeNull()
  })

  it('leaves the chat list mounted beside it, the way a chat does', () => {
    renderScreen(<RegularShell />)

    openBoardsFromChatList()

    expect(screen.getByTestId('bot-row-researcher')).toBeTruthy()
    expect(screen.getByTestId('bot-row-writer')).toBeTruthy()
  })

  /**
   * Settings → Bots & capabilities → Boards, which is where the row lives now.
   *
   * Settings is in the content column itself since HERM-102/108 (no longer the
   * 520pt `overlay-panel`), so the search scope is `shell-content` rather than
   * the overlay.
   */
  function openBoardsFromSettings() {
    fireEvent.press(screen.getByTestId('tab-settings'))
    fireEvent.press(within(screen.getByTestId('shell-content')).getByTestId('settings-cat-Capabilities'))
    fireEvent.press(within(screen.getByTestId('shell-content')).getByTestId('settings-boards'))
  }

  it('takes the column from Settings rather than sitting inside its own layout', () => {
    renderScreen(<RegularShell />)

    openBoardsFromSettings()

    expect(within(screen.getByTestId('shell-content')).getByText(board())).toBeTruthy()
    // Settings itself is gone, rather than sitting behind the board: the two
    // share the one column, the way Settings and the board opened from the
    // chat list share it below.
    expect(screen.queryByTestId('settings-host')).toBeNull()
  })

  it('goes back one level — to Settings when that is the door it came through', () => {
    renderScreen(<RegularShell />)

    openBoardsFromSettings()
    // The board's own back button, which is labelled with the door it returns
    // to. Scoped to the column, because the sidebar has a Settings tab with the
    // same label.
    fireEvent.press(within(screen.getByTestId('shell-content')).getByLabelText(strings.settings.title))

    expect(screen.queryByText(board())).toBeNull()
    expect(screen.getByTestId('settings-host')).toBeTruthy()
  })

  it('goes back to the chat column when the chat list was the door', () => {
    renderScreen(<RegularShell />)

    openBoardsFromChatList()
    fireEvent.press(within(screen.getByTestId('shell-content')).getByLabelText(strings.tabs.chats))

    expect(screen.queryByText(board())).toBeNull()
    expect(screen.queryByTestId('overlay-panel')).toBeNull()
    expect(screen.getByText('Pick a conversation to start reading.')).toBeTruthy()
  })

  it('hands the column back as soon as a chat is picked', () => {
    renderScreen(<RegularShell />)

    openBoardsFromChatList()
    fireEvent.press(screen.getByTestId('bot-row-researcher'))

    expect(screen.queryByText(board())).toBeNull()
  })
})

describe('Boards with no shell to host it', () => {
  it('replaces the page it was opened from, which is the phone', () => {
    // `BotsScreen` on its own is the compact shell's chat list: no `BoardsHost`
    // above it, because `CompactShell` provides none.
    renderScreen(<BotsScreen currentTab="chats" onOpenBot={jest.fn()} />)

    openBoardsFromChatList()

    expect(screen.getByText(board())).toBeTruthy()
    expect(screen.queryByTestId('bot-row-researcher')).toBeNull()
  })
})
