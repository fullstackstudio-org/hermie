/**
 * A Mermaid flowchart → a graph, or `null`.
 *
 * ## The subset, stated up front
 *
 * `flowchart` and `graph`, in all four directions, with the node shapes and the
 * edge kinds a model actually writes. Everything else answers `null`. A
 * `sequenceDiagram` and a `pie` have parsers of their own beside this one and
 * `Mermaid.tsx` tries each in turn; a `classDiagram`, a `stateDiagram`, a
 * `gantt`, and the `subgraph`, `style`, `classDef` and `click` statements inside
 * a flowchart have none, so the caller shows the fenced source instead.
 *
 * That is the whole of ADR-0020's trade. The alternative is the `mermaid`
 * package, which is megabytes of JavaScript that needs a DOM and therefore a
 * WebView on the phones — and a WebView reports its content height
 * asynchronously, which on an INVERTED list moves the reader by exactly the
 * correction the moment the diagram settles. A parser that answers `null` for a
 * `gantt` chart costs one reader one picture; a renderer that resizes its own row
 * costs every reader their place in the conversation.
 *
 * ## Pure, and total
 *
 * No React, no theme, no platform, and it never throws. A half-arrived diagram —
 * which is what every flush of a streaming reply carries — is a `null` and a
 * fenced listing, not an exception.
 */

import { cleanLabel } from './labels'

export type Direction = 'TD' | 'BT' | 'LR' | 'RL'

export type NodeShape = 'rect' | 'round' | 'stadium' | 'circle' | 'rhombus' | 'hexagon' | 'subroutine'

export interface MermaidNode {
  id: string
  label: string
  shape: NodeShape
}

export type EdgeStroke = 'solid' | 'dotted' | 'thick'

export interface MermaidEdge {
  from: string
  to: string
  stroke: EdgeStroke
  /** Whether the far end carries an arrowhead. `---` does not. */
  arrow: boolean
  label?: string
}

export interface MermaidGraph {
  direction: Direction
  nodes: MermaidNode[]
  edges: MermaidEdge[]
}

/** Past this a diagram is a data dump rather than a picture, and is left as source. */
const MAX_NODES = 60
const MAX_EDGES = 120
const MAX_SOURCE = 8000

/** The header line, which is the one thing every supported diagram has. */
const HEADER_RE = /^(?:flowchart|graph)(?:\s+(TD|TB|BT|LR|RL))?\s*$/i

/**
 * Statements this parser refuses rather than ignores.
 *
 * Ignoring them would draw a diagram that is missing the grouping, the colours
 * or the links the author asked for, and a picture that quietly leaves things out
 * is worse than the source it was made from.
 */
const UNSUPPORTED_RE = /^(?:subgraph|end|style|classDef|class|click|linkStyle|direction)\b/i

/** An id, and the bracket pair that says what shape it is drawn in. */
const NODE_RE =
  /^\s*([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*(?:(\(\()(.*?)\)\)|(\[\[)(.*?)\]\]|(\(\[)(.*?)\]\)|(\{\{)(.*?)\}\}|(\[)(.*?)\]|(\()(.*?)\)|(\{)(.*?)\})?/

interface EdgePattern {
  re: RegExp
  stroke: EdgeStroke
  arrow: boolean
  /** Which capture group holds the inline label, when the form has one. */
  label?: number
}

/**
 * The edge spellings, most specific first.
 *
 * Order is the whole correctness argument: `-.->` has to be tried before `--`,
 * and `--text-->` before `-->`, or the shorter pattern wins and the rest of the
 * arrow is read as a node id.
 */
const EDGE_PATTERNS: EdgePattern[] = [
  { arrow: true, label: 1, re: /^\s*-\.\s*([^.\n]+?)\s*\.->/, stroke: 'dotted' },
  { arrow: false, label: 1, re: /^\s*-\.\s*([^.\n]+?)\s*\.-/, stroke: 'dotted' },
  { arrow: true, re: /^\s*-\.->/, stroke: 'dotted' },
  { arrow: false, re: /^\s*-\.-/, stroke: 'dotted' },
  { arrow: true, label: 1, re: /^\s*==\s*([^=\n]+?)\s*==>/, stroke: 'thick' },
  { arrow: false, label: 1, re: /^\s*==\s*([^=\n]+?)\s*==/, stroke: 'thick' },
  { arrow: true, re: /^\s*={2,}>/, stroke: 'thick' },
  { arrow: false, re: /^\s*={3,}/, stroke: 'thick' },
  { arrow: true, label: 1, re: /^\s*--\s*([^->\n]+?)\s*-->/, stroke: 'solid' },
  { arrow: false, label: 1, re: /^\s*--\s*([^->\n]+?)\s*---/, stroke: 'solid' },
  { arrow: true, re: /^\s*-{2,}>/, stroke: 'solid' },
  { arrow: false, re: /^\s*-{3,}/, stroke: 'solid' }
]

/** `|label|` after an arrow, the other half of how Mermaid spells an edge label. */
const PIPE_LABEL_RE = /^\s*\|([^|\n]*)\|/

function shapeOf(match: RegExpExecArray): { label?: string; shape: NodeShape } {
  const pairs: [number, NodeShape][] = [
    [3, 'circle'],
    [5, 'subroutine'],
    [7, 'stadium'],
    [9, 'hexagon'],
    [11, 'rect'],
    [13, 'round'],
    [15, 'rhombus']
  ]

  for (const [group, shape] of pairs) {
    if (match[group - 1] !== undefined) {
      return { label: match[group], shape }
    }
  }

  return { shape: 'rect' }
}

class Builder {
  readonly nodes = new Map<string, MermaidNode>()
  readonly edges: MermaidEdge[] = []

  /**
   * Record a node, keeping the FIRST label that was not merely an id.
   *
   * `A[Start] --> B` and a later `A --> C` are the same node, and the second
   * mention carries no label at all. Letting it overwrite would blank the box.
   */
  node(id: string, label: string | undefined, shape: NodeShape): void {
    const existing = this.nodes.get(id)
    const text = label === undefined || label === '' ? undefined : label

    if (!existing) {
      this.nodes.set(id, { id, label: text ?? id, shape })

      return
    }

    if (text !== undefined) {
      existing.label = text
      existing.shape = shape
    }
  }
}

/** One statement: a node, then any number of edge-and-node pairs. */
function parseStatement(statement: string, builder: Builder): boolean {
  let rest = statement

  const first = NODE_RE.exec(rest)

  if (!first) {
    return false
  }

  let previous = first[1] as string
  const firstShape = shapeOf(first)

  builder.node(previous, cleanLabel(firstShape.label), firstShape.shape)
  rest = rest.slice(first[0].length)

  while (rest.trim()) {
    const pattern = EDGE_PATTERNS.find(candidate => candidate.re.test(rest))

    if (!pattern) {
      return false
    }

    const edge = pattern.re.exec(rest) as RegExpExecArray

    rest = rest.slice(edge[0].length)

    let label = pattern.label === undefined ? '' : cleanLabel(edge[pattern.label])
    const piped = PIPE_LABEL_RE.exec(rest)

    if (piped) {
      label = cleanLabel(piped[1])
      rest = rest.slice(piped[0].length)
    }

    const target = NODE_RE.exec(rest)

    if (!target) {
      return false
    }

    const id = target[1] as string
    const shape = shapeOf(target)

    builder.node(id, cleanLabel(shape.label), shape.shape)
    builder.edges.push({
      arrow: pattern.arrow,
      from: previous,
      stroke: pattern.stroke,
      to: id,
      ...(label ? { label } : {})
    })

    previous = id
    rest = rest.slice(target[0].length)
  }

  return true
}

/**
 * Parse one `mermaid` fence, or answer `null`.
 *
 * `null` means "show the source", never "show nothing". Every caller treats it
 * that way and the tests pin that they do.
 */
export function parseMermaid(source: string): MermaidGraph | null {
  if (!source || source.length > MAX_SOURCE) {
    return null
  }

  const lines = source
    .split('\n')
    .map(line => line.replace(/%%.*$/u, '').trim())
    .filter(Boolean)

  const header = lines.shift()

  if (!header) {
    return null
  }

  const match = HEADER_RE.exec(header)

  if (!match) {
    return null
  }

  const declared = (match[1] ?? 'TD').toUpperCase()
  const direction: Direction = declared === 'TB' ? 'TD' : (declared as Direction)
  const builder = new Builder()

  for (const line of lines) {
    if (UNSUPPORTED_RE.test(line)) {
      return null
    }

    for (const statement of line.split(';')) {
      if (!statement.trim()) {
        continue
      }

      if (!parseStatement(statement, builder)) {
        return null
      }
    }
  }

  if (!builder.nodes.size || builder.nodes.size > MAX_NODES || builder.edges.length > MAX_EDGES) {
    return null
  }

  // A single node with no edges is a box, not a diagram, and the source says
  // more than the picture would.
  if (!builder.edges.length) {
    return null
  }

  return { direction, edges: builder.edges, nodes: [...builder.nodes.values()] }
}
