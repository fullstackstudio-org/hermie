/**
 * The chat's (…) menu, and the one thing it exists to stop doing.
 *
 * The owner's report was not "the sheet is ugly", it was **"nu schuift alles"** —
 * everything moves. So the assertion that matters most here is not that a
 * popover appears: it is that the transcript's own content inset is the SAME
 * NUMBER with the popover open as without it. Every other test in this file
 * would still pass if opening the menu quietly re-padded the list, which is
 * exactly the failure being fixed.
 *
 * The rest is the contract around it: a column too narrow for a popover still
 * gets the sheet (decided by MEASUREMENT, not by `Platform.OS`), a tap outside
 * and Escape both close it, and a row that leads to a page hands over to the
 * sheet already on that page rather than dropping the reader at the root.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native'
import { Keyboard } from 'react-native'

import { ChatScreen } from '../src/features/chats/ChatScreen'
import { type Bot, useBotsStore } from '../src/store/bots'
import { useChatsStore } from '../src/store/chats'
import { usePushStore } from '../src/store/push'
import { useSettingsStore } from '../src/store/settings'
import { modelPickerOptions, modelRowLabel, nextFocus, popoverRows } from '../src/ui/sheets'
import { renderScreen } from './support/render'

/**
 * The backdrop is hidden FROM ACCESSIBILITY on purpose — it is a tap target and
 * not a control — so a query has to say it wants hidden elements too.
 */
const HIDDEN = { includeHiddenElements: true } as const

let mockController: Record<string, jest.Mock>
let mockRuntime: {
  controller: Record<string, jest.Mock>
  bots: { refresh: jest.Mock }
  push: { setOpenChat: jest.Mock }
  // Sub-chats (Task 6): absent by default, exactly like a session-token
  // gateway that named nobody — `canCreate` is false and nothing here is
  // drawn. A test that wants the conversations button and the `new-chat` row
  // sets this itself.
  userChats?: { available: boolean; title: string }
}

jest.mock('../src/gateway', () => ({
  useGateway: () => ({ config: { baseUrl: 'https://gateway.example.com' }, http: null, status: 'ready' })
}))

jest.mock('../src/features/chats/ChatRuntime', () => ({
  useChatRuntime: () => mockRuntime
}))

jest.mock('../src/platform/haptics', () => ({ haptic: jest.fn() }))

jest.mock('../src/features/chats/attachments', () => ({
  MAX_ATTACHMENT_EDGE: 1568,
  openAppSettings: jest.fn(),
  pickAttachment: jest.fn(async () => null)
}))

const BOT: Bot = {
  name: 'researcher',
  displayName: 'Researcher',
  description: 'Finds things out.',
  model: 'example-provider/example-model',
  provider: 'example-provider',
  isDefault: false,
  hasAvatar: false,
  uiMetaRevision: 0,
  canonical: {
    id: 'stored-researcher',
    resolvedId: 'stored-researcher',
    preview: 'hello',
    lastActive: 1,
    messageCount: 2
  }
}

function makeController() {
  return {
    openChat: jest.fn(async () => undefined),
    closeChat: jest.fn(async () => undefined),
    readKeyFor: (name: string) => name,
    send: jest.fn(async () => undefined),
    stopTurn: jest.fn(async () => undefined),
    acknowledgeApproval: jest.fn(async () => undefined),
    respondApproval: jest.fn(async () => undefined),
    respondClarify: jest.fn(async () => undefined),
    lockClarify: jest.fn(async () => undefined),
    steerQueued: jest.fn(async () => 'queued'),
    editQueued: jest.fn(() => ''),
    deleteQueued: jest.fn(),
    steerSubagent: jest.fn(async () => 'ok'),
    interruptSubagent: jest.fn(async () => true),
    tailSubagent: jest.fn(async () => ''),
    querySlash: jest.fn(async () => ({ items: [] })),
    knowsSlashCommand: jest.fn(() => false),
    runSlash: jest.fn(async () => undefined),
    setOption: jest.fn(async () => ({})),
    refreshOptions: jest.fn(async () => null),
    refreshUsage: jest.fn(async () => null),
    modelOptions: jest.fn(async () => []),
    // Sub-chats (Task 6). `listBotConversations`/`onConversationsChanged` are
    // called on every mount once `userChats.available` is true — see
    // `useConversationList`'s `enabled` guard — so every test that turns
    // sub-chats on needs these to exist.
    listBotConversations: jest.fn(async () => ({ group: null, own: [], canCreate: true })),
    onConversationsChanged: jest.fn(() => jest.fn()),
    startOwnChat: jest.fn(async () => ({
      id: 'own-new',
      resolvedId: 'own-new',
      title: 'Chat · Researcher',
      preview: '',
      messageCount: 0,
      lastActive: 0,
      kind: 'mine' as const
    }))
  }
}

function seedChat() {
  useBotsStore.getState().reset()
  useChatsStore.getState().reset()
  useSettingsStore.getState().reset()
  usePushStore.getState().reset()
  useBotsStore.getState().setBots([BOT])

  const chats = useChatsStore.getState()

  chats.ensure('researcher', { storedSessionId: 'stored-researcher', resolvedSessionId: 'stored-researcher' })
  chats.bindRuntime('researcher', 'runtime-1')
  chats.dispatchEvent('researcher', {
    type: 'session.info',
    session_id: 'runtime-1',
    payload: { model: 'example-provider/example-model', yolo: false, fast: false, reasoning_effort: 'medium' }
  })
}

beforeEach(() => {
  mockController = makeController()
  mockRuntime = {
    bots: { refresh: jest.fn(async () => undefined) },
    controller: mockController,
    push: { setOpenChat: jest.fn() }
  }
  seedChat()
})

/** Lay the floating chrome out at a given column width, the way a window would. */
function layOutChrome(width: number) {
  act(() => {
    fireEvent(screen.getByTestId('chat-chrome'), 'layout', {
      nativeEvent: { layout: { height: 72, width, x: 0, y: 0 } }
    })
  })
}

/** The inset the transcript pads its own content by. */
function contentInset(): unknown {
  const list = screen.getByTestId('transcript-list-scroll')

  return JSON.stringify(list.props.contentContainerStyle)
}

async function openChat(width = 720) {
  renderScreen(<ChatScreen bot="researcher" />)
  await waitFor(() => expect(screen.getByTestId('chat-header')).toBeTruthy())
  layOutChrome(width)
}

describe('the options menu is a popover in the chat', () => {
  it('opens under the header without moving anything behind it', async () => {
    await openChat()

    const before = contentInset()

    fireEvent.press(screen.getByTestId('chat-header-options'))

    await waitFor(() => expect(screen.getByTestId('chat-options-popover')).toBeTruthy())

    // The whole of the owner's request, in one comparison: the list pads its
    // content by the same number it did before the menu opened.
    expect(contentInset()).toBe(before)
    // And it really is a popover rather than the sheet under another name.
    expect(screen.queryByTestId('chat-options-sheet')).toBeNull()
  })

  /*
    Measured on the iPhone 17 Pro: with a draft half typed, tapping (…) drew
    the composer and its send button over the menu's lower half and left the
    rest of it behind the keyboard, with Model and Colour unreachable. The
    popover is a sibling of the composer laid out from the top of the chrome,
    so the only honest fix is for the two intentions not to be on screen at
    once.
  */
  it('puts the keyboard away, whichever form the options take', async () => {
    const dismiss = jest.spyOn(Keyboard, 'dismiss')

    await openChat()
    fireEvent.press(screen.getByTestId('chat-header-options'))
    await waitFor(() => expect(screen.getByTestId('chat-options-popover')).toBeTruthy())

    expect(dismiss).toHaveBeenCalled()

    dismiss.mockRestore()
  })

  it('puts it away for the narrow column’s sheet too', async () => {
    const dismiss = jest.spyOn(Keyboard, 'dismiss')

    await openChat(360)
    fireEvent.press(screen.getByTestId('chat-header-options'))
    await waitFor(() => expect(screen.getByTestId('chat-options-sheet')).toBeTruthy())

    expect(dismiss).toHaveBeenCalled()

    dismiss.mockRestore()
  })

  it('still offers the sheet on a column too narrow for a popover', async () => {
    await openChat(360)

    fireEvent.press(screen.getByTestId('chat-header-options'))

    await waitFor(() => expect(screen.getByTestId('chat-options-sheet')).toBeTruthy())
    expect(screen.queryByTestId('chat-options-popover')).toBeNull()
  })

  it('takes the sheet before the column has been measured, rather than guessing', async () => {
    renderScreen(<ChatScreen bot="researcher" />)
    await waitFor(() => expect(screen.getByTestId('chat-header')).toBeTruthy())

    fireEvent.press(screen.getByTestId('chat-header-options'))

    await waitFor(() => expect(screen.getByTestId('chat-options-sheet')).toBeTruthy())
  })

  it('closes on a tap anywhere else', async () => {
    await openChat()

    fireEvent.press(screen.getByTestId('chat-header-options'))
    await waitFor(() => expect(screen.getByTestId('chat-options-popover')).toBeTruthy())

    fireEvent.press(screen.getByTestId('chat-options-backdrop', HIDDEN))

    await waitFor(() => expect(screen.queryByTestId('chat-options-backdrop', HIDDEN)).toBeNull())
  })

  it('answers a toggle in place, without opening anything', async () => {
    await openChat()

    fireEvent.press(screen.getByTestId('chat-header-options'))
    await waitFor(() => expect(screen.getByTestId('chat-options-popover')).toBeTruthy())

    fireEvent.press(screen.getByTestId('option-thinking'))

    expect(useSettingsStore.getState().perChat.researcher?.showThinking).toBe(true)
    expect(screen.queryByTestId('chat-options-sheet')).toBeNull()
  })

  it('hands a page over to the sheet, already on that page', async () => {
    await openChat()

    fireEvent.press(screen.getByTestId('chat-header-options'))
    await waitFor(() => expect(screen.getByTestId('chat-options-popover')).toBeTruthy())

    fireEvent.press(screen.getByTestId('option-model'))

    await waitFor(() => expect(screen.getByTestId('chat-options-sheet')).toBeTruthy())
    // The model page, not the root: `picker-search` is the model picker's own
    // field and the root has no field at all.
    expect(screen.getByTestId('picker-search')).toBeTruthy()
    expect(screen.queryByTestId('chat-options-backdrop', HIDDEN)).toBeNull()
  })

  /**
   * The row that says which model you are on reads a NAME, not a wire id.
   *
   * The controller here answers an empty inventory, which is the case that used
   * to show the id through: the chat's own model is appended to the picker so
   * that the list can show what you are on, and that appended option carried the
   * raw id as its label — so the row matched it and printed it. The gateway is
   * allowed to answer nothing, and the row has to read the same either way.
   */
  it('says the model’s name on the row, not its wire id', async () => {
    await openChat()

    fireEvent.press(screen.getByTestId('chat-header-options'))
    await waitFor(() => expect(screen.getByTestId('chat-options-popover')).toBeTruthy())

    const row = screen.getByTestId('option-model')

    expect(within(row).getByText('Example Model')).toBeTruthy()
    expect(within(row).queryByText('example-provider/example-model')).toBeNull()
  })

  /**
   * HERM-125: `DisclosureRow` prints its label verbatim, with no casing
   * transform of its own — that is `InsetGroup`'s job, and this row is not
   * one. `chatStrings.export.header` used to be typed in capitals for the
   * sheet's group heading and leaked into this row too, the one label here
   * that shouted next to five that did not.
   */
  it('writes the export row the same case as its neighbours', async () => {
    await openChat()

    fireEvent.press(screen.getByTestId('chat-header-options'))
    await waitFor(() => expect(screen.getByTestId('chat-options-popover')).toBeTruthy())

    const row = screen.getByTestId('option-export')

    expect(within(row).getByText('Export')).toBeTruthy()
    expect(within(row).queryByText('EXPORT')).toBeNull()
  })
})

/**
 * Sub-chats (Task 6): the header's own entry point and the popover's
 * `new-chat` row, both gated on the same `canCreate` — the switch's own
 * `available` — as `listBotConversations`.
 */
describe('the header button and the popover row a gateway with accounts gets', () => {
  it('draws neither on a gateway that named nobody', async () => {
    await openChat()

    expect(screen.queryByTestId('chat-header-conversations')).toBeNull()

    fireEvent.press(screen.getByTestId('chat-header-options'))
    await waitFor(() => expect(screen.getByTestId('chat-options-popover')).toBeTruthy())

    expect(screen.queryByTestId('option-new-chat')).toBeNull()
  })

  it('draws both once the switch says this reader has a name', async () => {
    mockRuntime.userChats = { available: true, title: 'Chat · Researcher' }

    await openChat()

    await waitFor(() => expect(screen.getByTestId('chat-header-conversations')).toBeTruthy())

    fireEvent.press(screen.getByTestId('chat-header-options'))
    await waitFor(() => expect(screen.getByTestId('option-new-chat')).toBeTruthy())
  })

  it('starts another chat from the popover row, and closes the popover', async () => {
    mockRuntime.userChats = { available: true, title: 'Chat · Researcher' }

    await openChat()

    fireEvent.press(screen.getByTestId('chat-header-options'))
    await waitFor(() => expect(screen.getByTestId('option-new-chat')).toBeTruthy())

    fireEvent.press(screen.getByTestId('option-new-chat'))

    await waitFor(() =>
      expect(mockController.startOwnChat).toHaveBeenCalledWith(expect.objectContaining({ name: 'researcher' }))
    )
    expect(screen.queryByTestId('chat-options-backdrop', HIDDEN)).toBeNull()
  })

  it('opens the sheet from the header button', async () => {
    mockRuntime.userChats = { available: true, title: 'Chat · Researcher' }

    await openChat()

    await waitFor(() => expect(screen.getByTestId('chat-header-conversations')).toBeTruthy())
    fireEvent.press(screen.getByTestId('chat-header-conversations'))

    await waitFor(() => expect(screen.getByTestId('conversation-sheet')).toBeTruthy())
  })
})

/**
 * The list and the row, as one function.
 *
 * They were two, and that is how they disagreed: `modelRowLabel` formatted an id
 * it could not find an option for, and the one option the list always has — the
 * chat's own model — was built with the id as its label, so the fallback never
 * ran for the one row that needed it.
 */
describe('the models a picker offers', () => {
  it('names every row, including the chat’s own model', () => {
    const options = modelPickerOptions([{ id: 'anthropic/claude-haiku-4-5-20251001' }], 'openai/gpt-5-2025-08-07')

    expect(options.map(option => option.label)).toEqual(['GPT-5', 'Claude Haiku 4.5'])
    // The id stays readable: it is what goes into a config or a `--model` flag,
    // and the picker's search matches on it.
    expect(options.map(option => option.detail)).toEqual([
      'openai/gpt-5-2025-08-07',
      'anthropic/claude-haiku-4-5-20251001'
    ])
  })

  it('does not list the chat’s model twice when the inventory has it', () => {
    const options = modelPickerOptions([{ id: 'openai/gpt-5-2025-08-07' }], 'openai/gpt-5-2025-08-07')

    expect(options).toHaveLength(1)
  })

  it('reads the row’s label back off the list it built', () => {
    const current = 'openai/gpt-5-2025-08-07'

    expect(modelRowLabel(modelPickerOptions([], current), current)).toBe('GPT-5')
  })
})

describe('refreshing a chat after a gateway restart', () => {
  it('re-reads the roster and re-opens the chat, and closes the menu', async () => {
    await openChat()

    fireEvent.press(screen.getByTestId('chat-header-options'))
    await waitFor(() => expect(screen.getByTestId('option-refresh')).toBeTruthy())

    mockController.openChat.mockClear()

    fireEvent.press(screen.getByTestId('option-refresh'))

    // The roster is where the canonical session id comes from, and after a
    // restart it is the one that has to be asked again.
    await waitFor(() => expect(mockRuntime.bots.refresh).toHaveBeenCalled())
    await waitFor(() => expect(mockController.openChat).toHaveBeenCalled())

    // The reader wants the transcript, not the menu they just pressed.
    expect(screen.queryByTestId('chat-options-backdrop', HIDDEN)).toBeNull()
  })
})

describe('per-chat notification types', () => {
  it('are not offered at all where nothing would read them', async () => {
    await openChat()

    fireEvent.press(screen.getByTestId('chat-header-options'))
    await waitFor(() => expect(screen.getByTestId('chat-options-popover')).toBeTruthy())

    // This device has never asked to be told anything, so there is nothing for
    // these switches to modify.
    expect(screen.queryByTestId('option-notifications')).toBeNull()
  })

  it('open as a page of the sheet, and write the chat’s own override', async () => {
    await openChat()

    act(() => {
      usePushStore.getState().setEnabled(true)
    })

    fireEvent.press(screen.getByTestId('chat-header-options'))
    await waitFor(() => expect(screen.getByTestId('option-notifications')).toBeTruthy())

    fireEvent.press(screen.getByTestId('option-notifications'))

    await waitFor(() => expect(screen.getByTestId('option-notify-cron')).toBeTruthy())

    // Switching one on turns every type on by default, so this one is a change.
    fireEvent.press(screen.getByTestId('option-notify-cron'))

    expect(usePushStore.getState().perBot.researcher).toEqual({ cron: false })
  })

  it('lists the six events a reader would answer differently per bot, and never `message`', async () => {
    await openChat()

    act(() => {
      usePushStore.getState().setEnabled(true)
    })

    fireEvent.press(screen.getByTestId('chat-header-options'))
    await waitFor(() => expect(screen.getByTestId('option-notifications')).toBeTruthy())
    fireEvent.press(screen.getByTestId('option-notifications'))

    await waitFor(() => expect(screen.getByTestId('option-notify-cron')).toBeTruthy())

    for (const type of ['turn_done', 'turn_failed', 'request', 'cron', 'cron_done', 'cron_failed']) {
      expect(screen.getByTestId(`option-notify-${type}`)).toBeTruthy()
    }

    // `message` is mute's domain. A second switch for it here would be two
    // controls for one decision, and they would disagree.
    expect(screen.queryByTestId('option-notify-message')).toBeNull()
  })

  it('lets a chat keep its failures while losing its chatter', async () => {
    await openChat()

    act(() => {
      usePushStore.getState().setEnabled(true)
    })

    fireEvent.press(screen.getByTestId('chat-header-options'))
    await waitFor(() => expect(screen.getByTestId('option-notifications')).toBeTruthy())
    fireEvent.press(screen.getByTestId('option-notifications'))
    await waitFor(() => expect(screen.getByTestId('option-notify-cron')).toBeTruthy())

    fireEvent.press(screen.getByTestId('option-notify-cron'))
    fireEvent.press(screen.getByTestId('option-notify-cron_done'))

    // Partial on purpose: `cron_failed` is not written, so it follows the
    // global switch as the global switch moves — which is the whole reason the
    // two outcomes are separate types.
    expect(usePushStore.getState().perBot.researcher).toEqual({ cron: false, cron_done: false })
  })
})

describe('the rows the keyboard walks', () => {
  it('are the same list the popover draws, export included only when there is one', () => {
    expect(popoverRows({ canExport: true, canRefresh: true, canSetNotifications: true }).map(row => row.id)).toEqual([
      'yolo',
      'fast',
      'reasoning',
      'model',
      'colour',
      'mute',
      'refresh',
      'notifications',
      'verbosity',
      'bot-to-bot',
      'thinking',
      'text-size',
      'export'
    ])

    expect(popoverRows({ canExport: false, canSetNotifications: false }).some(row => row.id === 'export')).toBe(false)
    expect(popoverRows({ canExport: true, canSetNotifications: false }).some(row => row.id === 'notifications')).toBe(
      false
    )
  })

  it('puts `new-chat` under `branch`, and gates it on its own flag', () => {
    expect(
      popoverRows({ canBranch: true, canExport: false, canNewChat: true, canSetNotifications: false }).map(
        row => row.id
      )
    ).toEqual(expect.arrayContaining(['branch', 'new-chat', 'conversations']))
    expect(
      popoverRows({ canBranch: true, canExport: false, canNewChat: true, canSetNotifications: false })
        .map(row => row.id)
        .filter(id => id === 'branch' || id === 'new-chat' || id === 'conversations')
    ).toEqual(['branch', 'new-chat', 'conversations'])

    // Each has its own gate: a gateway can offer one without the other.
    expect(popoverRows({ canExport: false, canNewChat: true, canSetNotifications: false }).map(row => row.id)).toEqual(
      expect.arrayContaining(['new-chat'])
    )
    expect(
      popoverRows({ canExport: false, canNewChat: false, canSetNotifications: false }).some(
        row => row.id === 'new-chat'
      )
    ).toBe(false)
  })

  it('clamps rather than wrapping, so the end of the list says it is the end', () => {
    expect(nextFocus(0, -1, 5)).toBe(0)
    expect(nextFocus(4, 1, 5)).toBe(4)
    expect(nextFocus(2, 1, 5)).toBe(3)
    expect(nextFocus(0, 1, 0)).toBe(0)
  })
})
