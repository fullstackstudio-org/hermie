/**
 * The one sheet a chat shows, and the order it shows things in.
 *
 * The bug this replaces was invisible in a screenshot: four sibling `Modal`s
 * each thought they were visible, iOS presented whichever asked first, and a
 * permission request that arrived while the options sheet was open simply
 * never appeared. So the assertions here are about SEQUENCE — what is on
 * screen, what replaces it, and what happens to a question after it has been
 * answered — rather than about how any one sheet looks.
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native'
import { useState } from 'react'

import { SHEET_ANIMATION_MS } from '../src/ui/BottomSheet'
import { ChatSheetHost, type RequestItem } from '../src/features/chats/ChatSheetHost'
import {
  initialSheetHostState,
  isSheetVisible,
  sheetHostReducer,
  targetSheet,
  type ManualSheet,
  type SheetHostState
} from '../src/features/chats/sheet-host'
import { approvalItem, clarifyItem, subagentTree } from '../src/chat-ui/fixtures'
import { type Bot, useBotsStore } from '../src/store/bots'
import { renderScreen, withProviders } from './support/render'

let mockController: {
  listBotConversations: jest.Mock
  onConversationsChanged: jest.Mock
  selectConversation: jest.Mock
}

jest.mock('../src/features/chats/ChatRuntime', () => ({
  useChatRuntime: () => ({ controller: mockController, userChats: { available: true, title: 'Chat · Researcher' } })
}))

describe('the sheet-host state machine', () => {
  it('ranks a waiting question above anything the reader opened', () => {
    expect(targetSheet('options', true)).toBe('request')
    expect(targetSheet('agents', true)).toBe('request')
    expect(targetSheet('agents', false)).toBe('agents')
    expect(targetSheet('none', false)).toBe('none')
  })

  it('opens straight away when nothing is on screen', () => {
    const next = sheetHostReducer(initialSheetHostState, { type: 'target', target: 'options' })

    expect(next).toEqual({ presented: 'options', target: 'options' })
    expect(isSheetVisible(next)).toBe(true)
  })

  it('closes the sheet that is up before it opens the next one', () => {
    const open: SheetHostState = { presented: 'options', target: 'options' }
    const swapping = sheetHostReducer(open, { type: 'target', target: 'request' })

    // Still mounted, no longer visible: this is the slide-out.
    expect(swapping).toEqual({ presented: 'options', target: 'request' })
    expect(isSheetVisible(swapping)).toBe(false)

    const settled = sheetHostReducer(swapping, { type: 'settled' })

    expect(settled).toEqual({ presented: 'request', target: 'request' })
    expect(isSheetVisible(settled)).toBe(true)
  })

  it('cancels a swap that changes its mind before the slide-out lands', () => {
    const swapping: SheetHostState = { presented: 'options', target: 'request' }
    const back = sheetHostReducer(swapping, { type: 'target', target: 'options' })

    expect(isSheetVisible(back)).toBe(true)
    expect(back.presented).toBe('options')
  })

  it('leaves nothing mounted once the last sheet has closed', () => {
    const closing = sheetHostReducer({ presented: 'request', target: 'request' }, { type: 'target', target: 'none' })

    expect(isSheetVisible(closing)).toBe(false)
    expect(sheetHostReducer(closing, { type: 'settled' })).toEqual({ presented: 'none', target: 'none' })
  })
})

const AGENTS = { tree: subagentTree }

const OPTIONS = {
  botName: 'Researcher',
  fast: false,
  model: 'example-model',
  modelOptions: [],
  onChangeFast: jest.fn(),
  onChangeModel: jest.fn(),
  onChangeReasoningEffort: jest.fn(),
  onChangeShowBotToBot: jest.fn(),
  onChangeShowThinking: jest.fn(),
  onChangeVerbosity: jest.fn(),
  onChangeYolo: jest.fn(),
  reasoningEffort: 'medium',
  reasoningOptions: [],
  showBotToBot: true,
  showThinking: true,
  verbosity: 'normal' as const,
  yolo: false
}

/**
 * A harness that owns the items the way the chat screen does: the host is told
 * which question is OPEN, and looks any question up by id — including one that
 * has stopped being open, which is the whole point of `findRequest`.
 */
function Harness({
  items,
  open,
  manual = 'none',
  onCloseRequest = jest.fn(),
  onRespondApproval = jest.fn(),
  onShowRequest,
  withConversations = false
}: {
  items: RequestItem[]
  open?: string
  manual?: ManualSheet
  onCloseRequest?: (item: RequestItem) => void
  onRespondApproval?: (item: RequestItem, choice: string) => void
  onShowRequest?: (item: RequestItem) => void
  /** Task 6: hands the host a `conversations` prop, the way `ChatScreen` does when `canCreate`. */
  withConversations?: boolean
}) {
  const [sheet, setSheet] = useState(manual)

  // The chat screen keeps the questions the reader has put aside and stops
  // offering them, which is what takes a sheet off the screen at all. Modelled
  // here rather than stubbed, because the host restores a question it is still
  // being handed — see `keepHeld`.
  const [aside, setAside] = useState<string[]>([])
  const open_ = open && !aside.includes(open) ? open : undefined

  return (
    <ChatSheetHost
      agents={AGENTS}
      botHandle="researcher"
      {...(withConversations ? { conversations: { botName: 'researcher' } } : {})}
      findRequest={id => items.find(item => item.id === id)}
      manual={sheet}
      onCloseManual={() => setSheet('none')}
      onCloseRequest={item => {
        setAside(current => (current.includes(item.id) ? current : [...current, item.id]))
        onCloseRequest(item)
      }}
      onLockClarify={jest.fn()}
      onRespondApproval={onRespondApproval}
      onSubmitClarify={jest.fn()}
      options={OPTIONS}
      tapGuardMs={0}
      {...(onShowRequest ? { onShowRequest } : {})}
      {...(open_ ? { request: items.find(item => item.id === open_) } : {})}
    />
  )
}

const renderHost = renderScreen

const BOT: Bot = {
  name: 'researcher',
  displayName: 'Researcher',
  description: '',
  model: '',
  provider: '',
  isDefault: false,
  hasAvatar: false,
  uiMetaRevision: 0,
  canonical: { id: 'stored-group', resolvedId: 'stored-group', preview: '', lastActive: 0, messageCount: 0 }
}

beforeEach(() => {
  useBotsStore.getState().reset()
  useBotsStore.getState().setBots([BOT])
  mockController = {
    listBotConversations: jest.fn(async () => ({ group: null, own: [], canCreate: true })),
    onConversationsChanged: jest.fn(() => jest.fn()),
    selectConversation: jest.fn(async () => undefined)
  }
})

/**
 * The `'conversations'` sheet (Task 6): same priority rules as the other
 * manual ones — a request outranks it, and picking a row is the reason it
 * was opened at all.
 */
describe('the conversations sheet', () => {
  it('is presented for the manual target `conversations`', async () => {
    renderHost(<Harness items={[]} manual="conversations" withConversations />)

    await waitFor(() => expect(screen.getByTestId('conversation-sheet')).toBeTruthy())
  })

  it('gives way to a question that arrives while it is open', async () => {
    const view = renderHost(<Harness items={[approvalItem]} manual="conversations" withConversations />)

    await waitFor(() => expect(screen.getByTestId('conversation-sheet')).toBeTruthy())

    view.rerender(
      withProviders(<Harness items={[approvalItem]} manual="conversations" open={approvalItem.id} withConversations />)
    )

    await screen.findByTestId('approval-sheet')
    expect(view.queryByTestId('conversation-sheet')).toBeNull()
  })

  it('closes on picking a row, the same way every other manual sheet does', async () => {
    renderHost(<Harness items={[]} manual="conversations" withConversations />)

    // `ConversationSheet` hands its list the testID `conversation-sheet-list`,
    // so the row underneath it is prefixed the same way.
    await waitFor(() => expect(screen.getByTestId('conversation-sheet-list-row-stored-group')).toBeTruthy())

    fireEvent.press(screen.getByTestId('conversation-sheet-list-row-stored-group'))

    await waitFor(() => expect(mockController.selectConversation).toHaveBeenCalledWith(BOT, null))
    await waitFor(() => expect(screen.queryByTestId('conversation-sheet')).toBeNull())
  })

  it('draws nothing when the caller gave no entry point to conversations at all', () => {
    renderHost(<Harness items={[]} manual="conversations" />)

    expect(screen.queryByTestId('conversation-sheet')).toBeNull()
  })
})

describe('ChatSheetHost', () => {
  it('presents a question that arrives while the options sheet is open', async () => {
    const view = renderHost(<Harness items={[approvalItem]} manual="options" />)

    expect(screen.getByTestId('chat-options-sheet')).toBeTruthy()
    expect(view.queryByTestId('approval-sheet')).toBeNull()

    // The question arrives. The options sheet has to go first, and the
    // approval takes its place once it has.
    view.rerender(withProviders(<Harness items={[approvalItem]} manual="options" open={approvalItem.id} />))

    await screen.findByTestId('approval-sheet')
    expect(view.queryByTestId('chat-options-sheet')).toBeNull()
  })

  it('never has two sheets mounted at once', () => {
    const view = renderHost(<Harness items={[clarifyItem]} manual="agents" open={clarifyItem.id} />)

    expect(view.queryByTestId('agents-sheet')).toBeNull()
    expect(screen.getByTestId('clarify-sheet')).toBeTruthy()
  })

  it('keeps an answered question on screen and says what happened to it', () => {
    const answered: RequestItem = { ...approvalItem, answer: 'once', state: 'answered' }

    const view = renderHost(<Harness items={[approvalItem]} open={approvalItem.id} />)

    expect(screen.getByTestId('approval-choice-once')).toBeTruthy()

    // The gateway resolves it: `chat.requests` no longer lists it at all.
    view.rerender(withProviders(<Harness items={[answered]} />))

    expect(screen.getByTestId('approval-resolution')).toHaveTextContent('Answered: Allow once')
    expect(view.queryByTestId('approval-choice-once')).toBeNull()
  })

  it('says so when a question was answered somewhere else', () => {
    const elsewhere: RequestItem = { ...approvalItem, cancelReason: 'resolved', state: 'cancelled' }
    const view = renderHost(<Harness items={[approvalItem]} open={approvalItem.id} />)

    view.rerender(withProviders(<Harness items={[elsewhere]} />))

    expect(screen.getByTestId('approval-resolution')).toHaveTextContent('Answered elsewhere')
  })

  it('says so when a question timed out', () => {
    const timedOut: RequestItem = { ...approvalItem, cancelReason: 'timeout', state: 'cancelled' }
    const view = renderHost(<Harness items={[approvalItem]} open={approvalItem.id} />)

    view.rerender(withProviders(<Harness items={[timedOut]} />))

    expect(screen.getByTestId('approval-resolution')).toHaveTextContent('Timed out')
  })

  it('leaves on the tap, before the answer has been anywhere', () => {
    jest.useFakeTimers()

    // The sheet no longer waits for `approval.respond` to land and then sits
    // for two seconds saying what the reader just did. The tap starts the
    // slide-out, and the RPC travels behind it: `onRespondApproval` is called
    // with the question already off the screen.
    try {
      const onCloseRequest = jest.fn()
      const onRespondApproval = jest.fn()
      renderHost(
        <Harness
          items={[approvalItem]}
          onCloseRequest={onCloseRequest}
          onRespondApproval={onRespondApproval}
          open={approvalItem.id}
        />
      )

      fireEvent.press(screen.getByTestId('approval-choice-once'))

      expect(onRespondApproval).toHaveBeenCalledWith(expect.objectContaining({ id: approvalItem.id }), 'once')
      // Off the SCREEN, still open on the gateway: the question keeps its place
      // in the transcript until the answer lands, and comes back with its
      // `Answer` button if it does not.
      expect(onCloseRequest).toHaveBeenCalledWith(expect.objectContaining({ id: approvalItem.id }))

      // And it is off the screen one slide-out later, with the question still
      // open in `items`: nothing in this test ever answers it.
      act(() => {
        jest.advanceTimersByTime(SHEET_ANIMATION_MS * 2)
      })

      expect(screen.queryByTestId('approval-sheet')).toBeNull()
    } finally {
      jest.useRealTimers()
    }
  })

  it('answers a question exactly once, however often the button is pressed', () => {
    // A closing sheet SLIDES, so its buttons are under the finger for the whole
    // animation — and the answer no longer waits for anything that would make a
    // second press a no-op on its own.
    const onRespondApproval = jest.fn()
    renderHost(<Harness items={[approvalItem]} onRespondApproval={onRespondApproval} open={approvalItem.id} />)

    fireEvent.press(screen.getByTestId('approval-choice-once'))
    fireEvent.press(screen.getByTestId('approval-choice-once'))

    expect(onRespondApproval).toHaveBeenCalledTimes(1)
  })

  it('re-arms the tap guard for the next question rather than inheriting the last one', () => {
    jest.useFakeTimers()

    try {
      const onRespondApproval = jest.fn()
      const second: RequestItem = { ...approvalItem, id: 'ap-2', command: 'rm -rf build', requestId: 'srq-9' }
      const view = renderHost(
        <Harness items={[approvalItem]} onRespondApproval={onRespondApproval} open={approvalItem.id} />
      )

      act(() => {
        jest.advanceTimersByTime(400)
      })

      // The first question is answered and a second arrives in its place.
      view.rerender(
        withProviders(
          <Harness
            items={[{ ...approvalItem, answer: 'once', state: 'answered' }, second]}
            onRespondApproval={onRespondApproval}
            open={second.id}
          />
        )
      )

      expect(screen.getByTestId('approval-command')).toHaveTextContent('rm -rf build')
    } finally {
      jest.useRealTimers()
    }
  })

  it('tells the caller about each question exactly once', () => {
    const onShowRequest = jest.fn()
    const view = renderHost(<Harness items={[approvalItem]} onShowRequest={onShowRequest} open={approvalItem.id} />)

    view.rerender(
      withProviders(<Harness items={[approvalItem]} onShowRequest={onShowRequest} open={approvalItem.id} />)
    )

    expect(onShowRequest).toHaveBeenCalledTimes(1)
    expect(onShowRequest).toHaveBeenCalledWith(expect.objectContaining({ id: approvalItem.id }))
  })

  it('offers "Later" rather than "Skip" on a clarify, and only puts it aside', () => {
    const onCloseRequest = jest.fn()

    renderHost(<Harness items={[clarifyItem]} onCloseRequest={onCloseRequest} open={clarifyItem.id} />)

    expect(screen.getByText('Later')).toBeTruthy()

    fireEvent.press(screen.getByTestId('clarify-skip'))
    expect(onCloseRequest).toHaveBeenCalledWith(expect.objectContaining({ id: clarifyItem.id }))
  })
})
