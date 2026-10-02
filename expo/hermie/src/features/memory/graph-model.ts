/**
 * The plugin's `graph` answer, as this app reads it.
 *
 * Three node kinds and three edge kinds, all minted by `memory/browse.py`:
 *
 *  - a **profile** node, one per answer, which every entry hangs off;
 *  - an **entry** node per memory entry ON THIS PAGE, carrying an EXCERPT and
 *    not the full text — a graph is drawn rather than read, and the whole text
 *    is one `list` call away;
 *  - a **topic** node per cheap topic: a capitalised phrase that is not a
 *    sentence opener, an `@handle`, a `#hashtag`, an ISO date.
 *
 * The edges are `in_profile` (entry → profile), `mentions` (entry → topic) and
 * `shares_topic` (entry ↔ entry, once per pair, carrying the topic).
 *
 * ## The page is over entries, not over nodes
 *
 * That is the plugin's decision and it is the one that matters to a reader of
 * this file. A page whose topic nodes happened to fill the node cap would
 * silently drop ENTRIES, and an app paging through would never learn it had
 * missed one. The caps are a last defence; `truncated` says when one bit, and
 * the screen says so out loud rather than drawing a partial picture silently.
 *
 * ## An edge never names a node the answer did not carry
 *
 * The plugin builds entry-to-entry edges inside the page only, for exactly that
 * reason. `memoryGraphOf` re-checks it anyway — an edge whose endpoint is not
 * among the nodes is dropped — because a renderer that trusted it would throw
 * on a gateway one version ahead of this reader.
 */
import type { MemoryTarget } from './model'

export type MemoryGraphNodeKind = 'profile' | 'entry' | 'topic'

export interface MemoryGraphNode {
  id: string
  type: MemoryGraphNodeKind
  /** The profile's name, the topic, or an entry's excerpt. */
  label: string
  /** Entry nodes only. */
  target?: MemoryTarget
  /** Entry nodes only: what the whole entry costs, not the excerpt's length. */
  chars?: number
}

export type MemoryGraphEdgeKind = 'in_profile' | 'mentions' | 'shares_topic'

export interface MemoryGraphEdge {
  from: string
  to: string
  type: MemoryGraphEdgeKind
  /** `shares_topic` only: which topic joined the two entries. */
  topic?: string
}

export interface MemoryGraphPage {
  offset: number
  limit: number
  returned: number
  total: number
  hasMore: boolean
}

export interface MemoryGraph {
  nodes: MemoryGraphNode[]
  edges: MemoryGraphEdge[]
  page: MemoryGraphPage
  /** A node or edge cap bit. The picture is real but not the whole of it. */
  truncated: boolean
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

const NODE_KINDS: MemoryGraphNodeKind[] = ['profile', 'entry', 'topic']
const EDGE_KINDS: MemoryGraphEdgeKind[] = ['in_profile', 'mentions', 'shares_topic']

export function memoryGraphOf(value: unknown): MemoryGraph {
  const body = isObject(value) ? value : {}

  const nodes: MemoryGraphNode[] = (Array.isArray(body.nodes) ? body.nodes : []).flatMap(row => {
    if (!isObject(row) || !str(row.id)) {
      return []
    }

    const kind = NODE_KINDS.find(candidate => candidate === row.type)

    // A node kind this build does not know is dropped whole rather than drawn
    // as something else — the same rule the advert reader follows.
    if (!kind) {
      return []
    }

    return [
      {
        id: str(row.id),
        type: kind,
        label: str(row.label),
        ...(row.target === 'memory' || row.target === 'user' ? { target: row.target } : {}),
        ...(typeof row.chars === 'number' ? { chars: num(row.chars) } : {})
      }
    ]
  })

  const known = new Set(nodes.map(node => node.id))

  const edges: MemoryGraphEdge[] = (Array.isArray(body.edges) ? body.edges : []).flatMap(row => {
    if (!isObject(row)) {
      return []
    }

    const kind = EDGE_KINDS.find(candidate => candidate === row.type)
    const from = str(row.from)
    const to = str(row.to)

    if (!kind || !known.has(from) || !known.has(to)) {
      return []
    }

    return [{ from, to, type: kind, ...(str(row.topic) ? { topic: str(row.topic) } : {}) }]
  })

  const page = isObject(body.page) ? body.page : {}

  return {
    nodes,
    edges,
    page: {
      offset: num(page.offset),
      limit: num(page.limit),
      returned: num(page.returned),
      total: num(page.total),
      hasMore: page.hasMore === true
    },
    truncated: body.truncated === true
  }
}

/** The topics an entry node mentions, off the edges rather than off the text. */
export function topicsOf(graph: MemoryGraph, nodeId: string): string[] {
  const labels = new Map(graph.nodes.map(node => [node.id, node.label]))

  return graph.edges
    .filter(edge => edge.type === 'mentions' && edge.from === nodeId)
    .map(edge => labels.get(edge.to) ?? edge.to)
}
