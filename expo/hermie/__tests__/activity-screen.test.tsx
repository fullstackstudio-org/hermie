/**
 * The Activity screen.
 *
 * The stores and the `@hermie/transcript` projection are real here; only the
 * controller is a stand-in, because everything past it is a socket. What these
 * assertions check is therefore the screen's own job: transcripts the store
 * already holds become timeline rows, the three counters come from the three
 * calls they are supposed to come from, and a tap carries the item id that lets
 * the chat land on the right message.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { StyleSheet } from 'react-native'

import { ActivityScreen } from '../src/features/activity'
import { type Bot, useBotsStore } from '../src/store/bots'
import { useChatsStore } from '../src/store/chats'
import { type Theme, useTheme } from '../src/ui/theme'
import { renderScreen, withProviders } from './support/render'

/** The theme the provider actually resolved — see `chat-header-pill.test.tsx`. */
let seenTheme: Theme | undefined

function ThemeProbe() {
  seenTheme = useTheme()

  return null
}

let mockController: Record<string, jest.Mock>
let mockBots: Record<string, jest.Mock>

const gateway = { status: 'ready' as string }

jest.mock('../src/gateway', () => ({
  useGateway: () => gateway
}))

jest.mock('../src/features/chats/ChatRuntime', () => ({
  useChatRuntime: () => ({ controller: mockController, bots: mockBots })
}))

const bot = (name: string, displayName: string): Bot => ({
  name,
  displayName,
  description: '',
  model: 'example-provider/example-model',
  provider: 'example-provider',
  isDefault: false,
  hasAvatar: false,
  uiMetaRevision: 0,
  canonical: { id: `stored-${name}`, resolvedId: `stored-${name}`, preview: '', lastActive: 1, messageCount: 2 }
})

const RESEARCHER = bot('researcher', 'Researcher')
const WRITER = bot('writer', 'Writer')

/** Researcher dispatches a DM to writer and delegates two tasks. */
function seed() {
  useBotsStore.getState().reset()
  useChatsStore.getState().reset()
  useBotsStore.getState().setBots([RESEARCHER, WRITER])

  const chats = useChatsStore.getState()

  chats.ensure('researcher', { storedSessionId: 'stored-researcher', resolvedSessionId: 'stored-researcher' })
  chats.bindRuntime('researcher', 'runtime-r')

  chats.dispatchEvent('researcher', {
    type: 'tool.start',
    session_id: 'runtime-r',
    payload: {
      tool_id: 'call_dm_1',
      name: 'message_agent',
      args: { target: '@writer', message: 'Can you draft the announcement?' }
    }
  })
  chats.dispatchEvent('researcher', {
    type: 'tool.complete',
    session_id: 'runtime-r',
    payload: {
      tool_id: 'call_dm_1',
      name: 'message_agent',
      result: { status: 'queued', delivery_id: 'dlv-1', to: 'writer', process_id: 'proc-1' }
    }
  })

  for (const [index, goal] of ['Audit deps', 'Write tests'].entries()) {
    chats.dispatchEvent('researcher', {
      type: 'subagent.start',
      session_id: 'runtime-r',
      payload: {
        subagent_id: `child-${index}`,
        delegation_id: 'del-1',
        goal,
        task_index: index,
        task_count: 2,
        status: 'running'
      }
    })
  }
}

beforeEach(() => {
  mockController = {
    loadActivity: jest.fn(async () => undefined),
    activeSubagentCount: jest.fn(async () => 2),
    inFlightDeliveries: jest.fn(async () => 1)
  }
  mockBots = { watchRunning: jest.fn(() => () => undefined) }
  gateway.status = 'ready'
  seed()
})

describe('ActivityScreen', () => {
  it('runs the background load so bots nobody opened still appear', async () => {
    renderScreen(<ActivityScreen />)

    await waitFor(() => expect(mockController.loadActivity).toHaveBeenCalled())
  })

  it('renders a dispatch, its delegation and their status', async () => {
    renderScreen(<ActivityScreen />)

    await waitFor(() => expect(screen.getByText('Researcher → Writer')).toBeTruthy())
    expect(screen.getByText('Can you draft the announcement?')).toBeTruthy()
    expect(screen.getByText('Researcher spawned 2 agents')).toBeTruthy()
  })

  it('shows a reply as its own row once the delivery reports back', async () => {
    act(() => {
      useChatsStore.getState().dispatchEvent('researcher', {
        type: 'message.complete',
        session_id: 'runtime-r',
        payload: { text: 'Asked the writer.', status: 'ok' }
      })
      useChatsStore.getState().update('researcher', state => {
        const id = state.byProcessId['proc-1']!
        const item = state.items[id]!

        return {
          ...state,
          items: {
            ...state.items,
            [id]: { ...item, reply: { text: 'Draft is ready.' }, version: item.version + 1 }
          }
        }
      })
    })

    renderScreen(<ActivityScreen />)

    // The variation selector is part of the string: without it iOS renders the
    // arrow as an emoji (see `docs/platform-notes.md`).
    await waitFor(() => expect(screen.getByText('Writer \u21a9\ufe0e Researcher')).toBeTruthy())
    expect(screen.getByText('Draft is ready.')).toBeTruthy()
  })

  it('counts bots working, live sub-agents and deliveries in flight', async () => {
    act(() => {
      useBotsStore.getState().setRunning(['researcher'])
    })

    renderScreen(<ActivityScreen />)

    await waitFor(() => expect(screen.getByTestId('activity-count-subagents')).toHaveTextContent('2'))
    expect(screen.getByTestId('activity-count-working')).toHaveTextContent('1')
    expect(screen.getByTestId('activity-count-deliveries')).toHaveTextContent('1')
    expect(mockController.activeSubagentCount).toHaveBeenCalled()
    expect(mockController.inFlightDeliveries).toHaveBeenCalled()
  })

  it('opens the chat a row came from, carrying the item to scroll to', async () => {
    const onOpenBot = jest.fn()

    renderScreen(<ActivityScreen onOpenBot={onOpenBot} />)

    await waitFor(() => expect(screen.getByText('Researcher → Writer')).toBeTruthy())
    fireEvent.press(screen.getByTestId('activity-row-researcher:t:call_dm_1'))

    expect(onOpenBot).toHaveBeenCalledWith('researcher', { focusItemId: 't:call_dm_1' })
  })

  it('says so when nothing has happened yet rather than showing an empty list', async () => {
    act(() => {
      useChatsStore.getState().reset()
    })

    renderScreen(<ActivityScreen />)

    await waitFor(() => expect(screen.getByTestId('activity-empty')).toBeTruthy())
  })
})

/**
 * HERM-105: the tab root's own chrome. A root has nowhere to go back to —
 * both shells mount this as one of their tabs — so it takes no `back` and
 * `PageChrome` draws no back control at all rather than a special case per
 * shell.
 */
describe('ActivityScreen — the root has no back control', () => {
  it('renders no page-back when back is not given', async () => {
    renderScreen(<ActivityScreen />)

    await waitFor(() => expect(screen.getByText('Researcher → Writer')).toBeTruthy())
    expect(screen.queryByTestId('page-back')).toBeNull()
  })
})

/**
 * HERM-105's other half: the sticky "TODAY" section header used to paint a
 * flat `elevation.e1` fill — the one thing on the screen at that depth — which
 * read as an opaque band. It is a `GlassSurface` at the page's own `panel`
 * material now, so it carries no `elevation.e1` background at all.
 */
describe('ActivityScreen — the sticky section header is glass, not a band', () => {
  it('paints no flat elevation.e1 fill behind "Today"', async () => {
    render(
      withProviders(
        <>
          <ThemeProbe />
          <ActivityScreen />
        </>
      )
    )

    await waitFor(() => expect(screen.getByText('Researcher → Writer')).toBeTruthy())

    const headers = screen.getAllByTestId('activity-section-header')

    expect(headers.length).toBeGreaterThan(0)
    expect(seenTheme).toBeDefined()

    for (const header of headers) {
      const flat = StyleSheet.flatten(header.props.style)

      expect(flat.backgroundColor).not.toBe(seenTheme?.elevation.e1)
    }
  })
})

/**
 * The race this screen lost on every launch that opened it first.
 *
 * A `GatewayConnection` — and therefore the whole chat runtime — exists from the
 * moment a gateway is CONFIGURED, long before its socket is up. The background
 * load used to run on mount regardless, the roster read under it failed with
 * "gateway not connected", `loadActivity` swallows a failed roster as "no bots",
 * and the timeline settled on the empty state for good, because nothing asked
 * again. On a simulator opened straight onto `overlay:activity` that happened
 * every single time, and every row here passed while it did.
 */
describe('the background load and the connection', () => {
  it('does not read anything while the socket is still dialling', async () => {
    gateway.status = 'connecting'

    act(() => {
      useChatsStore.getState().reset()
    })
    renderScreen(<ActivityScreen />)

    // Still "reading", because the connection is still on its way: a dialling
    // socket is not a verdict about what the bots have said.
    await waitFor(() => expect(screen.getByTestId('activity-empty')).toHaveTextContent(/Reading/u))
    expect(mockController.loadActivity).not.toHaveBeenCalled()
  })

  it('reads as soon as the connection is ready, and once', async () => {
    gateway.status = 'connecting'

    const view = renderScreen(<ActivityScreen />)

    gateway.status = 'ready'
    view.rerender(withProviders(<ActivityScreen />))

    await waitFor(() => expect(mockController.loadActivity).toHaveBeenCalledTimes(1))

    // …and a re-render while it stays ready does not read the whole roster again.
    view.rerender(withProviders(<ActivityScreen />))
    view.rerender(withProviders(<ActivityScreen />))

    expect(mockController.loadActivity).toHaveBeenCalledTimes(1)
  })

  it('reads again after a reconnect', async () => {
    renderScreen(<ActivityScreen />)

    await waitFor(() => expect(mockController.loadActivity).toHaveBeenCalledTimes(1))

    act(() => {
      gateway.status = 'reconnecting'
    })
    screen.rerender(withProviders(<ActivityScreen />))
    screen.rerender(withProviders(<ActivityScreen />))

    act(() => {
      gateway.status = 'ready'
    })
    screen.rerender(withProviders(<ActivityScreen />))

    await waitFor(() => expect(mockController.loadActivity).toHaveBeenCalledTimes(2))
  })

  /**
   * A connection that has stopped trying must hand the screen back, or the
   * spinner sits on top of the notice that says why there is nothing to show.
   */
  it('stops saying it is reading once the connection has given up', async () => {
    gateway.status = 'disconnected'

    act(() => {
      useChatsStore.getState().reset()
    })
    renderScreen(<ActivityScreen />)

    await waitFor(() => expect(screen.getByTestId('activity-empty')).toHaveTextContent(/out of reach/u))
  })
})
