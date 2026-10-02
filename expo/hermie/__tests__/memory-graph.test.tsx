/**
 * The memory graph: the layout, and the tab around it.
 *
 * The determinism assertions are the point of the file. A force-directed layout
 * is iterative and is normally seeded from `Math.random`, which would draw the
 * same memory differently on every open — and because a write refetches, that
 * means after every edit too. Somebody who has learned where their cluster sits
 * would have to find it again each time, which is not a cosmetic cost.
 *
 * So: same input, same coordinates, twice in a row and across two freshly built
 * graphs with the same content. The generator is `mulberry32` rather than the
 * engine's own, so this is a claim about every platform and not only about the
 * one running the suite.
 */
import { PLUGIN_CAPABILITIES } from '@hermie/gateway-client/plugin'
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native'

import { layoutMemoryGraph, MemoryScreen, memoryGraphOf, topicsOf } from '../src/features/memory'
import { useMemoryStore } from '../src/store/memory'
import { usePluginStore } from '../src/store/plugin'
import { renderScreen } from './support/render'

/**
 * One page of a graph, in the plugin's own shape.
 *
 * Two entries sharing the topic `Max`, one entry with a topic of its own, the
 * profile hub, and every edge kind the plugin mints.
 */
function fixture(): Record<string, unknown> {
  return {
    nodes: [
      { id: 'profile:researcher', type: 'profile', label: 'researcher' },
      { id: 'memory:0', type: 'entry', target: 'memory', label: 'Max signs off on invoices.', chars: 26 },
      { id: 'memory:1', type: 'entry', target: 'memory', label: 'Max is away until 2026-10-01.', chars: 29 },
      { id: 'user:0', type: 'entry', target: 'user', label: 'Reads Dutch and English.', chars: 24 },
      { id: 'topic:Max', type: 'topic', label: 'Max' },
      { id: 'topic:Dutch', type: 'topic', label: 'Dutch' }
    ],
    edges: [
      { from: 'memory:0', to: 'profile:researcher', type: 'in_profile' },
      { from: 'memory:1', to: 'profile:researcher', type: 'in_profile' },
      { from: 'user:0', to: 'profile:researcher', type: 'in_profile' },
      { from: 'memory:0', to: 'topic:Max', type: 'mentions' },
      { from: 'memory:1', to: 'topic:Max', type: 'mentions' },
      { from: 'user:0', to: 'topic:Dutch', type: 'mentions' },
      { from: 'memory:0', to: 'memory:1', type: 'shares_topic', topic: 'Max' }
    ],
    page: { offset: 0, limit: 100, returned: 3, total: 3, hasMore: false },
    truncated: false
  }
}

// -- the reader --------------------------------------------------------------

describe('reading the answer', () => {
  it('keeps every node and edge the fixture carries', () => {
    const graph = memoryGraphOf(fixture())

    expect(graph.nodes).toHaveLength(6)
    expect(graph.edges).toHaveLength(7)
    expect(graph.nodes.filter(node => node.type === 'entry')).toHaveLength(3)
    expect(graph.nodes.filter(node => node.type === 'topic')).toHaveLength(2)
  })

  /** An edge into a node that was never sent is an edge nothing can draw. */
  it('drops an edge naming a node the answer did not carry', () => {
    const body = fixture()

    ;(body.edges as unknown[]).push({ from: 'memory:0', to: 'memory:99', type: 'shares_topic', topic: 'Ghost' })

    expect(memoryGraphOf(body).edges).toHaveLength(7)
  })

  it('drops a node kind this build does not know rather than drawing it as something else', () => {
    const body = fixture()

    ;(body.nodes as unknown[]).push({ id: 'cluster:1', type: 'cluster', label: 'Later' })

    expect(memoryGraphOf(body).nodes.map(node => node.id)).not.toContain('cluster:1')
  })

  it('reads an entry’s topics off the edges', () => {
    const graph = memoryGraphOf(fixture())

    expect(topicsOf(graph, 'memory:0')).toEqual(['Max'])
    expect(topicsOf(graph, 'profile:researcher')).toEqual([])
  })
})

// -- the layout --------------------------------------------------------------

describe('the layout', () => {
  it('places every node it was given, and every edge between them', () => {
    const layout = layoutMemoryGraph(memoryGraphOf(fixture()))

    expect(layout.nodes).toHaveLength(6)
    expect(layout.edges).toHaveLength(7)
    expect(layout.dropped).toBe(0)
  })

  /** Same input, same picture — on this run and on the next one. */
  it('is deterministic', () => {
    const first = layoutMemoryGraph(memoryGraphOf(fixture()))
    const second = layoutMemoryGraph(memoryGraphOf(fixture()))

    expect(second.nodes.map(node => [node.id, node.x, node.y])).toEqual(
      first.nodes.map(node => [node.id, node.x, node.y])
    )
  })

  /** The hub is connected to everything; free, it drifts to wherever the mass is. */
  it('pins the profile node at the centre', () => {
    const layout = layoutMemoryGraph(memoryGraphOf(fixture()), { size: 600 })
    const hub = layout.nodes.find(node => node.type === 'profile')

    expect([hub?.x, hub?.y]).toEqual([300, 300])
  })

  it('keeps every node inside the frame it was laid out in', () => {
    const layout = layoutMemoryGraph(memoryGraphOf(fixture()), { size: 400 })

    for (const node of layout.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(0)
      expect(node.x).toBeLessThanOrEqual(400)
      expect(node.y).toBeGreaterThanOrEqual(0)
      expect(node.y).toBeLessThanOrEqual(400)
    }
  })

  /** Over the cap, the extra nodes go — and so does every edge that named one. */
  it('drops past its node cap, and takes the dangling edges with it', () => {
    const layout = layoutMemoryGraph(memoryGraphOf(fixture()), { maxNodes: 3 })

    expect(layout.nodes).toHaveLength(3)
    expect(layout.dropped).toBe(3)
    for (const edge of layout.edges) {
      expect(layout.nodes.map(node => node.id)).toContain(edge.from)
      expect(layout.nodes.map(node => node.id)).toContain(edge.to)
    }
  })

  it('answers an empty graph without laying anything out', () => {
    const layout = layoutMemoryGraph({
      nodes: [],
      edges: [],
      page: { offset: 0, limit: 100, returned: 0, total: 0, hasMore: false },
      truncated: false
    })

    expect(layout.nodes).toEqual([])
    expect(layout.edges).toEqual([])
  })
})

// -- the tab -----------------------------------------------------------------

const calls: string[] = []

const http = {
  get: jest.fn(async (path: string) => {
    calls.push(path)

    if (path.includes('/graph')) {
      return fixture()
    }

    return {
      profile: 'researcher',
      targets: [
        {
          target: 'memory',
          entries: [
            {
              id: 'memory:0',
              target: 'memory',
              index: 0,
              text: 'Max signs off on invoices.',
              chars: 26,
              topics: ['Max']
            }
          ],
          chars: 26,
          limit: 2200,
          percent: 1
        },
        { target: 'user', entries: [], chars: 0, limit: 1375, percent: 0 }
      ],
      providers: []
    }
  }),
  post: jest.fn()
}

jest.mock('../src/gateway', () => {
  const frozen = { http: null as unknown }

  return { useGateway: () => frozen, __setHttp: (value: unknown) => (frozen.http = value) }
})

describe('the Graph tab', () => {
  beforeEach(() => {
    calls.length = 0
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
    await waitFor(() => expect(screen.getByTestId('memory-tab-graph')).toBeTruthy())
  }

  /** A second read of the same files; most readers never open it. */
  it('does not fetch the graph until the tab is opened', async () => {
    await open()

    expect(calls.some(path => path.includes('/graph'))).toBe(false)

    fireEvent.press(screen.getByTestId('memory-tab-graph'))

    await waitFor(() => expect(calls.some(path => path.includes('/graph'))).toBe(true))
    expect(calls.find(path => path.includes('/graph'))).toBe('/api/plugins/hermie/memory/graph?profile=researcher')
  })

  it('draws a node per node the answer carried', async () => {
    await open()
    fireEvent.press(screen.getByTestId('memory-tab-graph'))

    await waitFor(() => expect(screen.getByTestId('memory-graph')).toBeTruthy())
    for (const id of ['profile:researcher', 'memory:0', 'memory:1', 'user:0', 'topic:Max', 'topic:Dutch']) {
      expect(screen.getByTestId(`memory-graph-node-${id}`)).toBeTruthy()
    }
  })

  it('opens a detail card on a tap, with the entry’s full text and its topics', async () => {
    await open()
    fireEvent.press(screen.getByTestId('memory-tab-graph'))
    await waitFor(() => expect(screen.getByTestId('memory-graph-node-memory:0')).toBeTruthy())

    fireEvent.press(screen.getByTestId('memory-graph-node-memory:0'))

    await waitFor(() => expect(screen.getByTestId('memory-graph-card')).toBeTruthy())
    expect(screen.getByTestId('memory-graph-card-text')).toHaveTextContent('Max signs off on invoices.')
    expect(screen.getByTestId('memory-graph-card-topics')).toHaveTextContent('Max')
  })

  it('takes a second tap on the same node as closing the card', async () => {
    await open()
    fireEvent.press(screen.getByTestId('memory-tab-graph'))
    await waitFor(() => expect(screen.getByTestId('memory-graph-node-topic:Max')).toBeTruthy())

    fireEvent.press(screen.getByTestId('memory-graph-node-topic:Max'))
    await waitFor(() => expect(screen.getByTestId('memory-graph-card')).toBeTruthy())

    fireEvent.press(screen.getByTestId('memory-graph-node-topic:Max'))
    await waitFor(() => expect(screen.queryByTestId('memory-graph-card')).toBeNull())
  })

  it('goes back to the list when the card says to', async () => {
    await open()
    fireEvent.press(screen.getByTestId('memory-tab-graph'))
    await waitFor(() => expect(screen.getByTestId('memory-graph-node-memory:0')).toBeTruthy())

    fireEvent.press(screen.getByTestId('memory-graph-node-memory:0'))
    await waitFor(() => expect(screen.getByTestId('memory-graph-card-open')).toBeTruthy())

    fireEvent.press(screen.getByTestId('memory-graph-card-open'))

    await waitFor(() => expect(screen.getByTestId('memory-section-memory')).toBeTruthy())
    expect(screen.queryByTestId('memory-graph')).toBeNull()
  })

  /** A topic node has no entry behind it, so there is nothing to open. */
  it('offers no way into the list from a topic node', async () => {
    await open()
    fireEvent.press(screen.getByTestId('memory-tab-graph'))
    await waitFor(() => expect(screen.getByTestId('memory-graph-node-topic:Dutch')).toBeTruthy())

    fireEvent.press(screen.getByTestId('memory-graph-node-topic:Dutch'))

    await waitFor(() => expect(screen.getByTestId('memory-graph-card')).toBeTruthy())
    expect(screen.queryByTestId('memory-graph-card-open')).toBeNull()
  })
})
