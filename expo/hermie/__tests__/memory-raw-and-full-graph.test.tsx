/**
 * The two things the owner asked the memory page for after testing it.
 *
 * "I also want to see what is in its memory itself and what is at mem0" — the
 * Raw tab, which is a route of its own because the four the plugin has all
 * answer a PARSED memory. An entry list is what you edit; it is not what is in
 * the file, and for an external provider it is not anything at all.
 *
 * "And I want to see the memory graph full-screen" — the card on the page is a
 * square the width of a settings column, so a drawing laid out in 640 units
 * arrives at about half size on a phone before anybody has pinched it.
 *
 * The cases that matter are the ones where there is nothing to show, because
 * those are where a page lies: a backend that is configured and cannot list
 * what it holds, a backend the gateway does not have, and a plugin older than
 * the route are three different answers and none of them is an empty tab.
 */
import { GatewayError } from '@hermie/gateway-client'
import { PLUGIN_CAPABILITIES } from '@hermie/gateway-client/plugin'
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native'

import { MemoryScreen, memoryRawOf } from '../src/features/memory'
import { memoryStrings } from '../src/features/memory/strings'
import { useMemoryStore } from '../src/store/memory'
import { usePluginStore } from '../src/store/plugin'
import { renderScreen } from './support/render'

/** Escape, delivered the way the native keyboard seam delivers it. */
const mockEscapeListeners = new Set<() => void>()

jest.mock('../src/platform/keyboard-modifiers', () => ({
  isShiftDown: jest.fn(() => false),
  hasHardwareKeyboard: jest.fn(() => false),
  subscribeToEscape: (handler: () => void) => {
    mockEscapeListeners.add(handler)

    return () => mockEscapeListeners.delete(handler)
  }
}))

/** `MEMORY.md` as the store writes it: entries joined by its own delimiter. */
const MEMORY_FILE = 'Max signs off on invoices.\n§\nPrefers footnotes.'
const USER_FILE = 'Works from Utrecht.'

/** The route's answer, in the shape specified in `memory-controller.ts`. */
function rawAnswer(): Record<string, unknown> {
  return {
    profile: 'researcher',
    backends: [
      {
        name: 'builtin',
        label: 'MEMORY.md and USER.md',
        available: true,
        editable: true,
        note: null,
        documents: [
          { id: 'memory', label: 'MEMORY.md', content: MEMORY_FILE, chars: MEMORY_FILE.length, truncated: false },
          { id: 'user', label: 'USER.md', content: USER_FILE, chars: USER_FILE.length, truncated: false }
        ]
      },
      {
        name: 'mem0',
        label: 'mem0 (cloud)',
        available: true,
        editable: false,
        documents: [],
        note: 'mem0 answers a query and offers no call that lists what it holds.'
      },
      {
        name: 'zep',
        label: 'Zep',
        available: false,
        editable: false,
        documents: [],
        note: null
      }
    ]
  }
}

function listing(): Record<string, unknown> {
  return {
    profile: 'researcher',
    targets: [
      {
        target: 'memory',
        entries: [
          { id: 'memory:0', target: 'memory', index: 0, text: 'Max signs off on invoices.', chars: 26, topics: [] }
        ],
        chars: 26,
        limit: 2200,
        percent: 1
      },
      { target: 'user', entries: [], chars: 0, limit: 1375, percent: 0 }
    ],
    providers: []
  }
}

function graphAnswer(): Record<string, unknown> {
  return {
    nodes: [
      { id: 'profile:researcher', type: 'profile', label: 'researcher' },
      { id: 'memory:0', type: 'entry', target: 'memory', label: 'Max signs off on invoices.', chars: 26 },
      { id: 'topic:Max', type: 'topic', label: 'Max' }
    ],
    edges: [
      { from: 'memory:0', to: 'profile:researcher', type: 'in_profile' },
      { from: 'memory:0', to: 'topic:Max', type: 'mentions' }
    ],
    page: { offset: 0, limit: 100, returned: 1, total: 1, hasMore: false },
    truncated: false
  }
}

const calls: string[] = []
/** Thrown instead of answering `/raw`, for the older-plugin case. */
let rawFailure: { status: number } | null = null

const http = {
  get: jest.fn(async (path: string) => {
    calls.push(path)

    if (path.includes('/raw')) {
      if (rawFailure) {
        // A real `GatewayError`, because that is what carries a status through
        // `asRouteError` — a bare Error with a `status` property does not, and a
        // test that faked one would be testing a path production never takes.
        throw new GatewayError('protocol', `The gateway has no GET ${path} endpoint.`, { status: rawFailure.status })
      }

      return rawAnswer()
    }

    return path.includes('/graph') ? graphAnswer() : listing()
  }),
  post: jest.fn()
}

jest.mock('../src/gateway', () => {
  const frozen = { http: null as unknown }

  return { useGateway: () => frozen, __setHttp: (value: unknown) => (frozen.http = value) }
})

beforeEach(() => {
  calls.length = 0
  rawFailure = null
  useMemoryStore.getState().reset()
  usePluginStore.getState().reset()
  ;(jest.requireMock('../src/gateway') as { __setHttp: (value: unknown) => void }).__setHttp(http)
  usePluginStore.getState().apply({
    version: '0.5.0',
    capabilities: [PLUGIN_CAPABILITIES.memoryBrowse, PLUGIN_CAPABILITIES.memoryEdit],
    modules: { memory: 'on' },
    limits: {},
    updatedAt: 1
  })
})

async function open(): Promise<void> {
  renderScreen(<MemoryScreen onClose={() => undefined} profile="researcher" title="Researcher" />)
  await act(async () => undefined)
  await waitFor(() => expect(screen.getByTestId('memory-tab-raw')).toBeTruthy())
}

describe('reading the raw answer', () => {
  it('keeps every backend and every document', () => {
    const raw = memoryRawOf(rawAnswer())

    expect(raw.profile).toBe('researcher')
    expect(raw.backends.map(backend => backend.name)).toEqual(['builtin', 'mem0', 'zep'])
    expect(raw.backends[0]?.documents.map(document => document.id)).toEqual(['memory', 'user'])
    expect(raw.backends[0]?.documents[0]?.content).toBe(MEMORY_FILE)
  })

  /** Three states that a looser reader would flatten into one empty tab. */
  it('keeps unavailable, unlistable and empty apart', () => {
    const raw = memoryRawOf(rawAnswer())

    expect(raw.backends[1]?.available).toBe(true)
    expect(raw.backends[1]?.documents).toEqual([])
    expect(raw.backends[1]?.note).toContain('no call that lists')
    expect(raw.backends[2]?.available).toBe(false)
  })

  it('drops a row it cannot read rather than inventing a name for it', () => {
    const raw = memoryRawOf({ backends: [{ label: 'nameless' }, 'not an object', { name: 'ok', documents: [] }] })

    expect(raw.backends.map(backend => backend.name)).toEqual(['ok'])
  })

  it('survives a body that is not an answer at all', () => {
    expect(memoryRawOf(null).backends).toEqual([])
    expect(memoryRawOf({ backends: 'nope' }).backends).toEqual([])
  })

  /** A file that exists and is bare is not the same as a missing document. */
  it('counts an empty document as a document', () => {
    const raw = memoryRawOf({
      backends: [{ name: 'builtin', documents: [{ id: 'user', label: 'USER.md', content: '' }] }]
    })

    expect(raw.backends[0]?.documents).toHaveLength(1)
    expect(raw.backends[0]?.documents[0]?.chars).toBe(0)
  })
})

describe('the Raw tab', () => {
  /** A third read of the same files; only a reader who opened it pays for it. */
  it('does not ask until the tab is opened, then asks for this profile', async () => {
    await open()

    expect(calls.some(path => path.includes('/raw'))).toBe(false)

    fireEvent.press(screen.getByTestId('memory-tab-raw'))

    await waitFor(() => expect(calls.some(path => path.includes('/raw'))).toBe(true))
    expect(calls.find(path => path.includes('/raw'))).toBe('/api/plugins/hermie/memory/raw?profile=researcher')
  })

  it('shows each built-in file as stored, delimiters and all', async () => {
    await open()
    fireEvent.press(screen.getByTestId('memory-tab-raw'))

    await waitFor(() => expect(screen.getByTestId('memory-raw-builtin-memory')).toBeTruthy())

    // The delimiter is IN the text. That is the whole difference between this
    // tab and the entry list, which splits on it and throws it away.
    expect(screen.getByTestId('memory-raw-builtin-memory')).toHaveTextContent(/§/u)
    expect(screen.getByTestId('memory-raw-builtin-user')).toHaveTextContent(/Works from Utrecht/u)
  })

  it('says why a provider that cannot list has nothing under it', async () => {
    await open()
    fireEvent.press(screen.getByTestId('memory-tab-raw'))

    await waitFor(() => expect(screen.getByTestId('memory-raw-mem0-note')).toBeTruthy())

    // The gateway's own sentence, not ours: it knows which provider it is.
    expect(screen.getByTestId('memory-raw-mem0-note')).toHaveTextContent(/no call that lists/u)
  })

  it('says plainly when a backend is not on this gateway', async () => {
    await open()
    fireEvent.press(screen.getByTestId('memory-tab-raw'))

    await waitFor(() => expect(screen.getByTestId('memory-raw-zep-unavailable')).toBeTruthy())
    expect(screen.getByTestId('memory-raw-zep-unavailable')).toHaveTextContent(memoryStrings.raw.unavailable)
  })

  it('is read-only and says so once, rather than per document', async () => {
    await open()
    fireEvent.press(screen.getByTestId('memory-tab-raw'))

    await waitFor(() => expect(screen.getByTestId('memory-raw-read-only')).toBeTruthy())
    expect(screen.getAllByTestId('memory-raw-read-only')).toHaveLength(1)
  })

  /**
   * An older plugin is a plugin with one fewer route, not a failure. The rest of
   * the page keeps working, so the tab says which command grows the route.
   */
  it('offers the update when the plugin does not serve the route', async () => {
    rawFailure = { status: 404 }

    await open()
    fireEvent.press(screen.getByTestId('memory-tab-raw'))

    await waitFor(() => expect(screen.getByTestId('memory-raw-missing')).toBeTruthy())
    expect(screen.getByTestId('memory-raw-missing-command')).toHaveTextContent(memoryStrings.raw.missingCommand)

    // And NOT the generic "no backends" sentence, which would be a claim about
    // a gateway that was never asked.
    expect(screen.queryByTestId('memory-raw-none')).toBeNull()
  })
})

describe('the graph, full screen', () => {
  async function openGraph(): Promise<void> {
    await open()
    fireEvent.press(screen.getByTestId('memory-tab-graph'))
    await waitFor(() => expect(screen.getByTestId('memory-graph')).toBeTruthy())
  }

  it('is not up until the card’s button asks for it', async () => {
    await openGraph()

    expect(screen.queryByTestId('memory-graph-full')).toBeNull()
    expect(screen.getByTestId('memory-graph-open-full')).toBeTruthy()
  })

  it('draws the same graph with the window to itself', async () => {
    await openGraph()

    fireEvent.press(screen.getByTestId('memory-graph-open-full'))

    await waitFor(() => expect(screen.getByTestId('memory-graph-full')).toBeTruthy())
    for (const id of ['profile:researcher', 'memory:0', 'topic:Max']) {
      expect(screen.getByTestId(`memory-graph-full-view-node-${id}`)).toBeTruthy()
    }
  })

  it('keeps the zoom controls, which are somebody’s only way in', async () => {
    await openGraph()
    fireEvent.press(screen.getByTestId('memory-graph-open-full'))

    await waitFor(() => expect(screen.getByTestId('memory-graph-full-view-zoom-in')).toBeTruthy())
    expect(screen.getByTestId('memory-graph-full-view-zoom-out')).toBeTruthy()
    expect(screen.getByTestId('memory-graph-full-view-reset')).toBeTruthy()
  })

  it('selects a node and shows its detail beside the picture', async () => {
    await openGraph()
    fireEvent.press(screen.getByTestId('memory-graph-open-full'))
    await waitFor(() => expect(screen.getByTestId('memory-graph-full-view-node-memory:0')).toBeTruthy())

    fireEvent.press(screen.getByTestId('memory-graph-full-view-node-memory:0'))

    await waitFor(() => expect(screen.getByTestId('memory-graph-full-detail')).toBeTruthy())
    expect(screen.getByTestId('memory-graph-full-detail-text')).toHaveTextContent('Max signs off on invoices.')
  })

  /**
   * The ordering that is not obvious and is the whole reason the page's own
   * handlers are scoped.
   *
   * `useEscapeKey` delivers to whoever registered LAST and effects flush
   * child-first, so the full-screen view — mounted below the screen — registers
   * FIRST and would lose the key to the screen's own "close the page" handler.
   * One press would then have closed the whole memory page and left the
   * picture's own state behind it.
   */
  it('gives Escape to the picture, not to the page under it', async () => {
    const onClose = jest.fn()

    renderScreen(<MemoryScreen onClose={onClose} profile="researcher" title="Researcher" />)
    await act(async () => undefined)
    await waitFor(() => expect(screen.getByTestId('memory-tab-graph')).toBeTruthy())

    fireEvent.press(screen.getByTestId('memory-tab-graph'))
    await waitFor(() => expect(screen.getByTestId('memory-graph')).toBeTruthy())
    fireEvent.press(screen.getByTestId('memory-graph-open-full'))
    await waitFor(() => expect(screen.getByTestId('memory-graph-full')).toBeTruthy())

    act(() => {
      for (const listener of [...mockEscapeListeners]) {
        listener()
      }
    })

    await waitFor(() => expect(screen.queryByTestId('memory-graph-full')).toBeNull())
    expect(onClose).not.toHaveBeenCalled()

    // And the key goes back to the page once the picture has gone.
    act(() => {
      for (const listener of [...mockEscapeListeners]) {
        listener()
      }
    })

    expect(onClose).toHaveBeenCalled()
  })

  it('closes on its own control and leaves the page where it was', async () => {
    await openGraph()
    fireEvent.press(screen.getByTestId('memory-graph-open-full'))
    await waitFor(() => expect(screen.getByTestId('memory-graph-full')).toBeTruthy())

    fireEvent.press(screen.getByTestId('memory-graph-full-close'))

    await waitFor(() => expect(screen.queryByTestId('memory-graph-full')).toBeNull())
    expect(screen.getByTestId('memory-graph')).toBeTruthy()
  })
})
