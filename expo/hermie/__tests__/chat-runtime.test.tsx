/**
 * When the roster is actually read.
 *
 * A `GatewayConnection` exists from the moment a gateway is configured, long
 * before its socket is up. The runtime used to call `profiles.list` the instant
 * that object appeared: right after onboarding it failed with "gateway not
 * connected", nothing ever asked again, and the chat list sat on that error
 * while the header two lines above it said Connected.
 */
import { act, render, waitFor } from '@testing-library/react-native'
import { AppState, type AppStateStatus, Text } from 'react-native'

import { ChatRuntimeProvider } from '../src/features/chats/ChatRuntime'
import { useOwnAuthorStore } from '../src/features/chats/own-author'
import { AUTH_ME_BODY, AUTH_ME_STAMP, httpAnsweringAuthMe } from './support/auth-me'

const mockRefresh = jest.fn(async () => [])
const mockPlaceCurrentChats = jest.fn(async () => undefined)
const mockPaintFromCache = jest.fn(async () => undefined)
const mockOnForeground = jest.fn(async () => undefined)
const mockOnBackground = jest.fn()
const mockPersistAll = jest.fn(async () => undefined)

jest.mock('../src/platform/runs-on-mac', () => ({ RUNS_ON_MAC: false }))
jest.mock('../src/platform/desktop-shell', () => ({ RUNS_IN_DESKTOP_SHELL: false }))

const runsOnMac = jest.requireMock('../src/platform/runs-on-mac') as { RUNS_ON_MAC: boolean }
const desktopShell = jest.requireMock('../src/platform/desktop-shell') as {
  RUNS_IN_DESKTOP_SHELL: boolean
}

let mockStatus = 'connecting'
let mockConnection: object | null = { id: 'connection-1' }
// Whatever else a test wants `useGateway` to answer with: an id, a config, a REST half.
let mockGatewayExtras: Record<string, unknown> = {}
// What the runtime built its `ChatController` with, so the wiring can be read.
let mockControllerOptions: { ownAuthor?: () => unknown } | null = null

jest.mock('../src/gateway', () => ({
  useGateway: () => ({ connection: mockConnection, status: mockStatus, ...mockGatewayExtras })
}))

// `on` is not decoration here: the runtime subscribes to `sessions.changed` to
// re-read ADR-0016's settings section, because a profile row changing is the
// only signal a gateway gives that another client wrote one.
jest.mock('../src/gateway/link', () => ({
  chatGatewayFor: () => ({ on: () => () => undefined, request: async () => ({}) })
}))

jest.mock('../src/features/bots/bots-controller', () => ({
  // The three the private-chat directory reads off this module; the mock
  // replaces the whole of it, so leaving them out makes a title with
  // `undefined` in it rather than a failure anyone would notice.
  CANONICAL_CHAT_TITLE: 'Bot Chat',
  PROFILE_SESSION_LIST_LIMIT: 200,
  SESSION_COLUMNS: 96,
  BotsController: class {
    paintFromCache = mockPaintFromCache
    refresh = mockRefresh
    // Sub-chats: the runtime places each bot's remembered conversation on the
    // roster once the identity and the arrangement are both in.
    placeCurrentChats = mockPlaceCurrentChats
    dispose = jest.fn()
  }
}))

jest.mock('../src/features/chats/chat-controller', () => ({
  ChatController: class {
    constructor(options: { ownAuthor?: () => unknown }) {
      mockControllerOptions = options
    }

    start = jest.fn()
    stop = jest.fn()
    onForeground = mockOnForeground
    onBackground = mockOnBackground
    persistAll = mockPersistAll
  }
}))

beforeEach(() => {
  jest.clearAllMocks()
  mockStatus = 'connecting'
  mockConnection = { id: 'connection-1' }
  mockGatewayExtras = {}
  mockControllerOptions = null
  useOwnAuthorStore.getState().reset()
  runsOnMac.RUNS_ON_MAC = false
  desktopShell.RUNS_IN_DESKTOP_SHELL = false
})

afterEach(() => jest.restoreAllMocks())

function renderRuntime() {
  return render(
    <ChatRuntimeProvider>
      <Text>ready</Text>
    </ChatRuntimeProvider>
  )
}

describe('ChatRuntimeProvider', () => {
  it('does not read the roster while the connection is still dialling', async () => {
    renderRuntime()

    await waitFor(() => expect(mockPaintFromCache).toHaveBeenCalled())
    expect(mockRefresh).not.toHaveBeenCalled()
  })

  it('reads it as soon as the connection is ready', async () => {
    const view = renderRuntime()

    mockStatus = 'ready'
    view.rerender(
      <ChatRuntimeProvider>
        <Text>ready</Text>
      </ChatRuntimeProvider>
    )

    await waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1))
  })

  it('reads it again after a reconnect, and only then', async () => {
    mockStatus = 'ready'

    const view = renderRuntime()
    const rerender = () =>
      view.rerender(
        <ChatRuntimeProvider>
          <Text>ready</Text>
        </ChatRuntimeProvider>
      )

    await waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1))

    // Still ready: no second read.
    rerender()
    expect(mockRefresh).toHaveBeenCalledTimes(1)

    mockStatus = 'reconnecting'
    rerender()
    mockStatus = 'ready'
    rerender()

    await waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(2))
  })
})

/**
 * The chat side of the app lifecycle, and the one place a desktop window differs.
 *
 * `onBackground()` stops the approval and subagent polls. That is right where
 * the socket goes down with it, and wrong on a Mac: a hidden window keeps its
 * connection (see `__tests__/mac-lifecycle.test.ts`), so stopping the polls
 * would leave an agent's question unanswered while the window sat one Cmd+Tab
 * away. `foregrounded` starts true in the controller, so not calling it is
 * exactly what the deleted native macOS target did by ignoring AppState.
 *
 * The Tauri desktop shell is the same window with a different answer to "am I
 * a desktop window": a global the shell injects rather than a native module.
 * Its socket stays up for the same reason, so its polls must too — and it
 * arrives here far more often than a Mac does, because this is the browser
 * build and react-native-web reports `background` on `document.hidden`.
 */
describe('ChatRuntimeProvider and AppState', () => {
  function subscribe() {
    let handler: ((state: AppStateStatus) => void) | undefined

    jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, next) => {
      handler = next as (state: AppStateStatus) => void

      return { remove: jest.fn() } as unknown as ReturnType<typeof AppState.addEventListener>
    })

    renderRuntime()

    if (!handler) {
      throw new Error('ChatRuntimeProvider did not subscribe to AppState')
    }

    return handler
  }

  it('stops the polls in the background on a phone, and persists', async () => {
    const send = subscribe()

    await act(async () => send('background'))

    expect(mockOnBackground).toHaveBeenCalledTimes(1)
    expect(mockPersistAll).toHaveBeenCalledTimes(1)
  })

  it('keeps polling in the background on a Mac, and still persists', async () => {
    runsOnMac.RUNS_ON_MAC = true
    const send = subscribe()

    await act(async () => send('background'))

    expect(mockOnBackground).not.toHaveBeenCalled()
    expect(mockPersistAll).toHaveBeenCalledTimes(1)
  })

  it('keeps polling in the background in the desktop shell, and still persists', async () => {
    desktopShell.RUNS_IN_DESKTOP_SHELL = true
    const send = subscribe()

    await act(async () => send('background'))

    expect(mockOnBackground).not.toHaveBeenCalled()
    expect(mockPersistAll).toHaveBeenCalledTimes(1)
  })

  it('re-reads what the agent is waiting on when the window comes forward, on all three', async () => {
    runsOnMac.RUNS_ON_MAC = true
    const send = subscribe()

    await act(async () => send('active'))

    expect(mockOnForeground).toHaveBeenCalledTimes(1)
  })
})

/**
 * HERM-83: the reader's own author id, fed from the `/api/auth/me` read the
 * runtime already does on every ready edge, spelled the way the gateway stamps
 * a row — and handed to the controller for the optimistic bubble.
 */
describe('ChatRuntimeProvider and the reader’s own author', () => {
  function readyOn(gatewayId: string, http = httpAnsweringAuthMe()) {
    mockStatus = 'ready'
    mockGatewayExtras = {
      gatewayId,
      http,
      config: { baseUrl: 'https://gateway.example.test', authMode: 'native_pkce' }
    }

    return renderRuntime()
  }

  it('files `<provider>:<user_id>` from the real answer under the gateway that gave it', async () => {
    readyOn('gateway-one')

    await waitFor(() =>
      expect(useOwnAuthorStore.getState().byGateway['gateway-one']).toEqual({
        id: AUTH_ME_STAMP,
        name: AUTH_ME_BODY.display_name
      })
    )
    expect(useOwnAuthorStore.getState().gatewayId).toBe('gateway-one')
  })

  it('hands the controller the same author for an optimistic bubble', async () => {
    readyOn('gateway-one')

    await waitFor(() => expect(useOwnAuthorStore.getState().byGateway['gateway-one']).toBeDefined())
    expect(mockControllerOptions?.ownAuthor?.()).toEqual({ id: AUTH_ME_STAMP, name: AUTH_ME_BODY.display_name })
  })

  it('files no id at all when the gateway names no provider — never the bare id, never the email', async () => {
    const { provider: _provider, ...noProvider } = AUTH_ME_BODY

    readyOn('gateway-one', httpAnsweringAuthMe(noProvider))

    await waitFor(() => expect(mockRefresh).toHaveBeenCalled())
    await act(async () => undefined)
    expect(useOwnAuthorStore.getState().byGateway['gateway-one']).toBeUndefined()
    expect(mockControllerOptions?.ownAuthor?.()).toBeUndefined()
  })

  /**
   * HERM-83 polish: rebuilding the connection used to wipe this back to
   * "unknown", which reads as "everything is mine" and drew a cached
   * transcript's colleagues on the right — with a receipt — until the next
   * `/api/auth/me` answered and they jumped left. The id is a guess either way;
   * the fix is which guess a cold open starts from.
   */
  it('keeps a previously confirmed id across a rebuilt connection, not merely until it is asked again', async () => {
    useOwnAuthorStore.getState().set('gateway-one', { id: 'authentik:somebody-before' })
    mockGatewayExtras = { gatewayId: 'gateway-one' }

    renderRuntime()

    await waitFor(() => expect(mockPaintFromCache).toHaveBeenCalled())
    expect(useOwnAuthorStore.getState().byGateway['gateway-one']).toEqual({ id: 'authentik:somebody-before' })
  })

  it('replaces the remembered id once `/api/auth/me` answers with a different one', async () => {
    useOwnAuthorStore.getState().set('gateway-one', { id: 'authentik:somebody-before' })

    readyOn('gateway-one')

    await waitFor(() =>
      expect(useOwnAuthorStore.getState().byGateway['gateway-one']).toEqual({
        id: AUTH_ME_STAMP,
        name: AUTH_ME_BODY.display_name
      })
    )
  })

  it('keeps the remembered id when `/api/auth/me` refuses rather than answering "nobody"', async () => {
    useOwnAuthorStore.getState().set('gateway-one', { id: 'authentik:somebody-before' })

    mockStatus = 'ready'
    mockGatewayExtras = {
      gatewayId: 'gateway-one',
      http: {
        authMe: async () => {
          throw new Error('offline')
        }
      },
      config: { baseUrl: 'https://gateway.example.test', authMode: 'native_pkce' }
    }

    renderRuntime()

    await waitFor(() => expect(mockRefresh).toHaveBeenCalled())
    await act(async () => undefined)
    expect(useOwnAuthorStore.getState().byGateway['gateway-one']).toEqual({ id: 'authentik:somebody-before' })
  })

  it('never lets one gateway’s remembered id leak into another it is bound to', async () => {
    useOwnAuthorStore.getState().set('gateway-one', { id: 'authentik:alex' })
    mockGatewayExtras = { gatewayId: 'gateway-two' }

    renderRuntime()

    await waitFor(() => expect(mockPaintFromCache).toHaveBeenCalled())
    expect(useOwnAuthorStore.getState().gatewayId).toBe('gateway-two')
    expect(useOwnAuthorStore.getState().byGateway['gateway-two']).toBeUndefined()
  })
})
