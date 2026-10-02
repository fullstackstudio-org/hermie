/**
 * What a full memory graph costs to lay out, and the shape of the pass count.
 *
 * The layout is SYNCHRONOUS and runs in `useMemo` during a render, so its cost
 * is time the Graph tab is blank. Every pass is O(n²) — the repulsion is every
 * pair — so a fixed pass count costs sixteen times as much at the 400-node cap
 * as it does at 100, and the cap is not hypothetical: it is the plugin's own
 * `MAX_NODES`, which a real memory reaches.
 *
 * ## Two assertions, because one of them cannot be trusted alone
 *
 * The WORK bound is the real guard: pass count times pairs is arithmetic, it is
 * identical on every machine, and it fails exactly when somebody makes the
 * layout quadratic again. It cannot flake.
 *
 * The wall-clock assertion is a canary for the thing the work bound cannot see
 * — a pass that got much more expensive without getting more numerous. It is
 * written to be as unflaky as a clock assertion can be: it takes the BEST of
 * several runs, because the best run is the closest thing to what the machine
 * can do while a mean measures whatever else was scheduled on it.
 *
 * ## The budget is stated for THIS environment, which is not the app's
 *
 * jest-expo runs Babel-transformed code, and on the development Mac that makes
 * this loop about **7.7 times** slower than the same source under plain Node:
 * 476 ms here against 62 ms there, and 1271 ms here against 174 ms there before
 * the pass count was made adaptive. So the number below is a jest number and
 * says nothing directly about a phone. `docs/platform-notes.md` carries the
 * whole table and is explicit that neither figure has been measured on a
 * device.
 */
import { GRAPH_MAX_NODES, iterationsFor, layoutMemoryGraph } from '../src/features/memory/graph-layout'
import type { MemoryGraph } from '../src/features/memory/graph-model'

/**
 * The budget under jest-expo on the development Mac. Stated, not derived.
 *
 * Measured: 476 ms adaptive, 1271 ms with the old fixed pass count — on an idle
 * machine. The same run took 3320 ms with a load average of 17 (several native
 * builds and test suites side by side), and still passed the structural
 * assertions above, which are what pin the algorithm: the pass count times the
 * pair count is exact on every machine. So this clock is a tripwire against a
 * gross regression (a return to quadratic work would take tens of seconds),
 * not a performance measurement, and its budget is set well above what a
 * loaded machine produces rather than just above what an idle one does.
 */
const BUDGET_MS = 6000

function graphOf(nodeCount: number): MemoryGraph {
  const topics = Math.max(1, Math.round(nodeCount / 12))
  const entries = nodeCount - 1 - topics
  const nodes: MemoryGraph['nodes'] = [{ id: 'profile', type: 'profile', label: 'researcher' }]
  const edges: MemoryGraph['edges'] = []

  for (let index = 0; index < entries; index += 1) {
    nodes.push({ id: `e${index}`, type: 'entry', label: `entry ${index}` })
    edges.push({ from: 'profile', to: `e${index}`, type: 'in_profile' })
    edges.push({ from: `e${index}`, to: `t${index % topics}`, type: 'mentions' })
  }

  for (let index = 0; index < topics; index += 1) {
    nodes.push({ id: `t${index}`, type: 'topic', label: `topic-${index}` })
  }

  return { nodes, edges, truncated: false }
}

/** The fastest of `runs` layouts, in milliseconds. */
function fastestMs(graph: MemoryGraph, runs: number): number {
  let best = Number.POSITIVE_INFINITY

  for (let run = 0; run < runs; run += 1) {
    const started = performance.now()

    layoutMemoryGraph(graph)
    best = Math.min(best, performance.now() - started)
  }

  return best
}

describe('the pass count', () => {
  it('is the full count for a graph small enough to afford it', () => {
    expect(iterationsFor(1)).toBe(240)
    expect(iterationsFor(150)).toBe(240)
  })

  it('comes down with the node count past that, so the total work grows linearly', () => {
    expect(iterationsFor(300)).toBe(120)
    expect(iterationsFor(GRAPH_MAX_NODES)).toBe(90)
  })

  /** Never so few that the largest graphs are handed an unsettled cloud. */
  it('has a floor', () => {
    expect(iterationsFor(100_000)).toBe(60)
  })

  /**
   * The count is a pure function of the node count, which is what keeps the
   * whole module's promise: the same memory draws the same picture every time.
   */
  it('is the same answer every time it is asked', () => {
    expect(iterationsFor(217)).toBe(iterationsFor(217))
  })
})

describe('laying out a full page', () => {
  /**
   * The bound that cannot flake: how many node pairs the whole layout touches.
   *
   * With a fixed 240 passes the cap costs 38.4M pair-visits against 5.4M at the
   * adaptive point — seven times the work for two and a half times the nodes,
   * which is the quadratic growth this exists to stop. Adaptive, it is 14.4M:
   * 2.67 times the work, in line with the node count rather than its square.
   */
  it('does not let the work grow with the square of the node count', () => {
    const atCap = iterationsFor(GRAPH_MAX_NODES) * GRAPH_MAX_NODES ** 2
    const atAdaptivePoint = iterationsFor(150) * 150 ** 2

    expect(atCap / atAdaptivePoint).toBeLessThan(3.5)
  })

  it(`places the whole cap inside ${BUDGET_MS} ms`, () => {
    const graph = graphOf(GRAPH_MAX_NODES)

    // One warm-up, so the assertion is not measuring the first JIT pass.
    layoutMemoryGraph(graph)

    const best = fastestMs(graph, 5)

    expect(best).toBeLessThan(BUDGET_MS)
  })

  it('still places every node it was given', () => {
    const layout = layoutMemoryGraph(graphOf(GRAPH_MAX_NODES))

    expect(layout.nodes).toHaveLength(GRAPH_MAX_NODES)
    expect(layout.dropped).toBe(0)
  })

  /** Fewer passes must not mean nodes left piled on the seeding ring. */
  it('spreads them over the frame rather than leaving them where they started', () => {
    const layout = layoutMemoryGraph(graphOf(GRAPH_MAX_NODES), { size: 640 })
    const xs = layout.nodes.map(node => node.x)
    const ys = layout.nodes.map(node => node.y)

    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(320)
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(320)
  })
})
