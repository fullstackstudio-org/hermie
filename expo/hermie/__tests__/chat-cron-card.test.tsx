/**
 * `Open cron` on a cron card in a transcript.
 *
 * The card carries the job's NAME, and a name is not an identity: two profiles
 * may hold a cron called the same thing, which is why the list wears a profile
 * chip. So `ChatScreen` resolves the name against the crons the store holds,
 * narrowed by this chat's bot — a bot IS a Hermes profile — and offers the action
 * only where that leaves exactly one job. Nothing and two things both mean "do
 * not draw a link", for the same reason: a link that opens the wrong cron is
 * worse than no link.
 *
 * The second half is the route. Resolving produces a job ID, and both shells have
 * to land that ID on `CronScreen`'s `initialJobId` — the phone by pushing a route
 * parameter, the wide window by handing the overlay a piece of state. Those are
 * two different mechanisms for one promise, so both are driven here rather than
 * asserted on the props.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react-native'
import { useWindowDimensions } from 'react-native'

import { CompactShell } from '../src/app/CompactShell'
import { RegularShell } from '../src/app/RegularShell'
import { ChatScreen } from '../src/features/chats/ChatScreen'
import { cronJobFromRow } from '../src/features/cron/model'
import { type Bot, useBotsStore } from '../src/store/bots'
import { useChatLayoutStore } from '../src/store/chat-layout'
import { useChatsStore } from '../src/store/chats'
import { useCronStore } from '../src/store/cron'
import { useSettingsStore } from '../src/store/settings'
import { renderScreen, waitForGone } from './support/render'

const mockHttpGet = jest.fn()
const mockRequest = jest.fn()

// `mock`-prefixed so the factory below may close over it (Jest's hoisting rule).
let mockRuntime: {
  controller: Record<string, jest.Mock>
  bots: Record<string, jest.Mock>
  push: { setOpenChat: jest.Mock }
}

// One frozen gateway object, the way `GatewayProvider` hands one out: a fresh
// object per render would rebuild the cron controller on every paint.
jest.mock('../src/gateway', () => {
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
    hostOf: (url: string) => url.replace(/^https:\/\//u, ''),
    useGateway: () => ({
      config: { authMode: 'session_token', baseUrl: 'https://gateway.example.com' },
      connection,
      http,
      status: 'ready'
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

/** A stored cron job, as `_annotate_cron_job` hands one to the dashboard. */
const storedJob = (overrides: Record<string, unknown>) => ({
  deliver: 'bot-chat:researcher',
  enabled: true,
  last_error: null,
  last_run_at: null,
  last_status: 'ok',
  next_run_at: null,
  prompt: 'Scan the sources.',
  repeat: { times: null, completed: 0 },
  schedule: { kind: 'interval', display: 'every 4h', seconds: 14_400 },
  schedule_display: 'every 4h',
  skills: [],
  state: 'scheduled',
  ...overrides
})

const SCAN_RESEARCHER = storedJob({
  id: 'job-scan-researcher',
  name: 'Source scan',
  profile: 'researcher',
  profile_name: 'researcher'
})

const SCAN_WRITER = storedJob({
  id: 'job-scan-writer',
  name: 'Source scan',
  profile: 'writer',
  profile_name: 'writer'
})

const OTHER = storedJob({ id: 'job-heartbeat', name: 'VM heartbeat', profile: 'default', profile_name: 'default' })

/** What `GET /api/cron/jobs?profile=all` answers with: a bare array. */
function answerJobsWith(jobs: readonly unknown[]): void {
  mockHttpGet.mockImplementation(async (path: string) =>
    path.startsWith('/api/cron/jobs') ? jobs : { targets: [{ id: 'local', name: 'Local (save only)' }] }
  )
}

function makeController() {
  return {
    acknowledgeApproval: jest.fn(async () => undefined),
    closeChat: jest.fn(async () => undefined),
    readKeyFor: (name: string) => name,
    interruptSubagent: jest.fn(async () => true),
    lockClarify: jest.fn(async () => undefined),
    modelOptions: jest.fn(async () => []),
    openChat: jest.fn(async () => undefined),
    refreshOptions: jest.fn(async () => null),
    respondApproval: jest.fn(async () => undefined),
    respondClarify: jest.fn(async () => undefined),
    runSlash: jest.fn(async () => undefined),
    querySlash: jest.fn(async () => []),
    send: jest.fn(async () => undefined),
    setOption: jest.fn(async () => ({})),
    steerSubagent: jest.fn(async () => 'ok'),
    stopTurn: jest.fn(async () => undefined),
    tailSubagent: jest.fn(async () => '')
  }
}

/** Researcher's chat, holding one cron delivery for `jobName`. */
function seedChat(jobName: string) {
  const chats = useChatsStore.getState()

  chats.ensure('researcher', { storedSessionId: 'stored-researcher', resolvedSessionId: 'stored-researcher' })
  chats.update('researcher', state => ({
    ...state,
    items: {
      'c:1': {
        body: 'Three new sources since yesterday.',
        id: 'c:1',
        jobName,
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

/** Put the jobs in the store the way a list read does, without a screen. */
function seedCrons(jobs: readonly ReturnType<typeof storedJob>[]) {
  useCronStore.getState().setJobs(
    jobs.map(job => cronJobFromRow(job)),
    true
  )
}

/** Expand the card, which is where its two actions live. */
function expandCard() {
  fireEvent.press(screen.getByTestId('cron-delivery-c:1-toggle'))
}

beforeEach(() => {
  mockRuntime = {
    bots: { watchRunning: jest.fn(() => () => undefined) },
    controller: makeController(),
    push: { setOpenChat: jest.fn() }
  }
  mockHttpGet.mockReset()
  mockRequest.mockReset()
  mockRequest.mockResolvedValue({ gateway_running: true, jobs: [], success: true })
  answerJobsWith([SCAN_RESEARCHER, OTHER])
  useBotsStore.getState().reset()
  useChatsStore.getState().reset()
  useChatLayoutStore.getState().reset()
  useCronStore.getState().reset()
  useSettingsStore.getState().reset()
  useBotsStore.getState().setBots([bot('researcher', 'Researcher'), bot('writer', 'Writer')])
  mockDimensions.mockReturnValue({ width: 402, height: 874, scale: 3, fontScale: 1 })
})

describe('resolving a card name to one cron', () => {
  it('offers Open cron when the name matches exactly one job, and hands over its ID', () => {
    const onOpenCron = jest.fn()

    seedChat('Source scan')
    seedCrons([SCAN_RESEARCHER, OTHER])
    renderScreen(<ChatScreen bot="researcher" onOpenCron={onOpenCron} />)

    expandCard()
    fireEvent.press(screen.getByTestId('cron-delivery-c:1-open'))

    // The ID, not the name: the name is the ambiguous thing.
    expect(onOpenCron).toHaveBeenCalledWith('job-scan-researcher')
  })

  it('narrows two jobs of the same name by this chat’s bot, which is a profile', () => {
    const onOpenCron = jest.fn()

    seedChat('Source scan')
    seedCrons([SCAN_RESEARCHER, SCAN_WRITER])
    renderScreen(<ChatScreen bot="researcher" onOpenCron={onOpenCron} />)

    expandCard()
    fireEvent.press(screen.getByTestId('cron-delivery-c:1-open'))

    expect(onOpenCron).toHaveBeenCalledWith('job-scan-researcher')
  })

  it('draws no action at all when the name matches nothing', () => {
    seedChat('Source scan')
    seedCrons([OTHER])
    renderScreen(<ChatScreen bot="researcher" onOpenCron={jest.fn()} />)

    expandCard()

    // The card is there and expanded — it is the ACTION that is absent, rather
    // than a link that would open nothing.
    expect(screen.getByTestId('cron-delivery-c:1-body')).toBeTruthy()
    expect(screen.queryByTestId('cron-delivery-c:1-open')).toBeNull()
  })

  it('draws no action when two jobs share the name and neither is this bot’s', () => {
    seedChat('Source scan')
    seedCrons([
      SCAN_WRITER,
      storedJob({ id: 'job-scan-default', name: 'Source scan', profile: 'default', profile_name: 'default' })
    ])
    renderScreen(<ChatScreen bot="researcher" onOpenCron={jest.fn()} />)

    expandCard()

    expect(screen.queryByTestId('cron-delivery-c:1-open')).toBeNull()
  })

  it('draws no action before the crons list has been read at all', () => {
    // The cron controller's lifetime is the Crons screen's, so until somebody
    // has opened it this app genuinely does not know which job a card names.
    seedChat('Source scan')
    renderScreen(<ChatScreen bot="researcher" onOpenCron={jest.fn()} />)

    expandCard()

    expect(screen.queryByTestId('cron-delivery-c:1-open')).toBeNull()
  })

  it('draws no action when the shell cannot get to a cron screen', () => {
    seedChat('Source scan')
    seedCrons([SCAN_RESEARCHER])
    renderScreen(<ChatScreen bot="researcher" />)

    expandCard()

    expect(screen.queryByTestId('cron-delivery-c:1-open')).toBeNull()
  })

  it('answers per CARD, so one resolvable delivery and one ambiguous one differ', () => {
    seedChat('Source scan')
    useChatsStore.getState().update('researcher', state => ({
      ...state,
      items: {
        ...state.items,
        'c:2': {
          body: 'Nothing to report.',
          id: 'c:2',
          jobName: 'Ambiguous scan',
          kind: 'cron_delivery',
          origin: 'history',
          seq: 11,
          shape: 'bot_chat',
          ts: 1_700_000_100,
          version: 0
        }
      },
      order: [...state.order, 'c:2']
    }))
    seedCrons([
      SCAN_RESEARCHER,
      storedJob({ id: 'job-amb-a', name: 'Ambiguous scan', profile: 'writer', profile_name: 'writer' }),
      storedJob({ id: 'job-amb-b', name: 'Ambiguous scan', profile: 'default', profile_name: 'default' })
    ])
    renderScreen(<ChatScreen bot="researcher" onOpenCron={jest.fn()} />)

    expandCard()
    fireEvent.press(screen.getByTestId('cron-delivery-c:2-toggle'))

    expect(screen.getByTestId('cron-delivery-c:1-open')).toBeTruthy()
    expect(screen.queryByTestId('cron-delivery-c:2-open')).toBeNull()
  })
})

/**
 * The route, driven rather than asserted on a prop.
 *
 * Resolving hands the shell a job ID, and the two shells carry it by different
 * means — the phone pushes a route parameter, the wide window sets a piece of
 * state the overlay reads. `initialJobId` is the one promise both make, so both
 * are driven until the detail is on screen.
 */
describe('the route into the cron’s own detail', () => {
  it('lands on the detail from the phone stack', async () => {
    seedChat('Source scan')
    seedCrons([SCAN_RESEARCHER, OTHER])
    renderScreen(<CompactShell initial={{ bot: 'researcher' }} />)

    expandCard()
    fireEvent.press(screen.getByTestId('cron-delivery-c:1-open'))

    // `initialJobId` reached `CronScreen`: the detail, not the list.
    await waitFor(() => expect(screen.getByTestId('cron-detail-summary')).toBeTruthy())
    expect(screen.getByTestId('cron-detail-prompt')).toHaveTextContent('Scan the sources.')
    expect(screen.queryByTestId('cron-list')).toBeNull()
  })

  it('lands on the detail in the overlay on a wide window', async () => {
    mockDimensions.mockReturnValue({ width: 1376, height: 1032, scale: 2, fontScale: 1 })
    seedChat('Source scan')
    seedCrons([SCAN_RESEARCHER, OTHER])
    renderScreen(<RegularShell />)

    fireEvent.press(screen.getByTestId('bot-row-researcher'))
    expandCard()
    fireEvent.press(screen.getByTestId('cron-delivery-c:1-open'))

    await waitFor(() => expect(screen.getByTestId('cron-detail-summary')).toBeTruthy())
    expect(screen.getByTestId('cron-detail-prompt')).toHaveTextContent('Scan the sources.')
    // The overlay is what carries it there, and the sidebar stays beside it.
    expect(screen.getByTestId('overlay-panel')).toBeTruthy()
    expect(screen.getByTestId('bot-row-writer')).toBeTruthy()
  })

  /**
   * And the list the resolving reads really does arrive as a BARE ARRAY.
   *
   * `GET /api/cron/jobs` answers with one — `hermes serve` does, the fake gateway
   * does — and a transport that insisted on an object made this whole path
   * unreachable from any gateway at all. The reader was prepared for it; nothing
   * below the reader was. This drives the real controller, so the array has to
   * survive the trip for the card to get its action.
   */
  it('resolves off a list the controller read as a bare array', async () => {
    seedChat('Source scan')
    mockDimensions.mockReturnValue({ width: 1376, height: 1032, scale: 2, fontScale: 1 })
    renderScreen(<RegularShell />)

    fireEvent.press(screen.getByTestId('bot-row-researcher'))

    // Nothing is in the store yet: the card offers nothing.
    expandCard()
    expect(screen.queryByTestId('cron-delivery-c:1-open')).toBeNull()

    // Opening the Crons panel is what gives the controller a lifetime, and the
    // controller is what reads the array.
    fireEvent.press(screen.getByTestId('tab-cron'))

    await waitFor(() => expect(mockHttpGet).toHaveBeenCalledWith('/api/cron/jobs?profile=all'))
    await waitFor(() => expect(screen.getByTestId('cron-row-job-scan-researcher')).toBeTruthy())

    fireEvent.press(screen.getByTestId('overlay-close'))
    await waitForGone(() => screen.queryByTestId('overlay-panel'), 'overlay-panel')

    await waitFor(() => expect(screen.getByTestId('cron-delivery-c:1-open')).toBeTruthy())
  })
})
