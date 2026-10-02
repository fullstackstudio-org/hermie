/**
 * A memory graph → coordinates, in one synchronous pass.
 *
 * ## Why it is computed here and not fetched
 *
 * The plugin answers nodes and edges and deliberately no geometry: a layout is
 * a property of the surface it is drawn on, and a phone, a tablet and a browser
 * window are three surfaces. So the same answer is laid out here, the way
 * `markdown/mermaid/layout.ts` lays out a flowchart, and drawn with
 * `react-native-svg` — which is already in the bundle for the icons and the
 * bubble tails. No WebView: ADR-0020 has that decision in full, and a picture
 * that learns its own height one frame late is the same bug here as it is
 * inside a transcript row.
 *
 * ## Deterministic, and why that is not a nice-to-have
 *
 * A force-directed layout is iterative and normally seeded from a random
 * number generator, which means the same memory draws differently every time
 * the tab is opened. That is not a cosmetic problem: somebody who has learned
 * where their `FullStack Studio` cluster sits would have to find it again after
 * every refetch, and after every write, because a write refetches.
 *
 * So the seed is a constant and the generator is `mulberry32` — a pure
 * integer-arithmetic PRNG, so the sequence does not depend on the JavaScript
 * engine's `Math.random`. The iteration count is fixed rather than
 * convergence-based, because "stop when it stops moving" makes the result
 * depend on floating-point accumulation. Same input, same picture, on every
 * platform and every run.
 *
 * The one thing that is NOT a constant is the node order, and it does not need
 * to be: the plugin emits nodes in a stable order (profile, then entries in
 * file order, then each topic the first time an entry needs it), so the *n*-th
 * node gets the *n*-th place on the seeding ring whatever the memory contains.
 *
 * ## The model
 *
 * Fruchterman-Reingold, which is the simplest thing that produces a readable
 * cluster: every pair of nodes repels with `k² / d`, every edge attracts with
 * `d² / k`, and a temperature caps how far a node may move in one pass and
 * cools linearly to zero. The profile node is PINNED at the centre — it is
 * connected to every entry, so leaving it free makes it drift to wherever the
 * mass happens to be and the picture stops reading as "this bot's memory".
 */
import type { MemoryGraph, MemoryGraphEdge, MemoryGraphNode } from './graph-model'

/** Where one node ended up, in diagram units. */
export interface PlacedGraphNode extends MemoryGraphNode {
  x: number
  y: number
  radius: number
}

export interface PlacedGraphEdge extends MemoryGraphEdge {
  from: string
  to: string
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface GraphLayout {
  nodes: PlacedGraphNode[]
  edges: PlacedGraphEdge[]
  /** The drawing's natural size, which is what the `viewBox` is set from. */
  width: number
  height: number
  /** Nodes the CAP dropped, over and above anything the plugin truncated. */
  dropped: number
}

export interface GraphLayoutOptions {
  /** The square the layout is seeded and normalised into, in diagram units. */
  size?: number
  iterations?: number
  seed?: number
  /** Hard ceiling, matching the plugin's own `MAX_NODES`. */
  maxNodes?: number
}

/** The plugin's `MAX_NODES`. A page that reached it already said `truncated`. */
export const GRAPH_MAX_NODES = 400

const DEFAULT_SIZE = 640
const DEFAULT_ITERATIONS = 240

/**
 * Above this many nodes the pass count comes down with the node count.
 *
 * Every pass is O(n²) — the repulsion is every pair — so a fixed 240 passes
 * costs sixteen times as much at 400 nodes as it does at 100. Measured on the
 * development Mac (Node 22, `docs/platform-notes.md` has the table): 25 ms at
 * 150 nodes, 174 ms at 400, and 174 ms is a page that visibly stalls before it
 * paints on a phone, where the same arithmetic is several times slower again.
 *
 * So the passes are scaled by `150 / n`, which makes the total work grow
 * LINEARLY with the node count instead of quadratically. The floor stops the
 * largest graphs from being handed too few passes to settle at all.
 *
 * This is still deterministic, which is the property the whole module is built
 * around: the count is a pure function of how many nodes there are, so the same
 * memory draws the same picture every time. A graph whose node count changes
 * gets a different picture — but it already did, because the layout is over all
 * the nodes at once.
 */
const ADAPTIVE_FROM_NODES = 150
const MIN_ITERATIONS = 60

/** How many passes a graph of `nodes` nodes is laid out with. */
export function iterationsFor(nodes: number): number {
  if (nodes <= ADAPTIVE_FROM_NODES) {
    return DEFAULT_ITERATIONS
  }

  return Math.max(MIN_ITERATIONS, Math.round((DEFAULT_ITERATIONS * ADAPTIVE_FROM_NODES) / nodes))
}

/** Any constant would do; this one is written down so nobody "improves" it. */
const DEFAULT_SEED = 0x9e3779b9

/** Air around the drawing so a circle and its label are never clipped. */
const MARGIN = 28

/** How big each kind of node is drawn. The hub is the largest by a clear step. */
export const NODE_RADIUS: Record<MemoryGraphNode['type'], number> = {
  profile: 20,
  topic: 11,
  entry: 7
}

/**
 * `mulberry32`: 32-bit integer arithmetic only.
 *
 * Deliberately not `Math.random` even with a shuffled seed — that is the
 * engine's generator and two engines need not agree, which would make a test
 * that pins coordinates pass in jest and fail in a browser.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0

  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state

    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Body {
  node: MemoryGraphNode
  x: number
  y: number
  dx: number
  dy: number
  pinned: boolean
}

/**
 * Lay out one page of a memory graph.
 *
 * Nodes past `maxNodes` are dropped from the END of the answer, and every edge
 * naming a dropped node goes with them — a half-drawn edge into empty space is
 * worse than a missing one. `dropped` says how many, so the screen can say so.
 */
export function layoutMemoryGraph(graph: MemoryGraph, options: GraphLayoutOptions = {}): GraphLayout {
  const size = options.size ?? DEFAULT_SIZE
  const maxNodes = options.maxNodes ?? GRAPH_MAX_NODES
  const random = mulberry32(options.seed ?? DEFAULT_SEED)

  const kept = graph.nodes.slice(0, maxNodes)
  const dropped = graph.nodes.length - kept.length
  // After the cap, not before it: what costs the time is what is laid out.
  const iterations = options.iterations ?? iterationsFor(kept.length)

  if (kept.length === 0) {
    return { nodes: [], edges: [], width: size, height: size, dropped }
  }

  const inner = size - MARGIN * 2
  const centre = size / 2

  /*
    Seeding. A ring rather than a scatter, because a force layout started from a
    uniform cloud spends most of its temperature pushing apart nodes that
    happened to land on each other, and the jitter is what keeps two nodes from
    being placed at exactly the same point — where the repulsion has no
    direction to push in.
  */
  const bodies: Body[] = kept.map((node, index) => {
    const angle = (2 * Math.PI * index) / kept.length
    const radius = (inner / 2) * (0.35 + 0.45 * random())

    return {
      node,
      x: centre + Math.cos(angle) * radius,
      y: centre + Math.sin(angle) * radius,
      dx: 0,
      dy: 0,
      pinned: node.type === 'profile'
    }
  })

  const index = new Map(bodies.map(body => [body.node.id, body]))

  for (const body of bodies) {
    if (body.pinned) {
      body.x = centre
      body.y = centre
    }
  }

  const edges = graph.edges.filter(edge => index.has(edge.from) && index.has(edge.to))

  // The ideal edge length: the classic `sqrt(area / n)`.
  const k = Math.sqrt((inner * inner) / bodies.length)
  let temperature = inner / 10

  for (let pass = 0; pass < iterations; pass += 1) {
    for (const body of bodies) {
      body.dx = 0
      body.dy = 0
    }

    for (let first = 0; first < bodies.length; first += 1) {
      for (let second = first + 1; second < bodies.length; second += 1) {
        const a = bodies[first] as Body
        const b = bodies[second] as Body
        let deltaX = a.x - b.x
        let deltaY = a.y - b.y
        let distance = Math.hypot(deltaX, deltaY)

        if (distance < 0.01) {
          // Two nodes on the same point: nudge them apart along a fixed
          // direction rather than a random one, so the run stays reproducible.
          deltaX = 0.01
          deltaY = 0
          distance = 0.01
        }

        const force = (k * k) / distance
        const unitX = (deltaX / distance) * force
        const unitY = (deltaY / distance) * force

        a.dx += unitX
        a.dy += unitY
        b.dx -= unitX
        b.dy -= unitY
      }
    }

    for (const edge of edges) {
      const a = index.get(edge.from) as Body
      const b = index.get(edge.to) as Body
      const deltaX = a.x - b.x
      const deltaY = a.y - b.y
      const distance = Math.max(0.01, Math.hypot(deltaX, deltaY))
      const force = (distance * distance) / k
      const unitX = (deltaX / distance) * force
      const unitY = (deltaY / distance) * force

      a.dx -= unitX
      a.dy -= unitY
      b.dx += unitX
      b.dy += unitY
    }

    for (const body of bodies) {
      if (body.pinned) {
        continue
      }

      const travel = Math.max(0.01, Math.hypot(body.dx, body.dy))
      const step = Math.min(travel, temperature)

      body.x += (body.dx / travel) * step
      body.y += (body.dy / travel) * step
      // Inside the frame, so a node cannot be flung somewhere the viewBox will
      // never show it. The pan and zoom are over the drawing, not over a plane.
      body.x = Math.min(size - MARGIN, Math.max(MARGIN, body.x))
      body.y = Math.min(size - MARGIN, Math.max(MARGIN, body.y))
    }

    // Linear cooling, so the last pass moves nothing and the count is what ends
    // the run rather than a threshold that floating point decides.
    temperature = Math.max(0, temperature - inner / 10 / iterations)
  }

  const placed: PlacedGraphNode[] = bodies.map(body => ({
    ...body.node,
    // Rounded, and that is part of the determinism rather than tidiness: the
    // drawn picture is then identical even where the last iteration differed
    // in the twelfth decimal.
    x: Math.round(body.x * 100) / 100,
    y: Math.round(body.y * 100) / 100,
    radius: NODE_RADIUS[body.node.type]
  }))

  const byId = new Map(placed.map(node => [node.id, node]))

  return {
    nodes: placed,
    edges: edges.map(edge => {
      const a = byId.get(edge.from) as PlacedGraphNode
      const b = byId.get(edge.to) as PlacedGraphNode

      return { ...edge, x1: a.x, y1: a.y, x2: b.x, y2: b.y }
    }),
    width: size,
    height: size,
    dropped
  }
}
