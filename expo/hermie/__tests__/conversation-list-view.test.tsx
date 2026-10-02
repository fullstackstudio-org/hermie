/**
 * `ConversationListView`: the group chat first, the reader's own chats
 * (newest used first), "New chat", and the archive link — and what happens
 * when an action is refused.
 *
 * The controller is a hand-built stub rather than the real `ChatController`,
 * the same choice `chat-options-popover.test.tsx` makes for the same reason:
 * this is a view's contract with the API Task 4 shipped, not a test of the
 * controller itself.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react-native'

import { ConversationListView } from '../src/features/sessions/ConversationListView'
import { ConversationBusyError } from '../src/features/chats/chat-controller'
import type { Conversation, ConversationList } from '../src/features/sessions'
import { chatStrings } from '../src/chat-ui/strings'
import { type Bot, useBotsStore } from '../src/store/bots'
import { renderScreen } from './support/render'

let mockController: {
  listBotConversations: jest.Mock
  onConversationsChanged: jest.Mock
  selectConversation: jest.Mock
  startOwnChat: jest.Mock
  renameOwnChat: jest.Mock
  deleteOwnChat: jest.Mock
}
let mockRuntime: { controller: typeof mockController; userChats: { title: string; available: boolean } }

jest.mock('../src/features/chats/ChatRuntime', () => ({
  useChatRuntime: () => mockRuntime
}))

const BOT: Bot = {
  name: 'researcher',
  displayName: 'Researcher',
  description: '',
  model: '',
  provider: '',
  isDefault: false,
  hasAvatar: false,
  uiMetaRevision: 0,
  canonical: { id: 'stored-group', resolvedId: 'stored-group', preview: 'hi there', lastActive: 100, messageCount: 5 }
}

const GROUP: Conversation = {
  id: 'stored-group',
  resolvedId: 'stored-group',
  title: 'Bot Chat',
  preview: 'hi there',
  messageCount: 5,
  lastActive: 100,
  kind: 'canonical'
}

/** Older, used first in the fixture list to prove the view does not re-sort. */
const OWN_OLDER: Conversation = {
  id: 'own-older',
  resolvedId: 'own-older',
  title: 'Chat · Ada',
  preview: '',
  messageCount: 1,
  lastActive: 200,
  kind: 'mine'
}

/** Most recently used; the fixture list puts it first, as `sortConversations` would. */
const OWN_NEWER: Conversation = {
  id: 'own-newer',
  resolvedId: 'own-newer',
  title: 'Chat · Ada · Trip planning',
  preview: 'Where should we go?',
  messageCount: 3,
  lastActive: 300,
  kind: 'mine'
}

function list(overrides: Partial<ConversationList> = {}): ConversationList {
  return { group: GROUP, own: [OWN_NEWER, OWN_OLDER], canCreate: true, ...overrides }
}

function makeController(initial: ConversationList) {
  return {
    listBotConversations: jest.fn(async () => initial),
    onConversationsChanged: jest.fn(() => jest.fn()),
    selectConversation: jest.fn(async () => undefined),
    startOwnChat: jest.fn(async () => OWN_NEWER),
    renameOwnChat: jest.fn(async (_bot: Bot, _id: string, label: string) => `Chat · Ada · ${label}`),
    deleteOwnChat: jest.fn(async () => undefined)
  }
}

beforeEach(() => {
  useBotsStore.getState().reset()
  useBotsStore.getState().setBots([BOT])
  mockController = makeController(list())
  mockRuntime = { controller: mockController, userChats: { title: 'Chat · Ada', available: true } }
})

/** Every string leaf under a rendered tree, in the order React laid them out. */
function textOrder(): string[] {
  const out: string[] = []

  const walk = (node: unknown): void => {
    if (node == null) {
      return
    }

    if (Array.isArray(node)) {
      node.forEach(walk)

      return
    }

    if (typeof node === 'string') {
      out.push(node)

      return
    }

    if (typeof node === 'object' && 'children' in (node as Record<string, unknown>)) {
      walk((node as { children?: unknown }).children)
    }
  }

  walk(screen.toJSON())

  return out
}

async function openList(overrides: Partial<ConversationList> = {}) {
  mockController = makeController(list(overrides))
  mockRuntime = { controller: mockController, userChats: { title: 'Chat · Ada', available: true } }
  renderScreen(<ConversationListView botName="researcher" />)
  await waitFor(() => expect(screen.getByTestId('conversation-list-view')).toBeTruthy())
}

describe('the rows, in the order the surface promises', () => {
  it('draws the group first, own chats as given, then New chat', async () => {
    await openList()

    const order = textOrder()
    const at = (needle: string) => order.findIndex(text => text.includes(needle))

    // OWN_NEWER ("Trip planning") is given first, OWN_OLDER (the bare lead,
    // shown as "My chat") second — the view draws them in that order rather
    // than re-sorting, which is `buildConversationList`'s job, not this one's.
    expect(at('Group chat')).toBeGreaterThanOrEqual(0)
    expect(at('Trip planning')).toBeGreaterThan(at('Group chat'))
    expect(at(chatStrings.conversations.firstChat)).toBeGreaterThan(at('Trip planning'))
    expect(at(chatStrings.conversations.newChat)).toBeGreaterThan(at(chatStrings.conversations.firstChat))
  })

  it('gives the bare lead its own chat the fallback label, not the raw title', async () => {
    await openList()

    expect(screen.getByText(chatStrings.conversations.firstChat)).toBeTruthy()
  })

  it('offers no rename or delete on the group row', async () => {
    await openList()

    expect(screen.queryByTestId('conversation-list-view-rename-start-stored-group')).toBeNull()
    expect(screen.queryByTestId('conversation-list-view-delete-start-stored-group')).toBeNull()
  })

  it('offers rename and delete on an own row', async () => {
    await openList()

    expect(screen.getByTestId('conversation-list-view-rename-start-own-newer')).toBeTruthy()
    expect(screen.getByTestId('conversation-list-view-delete-start-own-newer')).toBeTruthy()
  })
})

describe('picking a row', () => {
  it('opens the group chat', async () => {
    await openList()

    fireEvent.press(screen.getByTestId('conversation-list-view-row-stored-group'))

    await waitFor(() => expect(mockController.selectConversation).toHaveBeenCalledWith(BOT, null))
  })

  it('opens one of the reader’s own chats', async () => {
    await openList()

    fireEvent.press(screen.getByTestId('conversation-list-view-row-own-newer'))

    await waitFor(() =>
      expect(mockController.selectConversation).toHaveBeenCalledWith(BOT, expect.objectContaining({ id: 'own-newer' }))
    )
  })

  it('calls onPicked once the switch has landed', async () => {
    const onPicked = jest.fn()

    mockController = makeController(list())
    mockRuntime = { controller: mockController, userChats: { title: 'Chat · Ada', available: true } }
    renderScreen(<ConversationListView botName="researcher" onPicked={onPicked} />)
    await waitFor(() => expect(screen.getByTestId('conversation-list-view')).toBeTruthy())

    fireEvent.press(screen.getByTestId('conversation-list-view-row-stored-group'))

    await waitFor(() => expect(onPicked).toHaveBeenCalled())
  })
})

describe('starting another chat', () => {
  it('calls startOwnChat and re-lists on success', async () => {
    await openList()
    mockController.listBotConversations.mockClear()

    fireEvent.press(screen.getByTestId('conversation-list-view-new-chat'))

    await waitFor(() => expect(mockController.startOwnChat).toHaveBeenCalledWith(BOT, {}))
    await waitFor(() => expect(mockController.listBotConversations).toHaveBeenCalled())
  })

  it('shows a refusal inline when the gateway will not start one', async () => {
    await openList()
    mockController.startOwnChat.mockRejectedValueOnce(new Error('nope'))

    fireEvent.press(screen.getByTestId('conversation-list-view-new-chat'))

    await waitFor(() =>
      expect(screen.getByTestId('conversation-list-view-notice')).toHaveTextContent(
        chatStrings.conversations.newChatFailed
      )
    )
  })
})

describe('renaming an own chat', () => {
  it('commits on Return', async () => {
    await openList()

    fireEvent.press(screen.getByTestId('conversation-list-view-rename-start-own-newer'))
    fireEvent.changeText(screen.getByTestId('conversation-list-view-rename-own-newer'), 'Holiday plans')
    fireEvent(screen.getByTestId('conversation-list-view-rename-own-newer'), 'submitEditing')

    await waitFor(() => expect(mockController.renameOwnChat).toHaveBeenCalledWith(BOT, 'own-newer', 'Holiday plans'))
  })

  it('shows the gateway’s own refusal inline, next to the field', async () => {
    await openList()
    mockController.renameOwnChat.mockRejectedValueOnce(new Error('A chat needs a name.'))

    fireEvent.press(screen.getByTestId('conversation-list-view-rename-start-own-newer'))
    fireEvent.changeText(screen.getByTestId('conversation-list-view-rename-own-newer'), '')
    fireEvent(screen.getByTestId('conversation-list-view-rename-own-newer'), 'submitEditing')

    await waitFor(() =>
      expect(screen.getByTestId('conversation-list-view-rename-error-own-newer')).toHaveTextContent(
        'A chat needs a name.'
      )
    )
    // Still editable: a refusal does not close the field out from under the reader.
    expect(screen.getByTestId('conversation-list-view-rename-own-newer')).toBeTruthy()
  })
})

describe('deleting an own chat', () => {
  it('is a two-step confirm rather than an immediate delete', async () => {
    await openList()

    fireEvent.press(screen.getByTestId('conversation-list-view-delete-start-own-newer'))

    expect(mockController.deleteOwnChat).not.toHaveBeenCalled()
    expect(screen.getByTestId('conversation-list-view-delete-confirm-own-newer')).toBeTruthy()

    fireEvent.press(screen.getByTestId('conversation-list-view-delete-confirm-own-newer'))

    await waitFor(() => expect(mockController.deleteOwnChat).toHaveBeenCalledWith(BOT, 'own-newer'))
  })
})

describe('the busy refusal', () => {
  it('shows chatStrings.sessions.busy when opening a row would drop a running reply', async () => {
    await openList()
    mockController.selectConversation.mockRejectedValueOnce(new ConversationBusyError('researcher'))

    fireEvent.press(screen.getByTestId('conversation-list-view-row-own-older'))

    await waitFor(() =>
      expect(screen.getByTestId('conversation-list-view-notice')).toHaveTextContent(chatStrings.sessions.busy)
    )
  })

  it('shows the same refusal when deleting the open chat would drop it', async () => {
    await openList()
    mockController.deleteOwnChat.mockRejectedValueOnce(new ConversationBusyError('researcher'))

    fireEvent.press(screen.getByTestId('conversation-list-view-delete-start-own-newer'))
    fireEvent.press(screen.getByTestId('conversation-list-view-delete-confirm-own-newer'))

    await waitFor(() =>
      expect(screen.getByTestId('conversation-list-view-delete-error-own-newer')).toHaveTextContent(
        chatStrings.sessions.busy
      )
    )
  })
})

describe('a gateway that named nobody', () => {
  it('draws only the group chat and its note', async () => {
    await openList({ own: [], canCreate: false })

    expect(screen.getByText(chatStrings.conversations.groupChat)).toBeTruthy()
    expect(screen.getByText(chatStrings.sessions.sharedNote)).toBeTruthy()
    expect(screen.queryByText(chatStrings.conversations.yourChats.toUpperCase())).toBeNull()
    expect(screen.queryByTestId('conversation-list-view-new-chat')).toBeNull()
    expect(screen.queryByTestId('conversation-list-view-archive')).toBeNull()
  })
})

describe('a bot with no own chats yet', () => {
  it('says so under "Your chats" rather than showing nothing', async () => {
    await openList({ own: [] })

    expect(screen.getByText(chatStrings.conversations.yoursEmpty)).toBeTruthy()
  })
})

describe('the archive link', () => {
  it('is offered only where the caller has somewhere to send it, and calls it', async () => {
    const onOpenArchive = jest.fn()

    mockController = makeController(list())
    mockRuntime = { controller: mockController, userChats: { title: 'Chat · Ada', available: true } }
    renderScreen(<ConversationListView botName="researcher" onOpenArchive={onOpenArchive} />)
    await waitFor(() => expect(screen.getByTestId('conversation-list-view-archive')).toBeTruthy())

    fireEvent.press(screen.getByTestId('conversation-list-view-archive'))

    expect(onOpenArchive).toHaveBeenCalled()
  })

  it('is absent when the caller gave no way to open it', async () => {
    await openList()

    expect(screen.queryByTestId('conversation-list-view-archive')).toBeNull()
  })
})
