/**
 * Answering a permission request without the sheet (ADR-0010, amended).
 *
 * The sheet stays: a question the agent is BLOCKED on has to arrive in front of
 * the reader rather than wait in a transcript they may have scrolled away from.
 * What it cannot do is serve the reader who is already looking at the card, has
 * read the arguments and knows what they want — for them it is a second surface
 * asking something they have finished thinking about.
 *
 * Three things are pinned here:
 *
 *  1. the buttons are EXACTLY the server's `choices`, in the server's order, on
 *     both new surfaces. Inventing an "Always allow" the gateway did not offer
 *     would send a choice it will reject, which is the first rule the sheet's
 *     own file states;
 *  2. one tap answers — through the same handler the sheet uses, so the two
 *     cannot drift;
 *  3. the sheet goes down with it, rather than staying up to tell the reader
 *     what they have just done.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'

import { ChatScreen } from '../src/features/chats/ChatScreen'
import { ToolCard } from '../src/chat-ui/ToolCard'
import { type Bot, useBotsStore } from '../src/store/bots'
import { useChatsStore } from '../src/store/chats'
import { openRequests } from '@hermie/transcript'
import { useSettingsStore } from '../src/store/settings'
import type { ToolItem } from '../src/chat-ui/types'
import { renderScreen, withProviders, waitForGone } from './support/render'

let mockController: Record<string, jest.Mock>
let mockRuntime: {
  controller: Record<string, jest.Mock>
  bots: Record<string, never>
  push: { setOpenChat: jest.Mock }
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
  description: '',
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
    modelOptions: jest.fn(async () => [])
  }
}

function seedChat() {
  useBotsStore.getState().reset()
  useChatsStore.getState().reset()
  useSettingsStore.getState().reset()
  useBotsStore.getState().setBots([BOT])

  const chats = useChatsStore.getState()

  chats.ensure('researcher', { storedSessionId: 'stored-researcher', resolvedSessionId: 'stored-researcher' })
  chats.bindRuntime('researcher', 'runtime-1')
}

/** The gateway's own vocabulary, in the gateway's own order. */
const CHOICES = ['once', 'session', 'always', 'deny']

function seedApproval() {
  useChatsStore.getState().dispatchServerRequest('researcher', {
    id: 'srq-1',
    method: 'approval',
    params: { command: 'rm -rf build', choices: CHOICES, request_id: 'appr-1', tool_name: 'Bash' }
  })
}

beforeEach(() => {
  mockController = makeController()
  mockRuntime = { bots: {}, controller: mockController, push: { setOpenChat: jest.fn() } }
  seedChat()
})

const TOOL: ToolItem = {
  id: 't1',
  kind: 'tool',
  name: 'Bash',
  status: 'running',
  resultKnown: false,
  args: { command: 'rm -rf build' }
} as ToolItem

describe('the tool card can carry the question', () => {
  it('draws exactly the server’s choices, in the server’s order', () => {
    render(withProviders(<ToolCard approval={{ choices: CHOICES, onRespond: () => undefined }} item={TOOL} />))

    const drawn = CHOICES.map(choice => screen.getByTestId(`tool-approval-t1-${choice}`))

    expect(drawn).toHaveLength(4)
    // Nothing the gateway did not offer.
    expect(screen.queryByTestId('tool-approval-t1-forever')).toBeNull()
  })

  it('reports the choice verbatim, which is what the gateway accepts', () => {
    const onRespond = jest.fn()

    render(withProviders(<ToolCard approval={{ choices: CHOICES, onRespond }} item={TOOL} />))

    fireEvent.press(screen.getByTestId('tool-approval-t1-always'))

    expect(onRespond).toHaveBeenCalledWith('always')
  })

  it('draws nothing at all for a card with no question on it', () => {
    render(withProviders(<ToolCard item={TOOL} />))

    expect(screen.queryByTestId('tool-approval-t1')).toBeNull()
  })

  it('offers the question on a COLLAPSED card, not folded away inside it', () => {
    render(
      withProviders(
        <ToolCard approval={{ choices: CHOICES, onRespond: () => undefined }} item={TOOL} presentation="collapsed" />
      )
    )

    // A question the reader has to open a disclosure to find is a question that
    // is not being asked.
    expect(screen.queryByTestId('tool-body-t1')).toBeNull()
    expect(screen.getByTestId('tool-approval-t1')).toBeTruthy()
  })
})

describe('the request card in the transcript', () => {
  it('offers the choices in place, and answers through the controller', async () => {
    renderScreen(<ChatScreen bot="researcher" />)

    await waitFor(() => expect(screen.getByTestId('chat-header')).toBeTruthy())

    act(() => {
      seedApproval()
    })

    const open = openRequests(useChatsStore.getState().chats.researcher!)[0]

    await waitFor(() => expect(screen.getByTestId(`request-choice-${open?.id}-once`)).toBeTruthy())

    fireEvent.press(screen.getByTestId(`request-choice-${open?.id}-once`))

    await waitFor(() => expect(mockController.respondApproval).toHaveBeenCalled())

    const [, , choice] = mockController.respondApproval.mock.calls[0] as unknown[]

    expect(choice).toBe('once')
  })

  it('takes the sheet down with it, rather than reporting back what was just done', async () => {
    renderScreen(<ChatScreen bot="researcher" />)

    await waitFor(() => expect(screen.getByTestId('chat-header')).toBeTruthy())

    act(() => {
      seedApproval()
    })

    const open = openRequests(useChatsStore.getState().chats.researcher!)[0]

    await waitFor(() => expect(screen.getByTestId('approval-sheet')).toBeTruthy())

    fireEvent.press(screen.getByTestId(`request-choice-${open?.id}-deny`))

    await waitForGone(() => screen.queryByTestId('approval-sheet'), 'approval-sheet')
  })
})
