/**
 * Opening a chat against a connection that is not up yet.
 *
 * `openChat` ends in `session.resume`, and the JSON-RPC channel rejects a call
 * made before the socket is open — it does not queue. The screen used to call
 * it on mount regardless, so a cold start or a mid-reconnect open failed with
 * "gateway not connected", showed a red banner over the conversation, and left
 * the only way out a button the reader had to find and press.
 *
 * The roster hit the same race and was fixed by acting on the transition to
 * `status === 'ready'` (see `ChatRuntime`). These are the same rules for a
 * chat: hold while dialling, say so quietly, open on ready, retry a failed
 * attempt on the next ready connection, and keep the banner for failures that
 * happen while there IS a connection.
 */
import { render, screen, waitFor } from '@testing-library/react-native'
import { type ConnectionStatus, GatewayError } from '@hermie/gateway-client'

import { withProviders } from './support/render'
import { ChatScreen } from '../src/features/chats/ChatScreen'
import { type Bot, useBotsStore } from '../src/store/bots'
import { useChatsStore } from '../src/store/chats'
import { useSettingsStore } from '../src/store/settings'

let mockController: Record<string, jest.Mock>
let mockRuntime: {
  controller: Record<string, jest.Mock>
  bots: Record<string, never>
  push: { setOpenChat: jest.Mock }
}
let mockStatus: ConnectionStatus
let mockLastError: GatewayError | null

jest.mock('../src/gateway', () => {
  const actual = jest.requireActual('../src/gateway/errors') as Record<string, unknown>

  return {
    describeConnectionError: actual.describeConnectionError,
    useGateway: () => ({
      config: { baseUrl: 'https://gateway.example.com' },
      http: null,
      status: mockStatus,
      lastError: mockLastError
    })
  }
})

// `SignedOutPanel` reaches for the provider module directly rather than through
// the barrel above, because the barrel imports it back.
jest.mock('../src/gateway/GatewayProvider', () => ({
  useGateway: () => ({
    config: { baseUrl: 'https://gateway.example.com', authMode: 'session_token' },
    extraHeaders: {},
    status: mockStatus,
    adoptTokens: jest.fn(),
    signOut: jest.fn(),
    changeGateway: jest.fn()
  })
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
    steerSubagent: jest.fn(async () => 'ok'),
    interruptSubagent: jest.fn(async () => true),
    tailSubagent: jest.fn(async () => ''),
    querySlash: jest.fn(async () => []),
    runSlash: jest.fn(async () => undefined),
    setOption: jest.fn(async () => ({})),
    refreshOptions: jest.fn(async () => null),
    modelOptions: jest.fn(async () => [])
  }
}

/** Render, then walk the connection through a sequence of statuses. */
function renderChat() {
  const view = render(withProviders(<ChatScreen bot="researcher" />))

  return {
    ...view,
    setStatus(status: ConnectionStatus, error: GatewayError | null = null) {
      mockStatus = status
      mockLastError = error
      view.rerender(withProviders(<ChatScreen bot="researcher" />))
    }
  }
}

const FAILED_BANNER = /This conversation could not be opened/

beforeEach(() => {
  useBotsStore.getState().reset()
  useChatsStore.getState().reset()
  useSettingsStore.getState().reset()
  useBotsStore.getState().setBots([BOT])
  mockController = makeController()
  mockRuntime = { controller: mockController, bots: {}, push: { setOpenChat: jest.fn() } }
  mockStatus = 'connecting'
  mockLastError = null
})

it('does not open the chat while the socket is still dialling', async () => {
  renderChat()

  await waitFor(() => expect(screen.getByTestId('chat-connecting-state')).toBeTruthy())

  expect(mockController.openChat).not.toHaveBeenCalled()
})

it('says it is waiting rather than showing a failure with a retry on it', async () => {
  renderChat()

  await screen.findByTestId('chat-connecting-state')

  expect(screen.queryByText(FAILED_BANNER)).toBeNull()
  expect(screen.queryByTestId('chat-error-dismiss')).toBeNull()
})

it('opens by itself the moment the connection reports ready', async () => {
  const view = renderChat()

  await screen.findByTestId('chat-connecting-state')

  view.setStatus('ready')

  await waitFor(() => expect(mockController.openChat).toHaveBeenCalledWith(BOT, { follow: true }))
  expect(screen.queryByTestId('chat-connecting-state')).toBeNull()
})

it('opens once, not once per render, while the connection stays ready', async () => {
  const view = renderChat()
  view.setStatus('ready')

  await waitFor(() => expect(mockController.openChat).toHaveBeenCalledTimes(1))

  view.setStatus('ready')
  view.setStatus('ready')

  expect(mockController.openChat).toHaveBeenCalledTimes(1)
})

it('shows the banner for a failure that happened while connected', async () => {
  mockController.openChat.mockRejectedValue(new Error('session.resume timed out'))

  const view = renderChat()
  view.setStatus('ready')

  expect(await screen.findByText(/session\.resume timed out/)).toBeTruthy()
  expect(screen.getByTestId('chat-error-dismiss')).toBeTruthy()
})

it('tries again on the next ready connection after a failed attempt', async () => {
  mockController.openChat.mockRejectedValueOnce(new Error('gateway not connected'))

  const view = renderChat()
  view.setStatus('ready')

  await waitFor(() => expect(mockController.openChat).toHaveBeenCalledTimes(1))
  await screen.findByText(/gateway not connected/)

  // The socket drops and comes back: the reconnect is the thing that can fix a
  // failure like this, so it is what retries it.
  view.setStatus('reconnecting')
  view.setStatus('ready')

  await waitFor(() => expect(mockController.openChat).toHaveBeenCalledTimes(2))
  expect(screen.queryByText(FAILED_BANNER)).toBeNull()
})

it("drops a previous connection's failure instead of carrying it into the next dial", async () => {
  mockController.openChat.mockRejectedValue(new Error('session.resume timed out'))

  const view = renderChat()
  view.setStatus('ready')

  await screen.findByText(/session\.resume timed out/)

  view.setStatus('reconnecting')

  // The retry that banner offered is the reconnect now under way.
  expect(screen.queryByText(FAILED_BANNER)).toBeNull()
  expect(screen.getByTestId('chat-connecting-state')).toBeTruthy()
})

describe('a connection that will not become ready on its own', () => {
  it('shows the signed-out state inside the chat, not a banner over a dead transcript', async () => {
    // A phone reader who was already in a conversation when the token expired
    // used to get a transcript that simply stopped, under an error about
    // credentials. Neither says "sign in", which is the only thing that helps.
    const view = renderChat()
    view.setStatus('needs_signin')

    expect(await screen.findByTestId('signed-out-panel')).toBeTruthy()
    expect(screen.getByTestId('signed-out-sign-in')).toBeTruthy()
    // Terminal: waiting is not the story, so the quiet notice gives way.
    expect(screen.queryByTestId('chat-connecting-state')).toBeNull()
    expect(mockController.openChat).not.toHaveBeenCalled()
  })

  it('explains a gateway that refused this address by its close code', async () => {
    const view = renderChat()
    // A real instance, because `describeConnectionError` reads the close code
    // off one and falls back to the raw message for anything else.
    view.setStatus('reconnecting', new GatewayError('config', 'socket closed', { closeCode: 4403 }))

    expect(await screen.findByText(/does not trust this address/)).toBeTruthy()
    expect(screen.queryByTestId('chat-connecting-state')).toBeNull()
  })

  it('keeps waiting through an ordinary network wobble', async () => {
    const view = renderChat()
    view.setStatus('reconnecting', new GatewayError('network', 'ECONNREFUSED'))

    expect(await screen.findByTestId('chat-connecting-state')).toBeTruthy()
  })
})

describe('the header subtitle', () => {
  it('says Online for a live chat while the socket re-dials', async () => {
    const view = renderChat()
    view.setStatus('ready')

    await waitFor(() => expect(mockController.openChat).toHaveBeenCalled())

    // What a real `openChat` leaves behind: the chat exists and is attached.
    useChatsStore
      .getState()
      .ensure('researcher', { storedSessionId: 'stored-researcher', resolvedSessionId: 'stored-researcher' })
    useChatsStore.getState().setHydration('researcher', 'live')
    // Resuming from the background walks probing → authenticating → connecting
    // again while the session keeps streaming.
    view.setStatus('connecting')

    // The idle label is the BOT's word, not the socket's — see `subtitleFor`.
    await waitFor(() => expect(screen.getByText('Online')).toBeTruthy())
    expect(screen.queryByText('Connecting…')).toBeNull()
  })

  it('still says Connecting when there is no live chat behind it', async () => {
    renderChat()

    expect(await screen.findByText('Connecting…')).toBeTruthy()
  })
})
