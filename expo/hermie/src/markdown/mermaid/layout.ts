/**
 * A parsed flowchart → coordinates, in one synchronous pass.
 *
 * ## Why the geometry is computed and not measured
 *
 * Every number here comes out of the label's character count and the font size,
 * the same estimate `Block.tsx` uses for a table column and `CodeBlock.tsx` for a
 * listing. Nothing is measured, so the diagram's height is known before it
 * mounts — which is the requirement, not the optimisation. A picture that
 * resizes after it is laid out moves the reader on an INVERTED list by exactly
 * the correction, and `docs/platform-notes.md` has that measurement for
 * `Show more`. ADR-0020 states the decision.
 *
 * ## The layout
 *
 * A layered drawing, which is what a flowchart is: nodes get a RANK from the
 * longest path to them, ranks become rows (or columns, reading left to right),
 * and within a rank the order is the order the source mentioned them. That last
 * rule is worth stating — a crossing-minimisation pass would draw a tidier
 * picture and would also mean the same source drew differently as the heuristic
 * was tuned, which is not a thing a reader of a conversation should ever see.
 *
 * A cycle has no longest path, so the ranking is iterative relaxation bounded by
 * the node count rather than a walk: once a pass moves nothing the ranks have
 * settled, and a back edge has simply stopped pushing its target down. The edge
 * is still drawn; it points backwards, which is what a loop in a flowchart looks
 * like.
 */
import { CHARACTER_EM, diagramFontSize, diagramLineHeight, wrapToWidth } from './labels'
import type { MermaidGraph, MermaidNode } from './parse'

/** Where one box ended up, in diagram units. */
export interface PlacedNode extends MermaidNode {
  x: number
  y: number
  width: number
  height: number
  /** The label, already broken into the lines the box will draw. */
  lines: string[]
}

export interface PlacedEdge {
  from: PlacedNode
  to: PlacedNode
  stroke: 'solid' | 'dotted' | 'thick'
  arrow: boolean
  label?: string
  /** Start, optional bend, end — in diagram units. */
  points: { x: number; y: number }[]
}

export interface MermaidLayout {
  width: number
  height: number
  nodes: PlacedNode[]
  edges: PlacedEdge[]
  fontSize: number
}

/** Air inside a box, on each side. */
const PADDING_X = 14
const PADDING_Y = 9

/** A box is never narrower or wider than this, whatever its label says. */
const MIN_WIDTH = 56
const MAX_WIDTH = 190

/** Between two boxes in the same rank, and between two ranks. */
const GAP_WITHIN = 22
const GAP_BETWEEN = 46

/** The drawing's own margin, so an arrowhead and a label are never clipped. */
const MARGIN = 10

/**
 * A label broken so a box does not become a ribbon, at the width a box is
 * capped to. The rule itself is shared with the other two diagram kinds.
 */
function wrapLabel(label: string, fontSize: number): string[] {
  return wrapToWidth(label, fontSize, MAX_WIDTH - PADDING_X * 2)
}

function boxSize(lines: string[], shape: MermaidNode['shape'], fontSize: number) {
  const widest = lines.reduce((most, line) => Math.max(most, line.length), 0)
  const lineHeight = diagramLineHeight(fontSize)
  let width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.ceil(widest * fontSize * CHARACTER_EM) + PADDING_X * 2))
  let height = lines.length * lineHeight + PADDING_Y * 2

  // A rhombus carries its label across its narrow middle, and a circle across a
  // chord: both need room the rectangle's own box does not have.
  if (shape === 'rhombus') {
    width = Math.round(width * 1.35)
    height = Math.round(height * 1.5)
  }

  if (shape === 'circle') {
    const diameter = Math.max(width, height) + 8

    width = diameter
    height = diameter
  }

  return { height, width }
}

/**
 * Every node's rank: the longest path from a source to it.
 *
 * Iterative relaxation rather than a recursive walk, bounded by the node count,
 * so a cycle terminates instead of overflowing the stack. A back edge stops
 * raising its target once nothing moves, which is exactly when the ranks have
 * settled.
 */
function ranksOf(graph: MermaidGraph): Map<string, number> {
  const rank = new Map<string, number>()

  for (const node of graph.nodes) {
    rank.set(node.id, 0)
  }

  for (let pass = 0; pass < graph.nodes.length; pass += 1) {
    let moved = false

    for (const edge of graph.edges) {
      const from = rank.get(edge.from)
      const to = rank.get(edge.to)

      if (from === undefined || to === undefined) {
        continue
      }

      if (to < from + 1) {
        rank.set(edge.to, from + 1)
        moved = true
      }
    }

    if (!moved) {
      break
    }
  }

  return rank
}

/**
 * Place a parsed graph.
 *
 * `TD` and `LR` are the same layout read along different axes, so the ranks are
 * laid out once on a main axis and a cross axis and the direction decides which
 * is which. `BT` and `RL` are the same again with the main axis reversed, which
 * is a subtraction rather than a second layout.
 */
export function layoutMermaid(graph: MermaidGraph, bodyFontSize: number): MermaidLayout {
  const fontSize = diagramFontSize(bodyFontSize)
  const rank = ranksOf(graph)
  const horizontal = graph.direction === 'LR' || graph.direction === 'RL'

  const sized = graph.nodes.map(node => {
    const lines = wrapLabel(node.label, fontSize)
    const { width, height } = boxSize(lines, node.shape, fontSize)

    return { ...node, height, lines, width, x: 0, y: 0 }
  })

  const byRank = new Map<number, typeof sized>()

  for (const node of sized) {
    const at = rank.get(node.id) ?? 0
    const bucket = byRank.get(at)

    if (bucket) {
      bucket.push(node)
    } else {
      byRank.set(at, [node])
    }
  }

  const ranks = [...byRank.keys()].sort((a, b) => a - b)

  // The main axis is the direction of flow; the cross axis is the spread within
  // one rank. `main` accumulates, `cross` is centred per rank once the widest
  // rank is known.
  const mainExtent = (node: PlacedNode) => (horizontal ? node.width : node.height)
  const crossExtent = (node: PlacedNode) => (horizontal ? node.height : node.width)

  const rankMain = new Map<number, number>()
  const rankCross = new Map<number, number>()
  let main = MARGIN

  for (const at of ranks) {
    const bucket = byRank.get(at) ?? []
    const depth = bucket.reduce((most, node) => Math.max(most, mainExtent(node)), 0)
    const spread =
      bucket.reduce((total, node) => total + crossExtent(node), 0) + GAP_WITHIN * Math.max(0, bucket.length - 1)

    rankMain.set(at, main)
    rankCross.set(at, spread)
    main += depth + GAP_BETWEEN
  }

  const mainSize = Math.max(main - GAP_BETWEEN + MARGIN, MARGIN * 2)
  const crossSize = Math.max(...[...rankCross.values()], 0) + MARGIN * 2

  for (const at of ranks) {
    const bucket = byRank.get(at) ?? []
    const depth = bucket.reduce((most, node) => Math.max(most, mainExtent(node)), 0)
    let cross = (crossSize - (rankCross.get(at) ?? 0)) / 2

    for (const node of bucket) {
      // Centred within the rank's own depth, so a tall rhombus beside a short
      // box does not drag the row's arrows out of line.
      const mainAt = (rankMain.get(at) ?? MARGIN) + (depth - mainExtent(node)) / 2

      if (horizontal) {
        node.x = mainAt
        node.y = cross
      } else {
        node.x = cross
        node.y = mainAt
      }

      cross += crossExtent(node) + GAP_WITHIN
    }
  }

  const width = horizontal ? mainSize : crossSize
  const height = horizontal ? crossSize : mainSize

  // `BT` and `RL` are the forward layout reflected along the main axis. Doing it
  // here rather than in the placement above keeps one set of rules to be wrong
  // about.
  if (graph.direction === 'BT' || graph.direction === 'RL') {
    for (const node of sized) {
      if (horizontal) {
        node.x = width - node.x - node.width
      } else {
        node.y = height - node.y - node.height
      }
    }
  }

  const placed = new Map(sized.map(node => [node.id, node]))
  const edges: PlacedEdge[] = []

  for (const edge of graph.edges) {
    const from = placed.get(edge.from)
    const to = placed.get(edge.to)

    if (!from || !to) {
      continue
    }

    edges.push({
      arrow: edge.arrow,
      from,
      points: connect(from, to),
      stroke: edge.stroke,
      to,
      ...(edge.label ? { label: edge.label } : {})
    })
  }

  return { edges, fontSize, height, nodes: sized, width }
}

/**
 * Where an edge leaves one box and where it arrives at the other.
 *
 * The line runs between the two centres and is cut back to each box's rim, so an
 * arrowhead lands on the edge of the shape rather than under it. A rectangle's
 * rim is what is used for every shape — a rhombus is inscribed in its box and a
 * circle touches it, so the arrow stops a few points short on those two, which
 * reads as breathing room rather than as an error.
 */
function connect(from: PlacedNode, to: PlacedNode): { x: number; y: number }[] {
  const start = { x: from.x + from.width / 2, y: from.y + from.height / 2 }
  const end = { x: to.x + to.width / 2, y: to.y + to.height / 2 }

  return [rimPoint(from, start, end), rimPoint(to, end, start)]
}

/** The point where the segment towards `towards` leaves `node`'s box. */
function rimPoint(node: PlacedNode, centre: { x: number; y: number }, towards: { x: number; y: number }) {
  const dx = towards.x - centre.x
  const dy = towards.y - centre.y

  if (dx === 0 && dy === 0) {
    return centre
  }

  const halfWidth = node.width / 2
  const halfHeight = node.height / 2
  // The smaller of the two scale factors is the side the ray actually leaves by.
  const scaleX = dx === 0 ? Number.POSITIVE_INFINITY : halfWidth / Math.abs(dx)
  const scaleY = dy === 0 ? Number.POSITIVE_INFINITY : halfHeight / Math.abs(dy)
  const scale = Math.min(scaleX, scaleY)

  return { x: centre.x + dx * scale, y: centre.y + dy * scale }
}
