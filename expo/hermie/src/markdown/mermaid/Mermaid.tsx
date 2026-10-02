/**
 * A ```mermaid fence, drawn.
 *
 * ## No WebView, and no `mermaid`
 *
 * ADR-0020 has the decision in full. In short: `mermaid` is megabytes of
 * JavaScript that needs a DOM, so on the phones it would have to run inside a
 * `WebView` — and a `WebView` only learns its content's height after the page
 * has laid out, which means the row grows a frame or two late. On an INVERTED
 * list a row that grows after layout moves the reader by exactly the growth;
 * `docs/platform-notes.md` measured that for `Show more` and it is the same
 * displacement here.
 *
 * So the diagram is parsed, laid out and drawn in JavaScript that already ships
 * — `react-native-svg` is in the bundle for the icons and the bubble tails — and
 * the box knows its own size before it mounts.
 *
 * Two things fall out of that, and both are the point:
 *
 *  - **There is nothing to sandbox.** Mermaid's `securityLevel: 'strict'` exists
 *    because its renderer can be made to emit script and follow links out of a
 *    diagram's labels. This renderer has no script engine and no navigation: a
 *    label is characters in a `Text`, and an `<a>` in one is the literal
 *    characters an author typed.
 *  - **A diagram this renderer cannot draw is shown as its source.** A `gantt`, a
 *    `classDiagram`, a `subgraph`, a half-streamed fence — all of them come back
 *    from every parser as `null` and land in a code block, which is readable and
 *    copyable and says exactly what the model wrote.
 *
 * ## It scales, it does not reflow
 *
 * The drawing has a natural size in its own units. Where the bubble is narrower
 * than that, the whole picture is scaled down by a single factor — the `viewBox`
 * does it, so nothing is re-laid-out and the aspect ratio holds. A diagram wider
 * than the bubble therefore gets smaller rather than getting a scroll view, which
 * is deliberate: a horizontal scroller inside a vertical list eats drags that
 * started on it, which `Block.tsx` says about tables for the same reason.
 */
import { memo, useMemo } from 'react'
import { Text, View } from 'react-native'
import Svg, { Circle, G, Line, Path, Polygon, Rect } from 'react-native-svg'

import { CodeBlock } from '../CodeBlock'
import type { MarkdownContext } from '../context'
import { layoutMermaid, type MermaidLayout, type PlacedEdge, type PlacedNode } from './layout'
import { parseMermaid } from './parse'
import { PieChartView } from './PieChart'
import { SequenceDiagramView } from './SequenceDiagram'
import { parsePie } from './pie'
import { layoutPie } from './pie-layout'
import { parseSequence } from './sequence'
import { layoutSequence } from './sequence-layout'

/** The fence info string this renderer claims. */
export const MERMAID_LANGUAGE = 'mermaid'

/** Corner radius for the two rounded shapes. */
const ROUND_RADIUS = 8

/** Arrowhead size, in diagram units. */
const ARROW = 7

/** How thick each stroke kind is drawn. */
const STROKE_WIDTH = { dotted: 1.4, solid: 1.4, thick: 2.6 } as const

/** The dash pattern a dotted edge uses. */
const DOTTED_DASH = '4 3'

function nodeShape(node: PlacedNode, stroke: string, fill: string) {
  const common = { fill, stroke, strokeWidth: 1.4 }

  switch (node.shape) {
    case 'circle':
      return <Circle {...common} cx={node.x + node.width / 2} cy={node.y + node.height / 2} r={node.width / 2} />

    case 'stadium':
      return <Rect {...common} height={node.height} rx={node.height / 2} width={node.width} x={node.x} y={node.y} />

    case 'round':
      return <Rect {...common} height={node.height} rx={ROUND_RADIUS} width={node.width} x={node.x} y={node.y} />

    case 'rhombus': {
      const cx = node.x + node.width / 2
      const cy = node.y + node.height / 2

      return (
        <Polygon
          {...common}
          points={`${cx},${node.y} ${node.x + node.width},${cy} ${cx},${node.y + node.height} ${node.x},${cy}`}
        />
      )
    }

    case 'hexagon': {
      const inset = Math.min(16, node.width / 4)
      const top = node.y
      const bottom = node.y + node.height
      const cy = node.y + node.height / 2

      return (
        <Polygon
          {...common}
          points={[
            `${node.x + inset},${top}`,
            `${node.x + node.width - inset},${top}`,
            `${node.x + node.width},${cy}`,
            `${node.x + node.width - inset},${bottom}`,
            `${node.x + inset},${bottom}`,
            `${node.x},${cy}`
          ].join(' ')}
        />
      )
    }

    case 'subroutine':
      return (
        <G>
          <Rect {...common} height={node.height} width={node.width} x={node.x} y={node.y} />
          <Line
            stroke={stroke}
            strokeWidth={1.4}
            x1={node.x + 6}
            x2={node.x + 6}
            y1={node.y}
            y2={node.y + node.height}
          />
          <Line
            stroke={stroke}
            strokeWidth={1.4}
            x1={node.x + node.width - 6}
            x2={node.x + node.width - 6}
            y1={node.y}
            y2={node.y + node.height}
          />
        </G>
      )

    default:
      return <Rect {...common} height={node.height} rx={2} width={node.width} x={node.x} y={node.y} />
  }
}

/** The filled triangle at an arrow's far end, pointing along the last segment. */
function arrowHead(edge: PlacedEdge, colour: string) {
  const end = edge.points[edge.points.length - 1]
  const before = edge.points[edge.points.length - 2] ?? end

  if (!end || !before) {
    return null
  }

  const dx = end.x - before.x
  const dy = end.y - before.y
  const length = Math.hypot(dx, dy) || 1
  const ux = dx / length
  const uy = dy / length
  // The normal, for the two base corners.
  const nx = -uy
  const ny = ux
  const baseX = end.x - ux * ARROW
  const baseY = end.y - uy * ARROW

  return (
    <Polygon
      fill={colour}
      points={[
        `${end.x},${end.y}`,
        `${baseX + nx * (ARROW / 2.4)},${baseY + ny * (ARROW / 2.4)}`,
        `${baseX - nx * (ARROW / 2.4)},${baseY - ny * (ARROW / 2.4)}`
      ].join(' ')}
    />
  )
}

function edgePath(edge: PlacedEdge): string {
  return edge.points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x},${point.y}`).join(' ')
}

/**
 * The labels, as real `Text` rather than SVG `Text`.
 *
 * `react-native-svg`'s `Text` measures on the native side and its metrics differ
 * per platform, which would put a label outside its box on one target and not on
 * another. A `Text` absolutely positioned over the drawing uses the same text
 * engine as the rest of the bubble, and — the part that matters — is SELECTABLE
 * and readable by a screen reader, which text inside an `Svg` is not.
 */
function Labels({ layout, context, scale }: { layout: MermaidLayout; context: MarkdownContext; scale: number }) {
  const lineHeight = Math.round(layout.fontSize * 1.35)

  return (
    <>
      {layout.nodes.map(node => (
        <View
          key={node.id}
          pointerEvents="none"
          style={{
            alignItems: 'center',
            height: node.height * scale,
            justifyContent: 'center',
            left: node.x * scale,
            position: 'absolute',
            top: node.y * scale,
            width: node.width * scale
          }}
        >
          {node.lines.map((line, index) => (
            <Text
              key={index}
              selectable={context.selectable}
              style={{
                color: context.textColor,
                fontSize: layout.fontSize * scale,
                lineHeight: lineHeight * scale,
                textAlign: 'center'
              }}
            >
              {line}
            </Text>
          ))}
        </View>
      ))}

      {layout.edges.map((edge, index) => {
        if (!edge.label) {
          return null
        }

        const start = edge.points[0]
        const end = edge.points[edge.points.length - 1]

        if (!start || !end) {
          return null
        }

        const size = Math.max(9, layout.fontSize - 1)
        // Half the estimated run, so the label is centred on the segment rather
        // than starting at its middle.
        const width = edge.label.length * size * 0.6 + 8

        return (
          <View
            key={`label-${index}`}
            pointerEvents="none"
            style={{
              alignItems: 'center',
              backgroundColor: context.blockBackground,
              borderRadius: 4,
              left: ((start.x + end.x) / 2) * scale - (width * scale) / 2,
              paddingHorizontal: 3,
              position: 'absolute',
              top: ((start.y + end.y) / 2) * scale - (size * scale) / 2 - 2,
              width: width * scale
            }}
          >
            <Text
              numberOfLines={1}
              selectable={context.selectable}
              style={{ color: context.mutedTextColor, fontSize: size * scale }}
            >
              {edge.label}
            </Text>
          </View>
        )
      })}
    </>
  )
}

/**
 * Which of the three drawings this fence is, already laid out.
 *
 * The parsers are tried in turn and each one reads the header line first, so the
 * two that decline cost a regular expression apiece. Tagging the answer rather
 * than returning three nullable layouts means the renderer below has one thing to
 * branch on and cannot draw two diagrams from one fence.
 */
type Drawing =
  | { kind: 'flowchart'; layout: MermaidLayout }
  | { kind: 'sequence'; layout: ReturnType<typeof layoutSequence> }
  | { kind: 'pie'; layout: ReturnType<typeof layoutPie> }

function draw(source: string, fontSize: number): Drawing | null {
  const graph = parseMermaid(source)

  if (graph) {
    return { kind: 'flowchart', layout: layoutMermaid(graph, fontSize) }
  }

  const sequence = parseSequence(source)

  if (sequence) {
    return { kind: 'sequence', layout: layoutSequence(sequence, fontSize) }
  }

  const pie = parsePie(source)

  if (pie) {
    return { kind: 'pie', layout: layoutPie(pie, fontSize) }
  }

  return null
}

function MermaidDiagramView({ source, context }: { source: string; context: MarkdownContext }) {
  const drawing = useMemo(() => draw(source, context.fontSize), [source, context.fontSize])

  if (!drawing) {
    return <CodeBlock code={source.replace(/\n$/u, '')} context={context} language={MERMAID_LANGUAGE} />
  }

  if (drawing.kind === 'sequence') {
    return <SequenceDiagramView context={context} layout={drawing.layout} />
  }

  if (drawing.kind === 'pie') {
    return <PieChartView context={context} layout={drawing.layout} />
  }

  const layout = drawing.layout

  // Down only. A four-box diagram blown up to the width of an iPad is a poster,
  // and the reader asked for a diagram in a message.
  const scale = context.contentWidth ? Math.min(1, context.contentWidth / layout.width) : 1
  const width = layout.width * scale
  const height = layout.height * scale
  const ink = context.textColor
  const muted = context.mutedTextColor

  return (
    <View
      style={{
        backgroundColor: context.blockBackground,
        borderColor: context.borderColor,
        borderRadius: 12,
        borderWidth: 1,
        marginVertical: 8,
        padding: 8
      }}
      testID="markdown-mermaid"
    >
      <View style={{ height, width }}>
        <Svg height={height} viewBox={`0 0 ${layout.width} ${layout.height}`} width={width}>
          {layout.edges.map((edge, index) => (
            <G key={index}>
              <Path
                d={edgePath(edge)}
                fill="none"
                stroke={muted}
                strokeWidth={STROKE_WIDTH[edge.stroke]}
                {...(edge.stroke === 'dotted' ? { strokeDasharray: DOTTED_DASH } : {})}
              />
              {edge.arrow ? arrowHead(edge, muted) : null}
            </G>
          ))}

          {layout.nodes.map(node => (
            <G key={node.id}>{nodeShape(node, ink, context.blockBackground)}</G>
          ))}
        </Svg>

        <Labels context={context} layout={layout} scale={scale} />
      </View>
    </View>
  )
}

/**
 * Memoized on the source and the context, exactly like `CodeBlock`: a streaming
 * reply re-renders its tail on every delta, and re-parsing and re-laying out a
 * settled diagram on each one is the cost the block memo exists to remove.
 */
export const MermaidDiagram = memo(MermaidDiagramView)
