/**
 * A `sequenceDiagram`, drawn.
 *
 * Shapes only: every label in the picture arrived from the layout as a placed box
 * and is drawn by `DiagramCanvas`, for the reasons that file states. What is left
 * here is the ink — head boxes, lifelines, activation bars, arrows and frames —
 * and the one thing a sequence diagram needs that a flowchart does not, which is
 * four kinds of arrow end.
 *
 * The file is named for the diagram rather than the statement (`sequence.ts` is
 * the parser) because a case-insensitive filesystem — which is the default on a
 * Mac — cannot tell `Sequence.tsx` from `sequence.ts`, and an import of one
 * silently resolves to the other.
 *
 * ## Why the arrowheads are drawn rather than spelled
 *
 * Mermaid's spellings differ in exactly one thing, the end of the line, and a
 * reader who wrote `-x` instead of `->>` meant something by it: a lost message
 * rather than a delivered one. Drawing the three ends means the distinction
 * survives into the picture, which is the whole reason the picture is better than
 * the source. A dashed line means the same thing here as it does in Mermaid: a
 * reply rather than a call.
 */

import { memo } from 'react'
import { G, Line, Path, Polygon, Rect } from 'react-native-svg'

import type { MarkdownContext } from '../context'
import { DiagramCanvas } from './Canvas'
import type { SequenceArrow, SequenceLayout } from './sequence-layout'

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

/** The unit vector along an arrow's last segment, and the normal beside it. */
function direction(arrow: SequenceArrow) {
  const end = arrow.points[arrow.points.length - 1]
  const before = arrow.points[arrow.points.length - 2] ?? end

  if (!end || !before) {
    return null
  }

  const dx = end.x - before.x
  const dy = end.y - before.y
  const length = Math.hypot(dx, dy) || 1

  return { end, nx: dy / length, ny: -dx / length, ux: dx / length, uy: dy / length }
}

function arrowHead(arrow: SequenceArrow, colour: string) {
  const vector = direction(arrow)

  if (!vector || arrow.head === 'none') {
    return null
  }

  const { end, nx, ny, ux, uy } = vector
  const baseX = end.x - ux * HEAD
  const baseY = end.y - uy * HEAD

  if (arrow.head === 'filled') {
    return (
      <Polygon
        fill={colour}
        points={[
          `${end.x},${end.y}`,
          `${baseX + nx * HEAD_SPREAD},${baseY + ny * HEAD_SPREAD}`,
          `${baseX - nx * HEAD_SPREAD},${baseY - ny * HEAD_SPREAD}`
        ].join(' ')}
      />
    )
  }

  if (arrow.head === 'open') {
    // Two strokes rather than a filled triangle, which is what an open arrow is:
    // the same geometry as the filled head with nothing in it.
    return (
      <G>
        <Line
          stroke={colour}
          strokeWidth={STROKE}
          x1={end.x}
          x2={baseX + nx * HEAD_SPREAD}
          y1={end.y}
          y2={baseY + ny * HEAD_SPREAD}
        />
        <Line
          stroke={colour}
          strokeWidth={STROKE}
          x1={end.x}
          x2={baseX - nx * HEAD_SPREAD}
          y1={end.y}
          y2={baseY - ny * HEAD_SPREAD}
        />
      </G>
    )
  }

  // A cross, for `-x`: a message that was sent and not delivered. Drawn at the
  // end of the line rather than beside it, which is where Mermaid puts it.
  const arm = HEAD_SPREAD + 1
  const centreX = end.x - ux * arm
  const centreY = end.y - uy * arm

  return (
    <G>
      <Line
        stroke={colour}
        strokeWidth={STROKE}
        x1={centreX - (ux + nx) * arm}
        x2={centreX + (ux + nx) * arm}
        y1={centreY - (uy + ny) * arm}
        y2={centreY + (uy + ny) * arm}
      />
      <Line
        stroke={colour}
        strokeWidth={STROKE}
        x1={centreX - (ux - nx) * arm}
        x2={centreX + (ux - nx) * arm}
        y1={centreY - (uy - ny) * arm}
        y2={centreY + (uy - ny) * arm}
      />
    </G>
  )
}

function arrowPath(arrow: SequenceArrow): string {
  return arrow.points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x},${point.y}`).join(' ')
}

function SequenceDiagramViewInner({ layout, context }: { layout: SequenceLayout; context: MarkdownContext }) {
  const ink = context.textColor
  const muted = context.mutedTextColor
  const hairline = context.borderColor

  return (
    <DiagramCanvas context={context} layout={layout} testID="markdown-mermaid-sequence">
      {layout.frames.map((frame, index) => (
        <G key={`frame-${index}`}>
          <Rect
            fill="none"
            height={frame.height}
            rx={4}
            stroke={hairline}
            strokeWidth={STROKE}
            width={frame.width}
            x={frame.x}
            y={frame.y}
          />
          <Rect
            fill={context.blockBackground}
            height={frame.tag.height}
            stroke={hairline}
            strokeWidth={STROKE}
            width={frame.tag.width}
            x={frame.tag.x}
            y={frame.tag.y}
          />
          {frame.dividers.map((y, at) => (
            <Line
              key={at}
              stroke={hairline}
              strokeDasharray={LIFELINE_DASH}
              strokeWidth={STROKE}
              x1={frame.x}
              x2={frame.x + frame.width}
              y1={y}
              y2={y}
            />
          ))}
        </G>
      ))}

      {layout.lifelines.map((lifeline, index) => (
        <Line
          key={`lifeline-${index}`}
          stroke={muted}
          strokeDasharray={LIFELINE_DASH}
          strokeWidth={1}
          x1={lifeline.x}
          x2={lifeline.x}
          y1={lifeline.top}
          y2={lifeline.bottom}
        />
      ))}

      {layout.activations.map((bar, index) => (
        <Rect
          fill={context.blockBackground}
          height={bar.height}
          key={`activation-${index}`}
          stroke={ink}
          strokeWidth={STROKE}
          width={bar.width}
          x={bar.x}
          y={bar.y}
        />
      ))}

      {layout.heads.map((head, index) => (
        <Rect
          fill={context.blockBackground}
          height={head.height}
          key={`head-${index}`}
          // An `actor` is drawn as a stadium and a `participant` as a rectangle.
          // Mermaid draws a stick figure for the first, which at a diagram's own
          // font size is four strokes nobody can read — and the distinction the
          // author drew is still on the page this way.
          rx={head.actor ? head.height / 2 : 4}
          stroke={ink}
          strokeWidth={STROKE}
          width={head.width}
          x={head.x}
          y={head.y}
        />
      ))}

      {layout.notes.map((note, index) => (
        <Rect
          fill={context.blockBackground}
          height={note.height}
          key={`note-${index}`}
          rx={3}
          stroke={muted}
          strokeWidth={STROKE}
          width={note.width}
          x={note.x}
          y={note.y}
        />
      ))}

      {layout.arrows.map((arrow, index) => (
        <G key={`arrow-${index}`}>
          <Path
            d={arrowPath(arrow)}
            fill="none"
            stroke={ink}
            strokeWidth={STROKE}
            {...(arrow.dashed ? { strokeDasharray: ARROW_DASH } : {})}
          />
          {arrowHead(arrow, ink)}
        </G>
      ))}
    </DiagramCanvas>
  )
}

/**
 * Memoized on the layout and the context, exactly like the flowchart: a streaming
 * reply re-renders its tail on every delta, and re-drawing a settled diagram on
 * each one is the cost the block memo exists to remove.
 */
export const SequenceDiagramView = memo(SequenceDiagramViewInner)
