/**
 * The phone shell: four tabs, and exactly one way back from anywhere.
 *
 * This file counts over the WHOLE screen rather than inside a page's own
 * wrapper, and that is the point of it. `settings-routes.test.tsx` walks the
 * Settings registry and looks for `page-back` INSIDE `settings-page-<Name>`, so
 * a second back drawn by the SHELL — a native stack header, say — is invisible
 * to it. That is exactly the defect this replaces: every non-chat route used to
 * carry the platform header as well as its own `PageChrome`, which made two
 * title bars and two back controls, one of them labelled with the route KEY
 * `Bots` rather than with the page it would land on (HERM-75, HERM-101).
 *
 * So the instruments are deliberately global:
 *
 *  - `backs()` finds every `page-back` anywhere on screen;
 *  - `nativeHeaders()` finds every `RNSScreenStackHeaderConfig` that is not
 *    `hidden`, which is what `react-native-screens` renders a native header as.
 *    The element exists either way — `headerShown: false` sets `hidden` — so the
 *    prop is what is checked, not the element's presence.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native'
import { BackHandler, useWindowDimensions } from 'react-native'

import { CompactShell } from '../src/app/CompactShell'
import { cronJobFromRow } from '../src/features/cron/model'
import { requestOpenChat } from '../src/app/open-chat-bus'
import { SETTINGS_ROUTES } from '../src/features/settings/navigation'
import { strings } from '../src/i18n/strings'
import { type Bot, useBotsStore } from '../src/store/bots'
import { useChatLayoutStore } from '../src/store/chat-layout'
import { useChatsStore } from '../src/store/chats'
import { useCronStore } from '../src/store/cron'
import { useSettingsStore } from '../src/store/settings'
import { renderScreen } from './support/render'

const mockHttpGet = jest.fn()
const mockRequest = jest.fn()

let mockRuntime: {
  controller: Record<string, jest.Mock>
  bots: Record<string, jest.Mock>
  push: { setOpenChat: jest.Mock }
}

const mockRegistry = {
  activeGatewayId: 'g1',
  gateways: [
    {
      addedAt: 1,
      address: 'https://gateway.example.com',
      authKind: 'session_token' as const,
      id: 'g1',
      name: 'Home',
      signedInUser: 'Sam'
    }
  ]
}

jest.mock('../src/gateway', () => {
  // The registry helpers are real: `GatewayTitle` reads the list this mock
  // hands out, and a stub of the sorter would only be this file agreeing with
  // itself about the order.
  const registryModule = jest.requireActual('../src/gateway/registry')
  const http = {
    get: (...args: unknown[]) => mockHttpGet(...args),
    post: async () => ({}),
    requestHeaders: async () => ({})
  }
  const connection = {
    request: (...args: unknown[]) => mockRequest(...args),
    on: () => () => undefined,
    onAny: () => () => undefined,
    onRequest: () => () => undefined,
    onStatus: () => () => undefined,
    http
  }

  return {
    gatewayLabel: registryModule.gatewayLabel,
    gatewaysInOrder: registryModule.gatewaysInOrder,
    createGatewayConnection: () => ({ http, onStatus: () => () => undefined, start: jest.fn(), stop: jest.fn() }),
    hostOf: (url: string) => url.replace(/^https?:\/\//u, ''),
    useGateway: () => ({
      canRefresh: true,
      changeGateway: jest.fn(),
      config: { authMode: 'session_token', baseUrl: 'https://gateway.example.com', version: '1.2.3' },
      connection,
      forgetGateway: jest.fn(),
      gatewayId: 'g1',
      http,
      refreshRegistry: jest.fn(async () => undefined),
      registry: mockRegistry,
      removeGateway: jest.fn(),
      renameGateway: jest.fn(),
      signOut: jest.fn(),
      signOutOf: jest.fn(),
      status: 'ready',
      switchGateway: jest.fn()
    })
  }
})

jest.mock('../src/gateway/GatewayProvider', () => ({
  useGateway: () => ({
    adoptTokens: jest.fn(),
    changeGateway: jest.fn(),
    config: { authMode: 'session_token', baseUrl: 'https://gateway.example.com' },
    extraHeaders: {},
    signOut: jest.fn(),
    status: 'ready'
  })
}))

jest.mock('../src/features/chats/ChatRuntime', () => ({ useChatRuntime: () => mockRuntime }))
jest.mock('../src/platform/haptics', () => ({ haptic: jest.fn() }))
jest.mock('../src/features/chats/attachments', () => ({
  MAX_ATTACHMENT_EDGE: 1568,
  openAppSettings: jest.fn(),
  pickAttachment: jest.fn(async () => null)
}))

// Half a megabyte of generated JSON, and no page in this file opens it.
jest.mock('../src/features/settings/licences-data', () => ({
  loadLicenceData: async () => ({
    generatedBy: 'scripts/generate-third-party-licenses.mjs',
    scope: 'production dependencies of expo/hermie',
    excludesWorkspacePackages: [],
    packages: [],
    texts: {}
  })
}))

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

const JOB = {
  deliver: 'bot-chat:researcher',
  enabled: true,
  id: 'job-scan-researcher',
  last_error: null,
  last_run_at: null,
  last_status: 'ok',
  name: 'Source scan',
  next_run_at: null,
  profile: 'researcher',
  profile_name: 'researcher',
  prompt: 'Scan the sources.',
  repeat: { times: null, completed: 0 },
  schedule: { kind: 'interval', display: 'every 4h', seconds: 14_400 },
  schedule_display: 'every 4h',
  skills: [],
  state: 'scheduled'
}

/** Researcher's chat, holding one cron delivery — the card that opens a cron. */
function seedChat() {
  const chats = useChatsStore.getState()

  chats.ensure('researcher', { storedSessionId: 'stored-researcher', resolvedSessionId: 'stored-researcher' })
  chats.update('researcher', state => ({
    ...state,
    items: {
      'c:1': {
        body: 'Three new sources since yesterday.',
        id: 'c:1',
        jobName: 'Source scan',
        kind: 'cron_delivery',
        origin: 'history',
        seq: 10,
        shape: 'bot_chat',
        ts: 1_700_000_000,
        version: 0
      }
    },
    order: ['c:1']
  }))
}

/** Every `page-back` on screen, wherever it was drawn. */
const backs = () => screen.queryAllByTestId('page-back')

/** Every native stack header that is actually showing. */
function nativeHeaders() {
  return screen.UNSAFE_root.findAll(
    node => typeof node.type === 'string' && node.type === 'RNSScreenStackHeaderConfig' && node.props.hidden !== true,
    { deep: true }
  )
}

/**
 * Android's back press, delivered the way the OS delivers it: to the
 * most-recently-registered handler first, stopping at the first one that claims
 * it. `false` means nobody did — which on a device is the press that backgrounds
 * the app.
 */
let backHandlers: (() => boolean | null | undefined)[] = []

function pressAndroidBack(): boolean {
  for (const handler of [...backHandlers].reverse()) {
    if (handler() === true) {
      return true
    }
  }

  return false
}

beforeEach(() => {
  backHandlers = []
  jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_event, handler) => {
    backHandlers.push(handler)

    return {
      remove: () => {
        backHandlers = backHandlers.filter(entry => entry !== handler)
      }
    }
  })

  mockRuntime = {
    bots: { watchRunning: jest.fn(() => () => undefined) },
    controller: {
      acknowledgeApproval: jest.fn(async () => undefined),
      activeSubagentCount: jest.fn(async () => 0),
      inFlightDeliveries: jest.fn(async () => 0),
      closeChat: jest.fn(async () => undefined),
      interruptSubagent: jest.fn(async () => true),
      lockClarify: jest.fn(async () => undefined),
      modelOptions: jest.fn(async () => []),
      openChat: jest.fn(async () => undefined),
      openConversation: jest.fn(async () => undefined),
      querySlash: jest.fn(async () => []),
      readKeyFor: jest.fn((name: string) => name),
      refreshOptions: jest.fn(async () => null),
      respondApproval: jest.fn(async () => undefined),
      respondClarify: jest.fn(async () => undefined),
      runSlash: jest.fn(async () => undefined),
      send: jest.fn(async () => undefined),
      setOption: jest.fn(async () => ({})),
      steerSubagent: jest.fn(async () => 'ok'),
      stopTurn: jest.fn(async () => undefined),
      tailSubagent: jest.fn(async () => '')
    },
    push: { setOpenChat: jest.fn() }
  }

  mockHttpGet.mockReset()
  mockHttpGet.mockImplementation(async (path: string) =>
    path.startsWith('/api/cron/jobs') ? [JOB] : { targets: [{ id: 'local', name: 'Local (save only)' }] }
  )
  mockRequest.mockReset()
  mockRequest.mockResolvedValue({ gateway_running: true, jobs: [], success: true })

  useBotsStore.getState().reset()
  useChatsStore.getState().reset()
  useChatLayoutStore.getState().reset()
  useCronStore.getState().reset()
  useSettingsStore.getState().reset()
  useBotsStore.getState().setBots([bot('researcher', 'Researcher'), bot('writer', 'Writer')])
  useCronStore.getState().setJobs([cronJobFromRow(JOB)], true)
  mockDimensions.mockReturnValue({ width: 402, height: 874, scale: 3, fontScale: 1 })
})

afterEach(() => {
  jest.restoreAllMocks()
})

/**
 * A tab root has no back control, because there is nowhere under it to go.
 *
 * Before the tabs there was: Activity, Crons and Settings were PUSHED over the
 * chat list, so each carried a native header whose back read the route key and
 * said "‹ Bots" (HERM-75). The tab bar is what makes "no back here" a true
 * statement rather than a missing way home.
 */
describe('the four tab roots', () => {
  const ROOTS = [
    ['Chats', undefined, 'tab-chats'],
    ['Activity', 'activity', 'tab-activity'],
    ['Crons', 'cron', 'tab-cron'],
    ['Settings', 'settings', 'tab-settings']
  ] as const

  it.each(ROOTS)('%s draws no back control and no native header', async (_name, section, tab) => {
    renderScreen(<CompactShell {...(section ? { initial: { section } } : {})} />)

    await waitFor(() => expect(screen.getByTestId(tab)).toBeTruthy())

    expect(backs()).toHaveLength(0)
    expect(nativeHeaders()).toHaveLength(0)
    // The route KEY, which the platform header used to print as a title and as
    // a back label. Nothing on this screen is called that any more.
    expect(screen.queryByText('Bots')).toBeNull()
  })

  it('reaches every other root from the bar, still without a back', async () => {
    renderScreen(<CompactShell />)

    await waitFor(() => expect(screen.getByTestId('tab-chats')).toBeTruthy())

    for (const [, , tab] of ROOTS) {
      fireEvent.press(screen.getByTestId(tab))

      await waitFor(() => expect(backs()).toHaveLength(0))
      expect(nativeHeaders()).toHaveLength(0)
    }
  })
})

/**
 * One level in: still one back, and it names the page it returns to.
 *
 * Both of these are pages INSIDE a tab rather than over it, so the tab bar stays
 * and the back is the page's own.
 */
describe('a page inside a tab', () => {
  it('opens a cron from the Crons tab with one back, labelled Crons', async () => {
    renderScreen(<CompactShell initial={{ section: 'cron' }} />)

    await waitFor(() => expect(screen.getByTestId('cron-row-job-scan-researcher')).toBeTruthy())
    fireEvent.press(screen.getByTestId('cron-row-job-scan-researcher'))

    await waitFor(() => expect(screen.getByTestId('cron-detail-summary')).toBeTruthy())

    const controls = backs()

    expect(controls).toHaveLength(1)
    expect(controls[0]?.props.accessibilityLabel).toBe(strings.tabs.routines)
    expect(nativeHeaders()).toHaveLength(0)
    // Still inside the tab, so the bar is still under it.
    expect(screen.getByTestId('tab-bar')).toBeTruthy()
  })

  it('opens a Settings category with one back, labelled Settings', async () => {
    renderScreen(<CompactShell initial={{ section: 'settings' }} />)

    await waitFor(() => expect(screen.getByTestId('settings-cat-Appearance')).toBeTruthy())
    fireEvent.press(screen.getByTestId('settings-cat-Appearance'))

    await waitFor(() => expect(screen.getByTestId('settings-page-Appearance')).toBeTruthy())

    const controls = backs()

    expect(controls).toHaveLength(1)
    expect(controls[0]?.props.accessibilityLabel).toBe(SETTINGS_ROUTES.Root.title())
    expect(nativeHeaders()).toHaveLength(0)
    expect(screen.getByTestId('tab-bar')).toBeTruthy()
  })
})

/**
 * The pages pushed OVER the tabs.
 *
 * A chat, and the two pages a chat leads to. Each is above the tab bar rather
 * than inside a tab — the transcript takes the whole window, as it always has —
 * and each one's back is derived from the route underneath rather than typed,
 * which is what stops it naming a page the reader was never on.
 */
describe('a page pushed over the tabs', () => {
  it('gives the chat the window, with no tab bar and no native header', async () => {
    renderScreen(<CompactShell />)

    await waitFor(() => expect(screen.getByTestId('bot-row-researcher')).toBeTruthy())
    fireEvent.press(screen.getByTestId('bot-row-researcher'))

    await waitFor(() => expect(screen.getByTestId('chat-header-options')).toBeTruthy())

    expect(screen.queryByTestId('tab-bar')).toBeNull()
    expect(nativeHeaders()).toHaveLength(0)
  })

  it('names a conversation’s back after the tab it was opened from', async () => {
    renderScreen(<CompactShell />)

    await waitFor(() => expect(screen.getByTestId('tab-chats')).toBeTruthy())

    // The notification path: `PushSync` asks through the bus, which is the one
    // entry point that reaches a branch without a chat underneath it.
    act(() => requestOpenChat('researcher', 'stored-branch'))

    await waitFor(() => expect(screen.getByTestId('conversation-view')).toBeTruthy())

    const controls = backs()

    expect(controls).toHaveLength(1)
    expect(controls[0]?.props.accessibilityLabel).toBe(strings.tabs.chats)
    expect(nativeHeaders()).toHaveLength(0)
  })

  /**
   * HERM-101's worst case: a page whose back used to name a list the reader had
   * never opened. A cron card in a transcript is reached FROM a chat, so the
   * only true label is that chat's own name.
   */
  it('sends a cron card to its cron, with a back to the chat it came from', async () => {
    seedChat()
    renderScreen(<CompactShell initial={{ bot: 'researcher' }} />)

    fireEvent.press(screen.getByTestId('cron-delivery-c:1-toggle'))
    fireEvent.press(screen.getByTestId('cron-delivery-c:1-open'))

    await waitFor(() => expect(screen.getByTestId('cron-detail-summary')).toBeTruthy())

    const controls = backs()

    expect(controls).toHaveLength(1)
    expect(controls[0]?.props.accessibilityLabel).toBe('Researcher')
    expect(nativeHeaders()).toHaveLength(0)
    // Over the chat, not in the Crons tab: no bar, and no list to fall onto.
    expect(screen.queryByTestId('tab-bar')).toBeNull()
    expect(screen.queryByTestId('cron-list')).toBeNull()

    fireEvent.press(controls[0] as never)

    await waitFor(() => expect(screen.getByTestId('cron-delivery-c:1-body')).toBeTruthy())
  })
})

/**
 * The launch argument that made the old root back a lie.
 *
 * `--hermieOpen overlay:settings` opened Settings as the bottom of the stack,
 * where the shell's `rootBack` called `goBack()` on a stack with nothing under
 * it: a button that said Chats and did nothing. Worse, `PageChrome` registers
 * Android's back off that same handler, so the press was swallowed by a control
 * that could not act on it and the reader could not leave the app.
 */
describe('Settings as the launch destination', () => {
  it('draws no back control at all', async () => {
    renderScreen(<CompactShell initial={{ section: 'settings' }} />)

    await waitFor(() => expect(screen.getByTestId('settings-page-Root')).toBeTruthy())

    expect(backs()).toHaveLength(0)
    expect(within(screen.getByTestId('settings-page-Root')).queryByTestId('page-back')).toBeNull()
  })

  it('lets Android’s back reach the OS instead of swallowing it', async () => {
    renderScreen(<CompactShell initial={{ section: 'settings' }} />)

    await waitFor(() => expect(screen.getByTestId('settings-page-Root')).toBeTruthy())

    // Nobody claims it: the tab is the one the app opened on, so its history is
    // one entry deep and `canGoBack()` is false all the way up.
    expect(pressAndroidBack()).toBe(false)
  })

  it('still walks one level per press once a page is open', async () => {
    renderScreen(<CompactShell initial={{ section: 'settings' }} />)

    await waitFor(() => expect(screen.getByTestId('settings-cat-Appearance')).toBeTruthy())
    fireEvent.press(screen.getByTestId('settings-cat-Appearance'))

    await waitFor(() => expect(screen.getByTestId('settings-page-Appearance')).toBeTruthy())

    // The page's own chrome takes this one, and returns to the category list.
    let claimed = false

    act(() => {
      claimed = pressAndroidBack()
    })

    expect(claimed).toBe(true)
    await waitFor(() => expect(screen.getByTestId('settings-page-Root')).toBeTruthy())
  })
})
