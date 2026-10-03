/**
 * A `flowchart` (or `graph`) fence, drawn from `layoutMermaid`: edges, then the
 * node shapes over them, then every label.
 *
 * The shapes, strokes and arrowheads are the Expo app's
 * (`expo/hermie/src/markdown/mermaid/Mermaid.tsx`), so a diagram looks the same
 * in both; every coordinate is a number from the layout.
 */
import type { MermaidLayout, PlacedEdge, PlacedNode } from '@hermie/markdown/mermaid/layout'
import { memo } from 'react'

import { BoxedLines, DiagramFrame, polyline } from './Diagram'

/** Corner radius for the two rounded shapes. */
const ROUND_RADIUS = 8

/** Arrowhead length, in diagram units. */
const ARROW = 7

/** How thick each stroke kind is drawn. */
const STROKE_WIDTH = { dotted: 1.4, solid: 1.4, thick: 2.6 } as const

/** The dash pattern a dotted edge uses. */
const DOTTED_DASH = '4 3'

const NODE_STROKE = 1.4

const round = (value: number): number => Math.round(value * 100) / 100

function NodeShape({ node }: { node: PlacedNode }) {
  const common = { className: 'md-dg-node', strokeWidth: NODE_STROKE }

  switch (node.shape) {
    case 'circle':
      return <circle {...common} cx={node.x + node.width / 2} cy={node.y + node.height / 2} r={node.width / 2} />

    case 'stadium':
      return <rect {...common} height={node.height} rx={node.height / 2} width={node.width} x={node.x} y={node.y} />

    case 'round':
      return <rect {...common} height={node.height} rx={ROUND_RADIUS} width={node.width} x={node.x} y={node.y} />

    case 'rhombus': {
      const cx = node.x + node.width / 2
      const cy = node.y + node.height / 2

      return (
        <polygon
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
        <polygon
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
        <g>
          <rect {...common} height={node.height} width={node.width} x={node.x} y={node.y} />
          <line
            className="md-dg-ink"
            strokeWidth={NODE_STROKE}
            x1={node.x + 6}
            x2={node.x + 6}
            y1={node.y}
            y2={node.y + node.height}
          />
          <line
            className="md-dg-ink"
            strokeWidth={NODE_STROKE}
            x1={node.x + node.width - 6}
            x2={node.x + node.width - 6}
            y1={node.y}
            y2={node.y + node.height}
          />
        </g>
      )

    default:
      return <rect {...common} height={node.height} rx={2} width={node.width} x={node.x} y={node.y} />
  }
}

/** The filled triangle at an arrow's far end, pointing along the last segment. */
function ArrowHead({ edge }: { edge: PlacedEdge }) {
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
  const nx = -uy
  const ny = ux
  const baseX = end.x - ux * ARROW
  const baseY = end.y - uy * ARROW
  const spread = ARROW / 2.4

  return (
    <polygon
      className="md-dg-edge-head"
      points={[
        `${round(end.x)},${round(end.y)}`,
        `${round(baseX + nx * spread)},${round(baseY + ny * spread)}`,
        `${round(baseX - nx * spread)},${round(baseY - ny * spread)}`
      ].join(' ')}
    />
  )
}

/**
 * An edge's label, on a chip of the block's surface at the middle of the edge.
 * Its width is the Expo app's estimate for the same label.
 */
function EdgeLabel({ edge, fontSize }: { edge: PlacedEdge; fontSize: number }) {
  const start = edge.points[0]
  const end = edge.points[edge.points.length - 1]

  if (!edge.label || !start || !end) {
    return null
  }

  const size = Math.max(9, fontSize - 1)
  const width = edge.label.length * size * 0.6 + 8
  const height = Math.round(size * 1.35) + 2
  const x = round((start.x + end.x) / 2 - width / 2)
  const y = round((start.y + end.y) / 2 - height / 2)

  return (
    <g>
      <rect className="md-dg-chip" height={height} rx={4} width={round(width)} x={x} y={y} />
      <BoxedLines
        align="center"
        className="md-dg-text md-dg-muted"
        height={height}
        lines={[edge.label]}
        size={size}
        width={width}
        x={x}
        y={y}
      />
    </g>
  )
}

function FlowchartView({ layout, label }: { layout: MermaidLayout; label: string }) {
  return (
    <DiagramFrame kind="flowchart" label={label} layout={layout}>
      {layout.edges.map((edge, index) => (
        <g key={`edge-${index}`}>
          <path
            className="md-dg-edge"
            d={polyline(edge.points)}
            strokeWidth={STROKE_WIDTH[edge.stroke]}
            {...(edge.stroke === 'dotted' ? { strokeDasharray: DOTTED_DASH } : {})}
          />
          {edge.arrow ? <ArrowHead edge={edge} /> : null}
        </g>
      ))}

      {layout.nodes.map(node => (
        <g key={`node-${node.id}`}>
          <NodeShape node={node} />
          <BoxedLines
            align="center"
            className="md-dg-text"
            height={node.height}
            lines={node.lines}
            size={layout.fontSize}
            width={node.width}
            x={node.x}
            y={node.y}
          />
        </g>
      ))}

      {layout.edges.map((edge, index) => (
        <EdgeLabel edge={edge} fontSize={layout.fontSize} key={`label-${index}`} />
      ))}
    </DiagramFrame>
  )
}

export const Flowchart = memo(FlowchartView)
