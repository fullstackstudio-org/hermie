/**
 * A `sequenceDiagram` fence, drawn from `layoutSequence`: frames, lifelines,
 * activation bars, head boxes, notes and arrows, then every label.
 *
 * The ink is the Expo app's (`expo/hermie/src/markdown/mermaid/SequenceDiagram.tsx`),
 * including the three drawn arrow ends: a filled head for a call, an open one for
 * an asynchronous message, a cross for one that was lost. A dashed line is a
 * reply, as in Mermaid. An `actor` head is a stadium and a `participant` a
 * rectangle.
 */
import type { SequenceArrow, SequenceLayout } from '@hermie/markdown/mermaid/sequence-layout'
import { memo } from 'react'

import { DiagramFrame, polyline, TextLayer } from './Diagram'

/** How thick every stroke in this drawing is. */
const STROKE = 1.4

/** The dash pattern a lifeline and a frame divider use. */
const LIFELINE_DASH = '3 3'

/** The dash pattern a `--`-prefixed arrow uses. */
const ARROW_DASH = '5 3'

/** An arrowhead's length along the line, in diagram units. */
const HEAD = 7

/** Half the width of a filled head, and of an open one's spread. */
const HEAD_SPREAD = 3

const round = (value: number): number => Math.round(value * 100) / 100

function ArrowEnd({ arrow }: { arrow: SequenceArrow }) {
  const end = arrow.points[arrow.points.length - 1]
  const before = arrow.points[arrow.points.length - 2] ?? end

  if (!end || !before || arrow.head === 'none') {
    return null
  }

  const dx = end.x - before.x
  const dy = end.y - before.y
  const length = Math.hypot(dx, dy) || 1
  const ux = dx / length
  const uy = dy / length
  const nx = dy / length
  const ny = -dx / length
  const baseX = end.x - ux * HEAD
  const baseY = end.y - uy * HEAD

  if (arrow.head === 'filled') {
    return (
      <polygon
        className="md-dg-ink-fill"
        points={[
          `${round(end.x)},${round(end.y)}`,
          `${round(baseX + nx * HEAD_SPREAD)},${round(baseY + ny * HEAD_SPREAD)}`,
          `${round(baseX - nx * HEAD_SPREAD)},${round(baseY - ny * HEAD_SPREAD)}`
        ].join(' ')}
      />
    )
  }

  if (arrow.head === 'open') {
    return (
      <g>
        <line
          className="md-dg-ink"
          strokeWidth={STROKE}
          x1={end.x}
          x2={round(baseX + nx * HEAD_SPREAD)}
          y1={end.y}
          y2={round(baseY + ny * HEAD_SPREAD)}
        />
        <line
          className="md-dg-ink"
          strokeWidth={STROKE}
          x1={end.x}
          x2={round(baseX - nx * HEAD_SPREAD)}
          y1={end.y}
          y2={round(baseY - ny * HEAD_SPREAD)}
        />
      </g>
    )
  }

  // A cross, for `-x`: a message that was sent and not delivered, at the end of the line.
  const arm = HEAD_SPREAD + 1
  const centreX = end.x - ux * arm
  const centreY = end.y - uy * arm

  return (
    <g>
      <line
        className="md-dg-ink"
        strokeWidth={STROKE}
        x1={round(centreX - (ux + nx) * arm)}
        x2={round(centreX + (ux + nx) * arm)}
        y1={round(centreY - (uy + ny) * arm)}
        y2={round(centreY + (uy + ny) * arm)}
      />
      <line
        className="md-dg-ink"
        strokeWidth={STROKE}
        x1={round(centreX - (ux - nx) * arm)}
        x2={round(centreX + (ux - nx) * arm)}
        y1={round(centreY - (uy - ny) * arm)}
        y2={round(centreY + (uy - ny) * arm)}
      />
    </g>
  )
}

function SequenceDiagramView({ layout, label }: { layout: SequenceLayout; label: string }) {
  return (
    <DiagramFrame kind="sequence" label={label} layout={layout}>
      {layout.frames.map((frame, index) => (
        <g key={`frame-${index}`}>
          <rect
            className="md-dg-frame"
            height={frame.height}
            rx={4}
            strokeWidth={STROKE}
            width={frame.width}
            x={frame.x}
            y={frame.y}
          />
          <rect
            className="md-dg-frame-tag"
            height={frame.tag.height}
            strokeWidth={STROKE}
            width={frame.tag.width}
            x={frame.tag.x}
            y={frame.tag.y}
          />
          {frame.dividers.map((y, at) => (
            <line
              className="md-dg-hairline"
              key={at}
              strokeDasharray={LIFELINE_DASH}
              strokeWidth={STROKE}
              x1={frame.x}
              x2={frame.x + frame.width}
              y1={y}
              y2={y}
            />
          ))}
        </g>
      ))}

      {layout.lifelines.map((lifeline, index) => (
        <line
          className="md-dg-lifeline"
          key={`lifeline-${index}`}
          strokeDasharray={LIFELINE_DASH}
          strokeWidth={1}
          x1={lifeline.x}
          x2={lifeline.x}
          y1={lifeline.top}
          y2={lifeline.bottom}
        />
      ))}

      {layout.activations.map((bar, index) => (
        <rect
          className="md-dg-node"
          height={bar.height}
          key={`activation-${index}`}
          strokeWidth={STROKE}
          width={bar.width}
          x={bar.x}
          y={bar.y}
        />
      ))}

      {layout.heads.map((head, index) => (
        <rect
          className="md-dg-node"
          height={head.height}
          key={`head-${index}`}
          rx={head.actor ? head.height / 2 : 4}
          strokeWidth={STROKE}
          width={head.width}
          x={head.x}
          y={head.y}
        />
      ))}

      {layout.notes.map((note, index) => (
        <rect
          className="md-dg-note"
          height={note.height}
          key={`note-${index}`}
          rx={3}
          strokeWidth={STROKE}
          width={note.width}
          x={note.x}
          y={note.y}
        />
      ))}

      {layout.arrows.map((arrow, index) => (
        <g key={`arrow-${index}`}>
          <path
            className="md-dg-arrow"
            d={polyline(arrow.points)}
            strokeWidth={STROKE}
            {...(arrow.dashed ? { strokeDasharray: ARROW_DASH } : {})}
          />
          <ArrowEnd arrow={arrow} />
        </g>
      ))}

      <TextLayer texts={layout.texts} />
    </DiagramFrame>
  )
}

export const SequenceDiagram = memo(SequenceDiagramView)
