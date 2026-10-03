/**
 * What the three diagram kinds share: the `svg` a diagram is drawn in, and its
 * labels as SVG text.
 *
 * The decisions are the Expo app's (`expo/hermie/src/markdown/mermaid/Canvas.tsx`):
 *
 *  - **It scales, it does not reflow.** A layout has a natural size in its own
 *    units (laid out at a body size of 16, so a unit is a sixteenth of an em of
 *    the text round it). The `svg` is that size and no wider than its box
 *    (`max-width: 100%; height: auto` in `markdown-mermaid.css`), so a diagram
 *    wider than the bubble is drawn smaller rather than re-laid-out, and keeps its
 *    proportions.
 *  - **A label sits in the box the layout gave it.** Widths are the layout's
 *    estimate (`CHARACTER_EM`), identical on every platform; the text is placed in
 *    that box, not measured, so a face a shade wider than the estimate runs a
 *    little past it rather than moving the geometry.
 *  - **Nothing carries a colour of its own.** Ink, hairlines and surfaces are
 *    classes that read the Markdown tokens, so a diagram follows the scheme and the
 *    bubble it is in. The pie's slices are the one exception, and they are classes
 *    too.
 *
 * Unlike the Expo app, the labels are SVG `text` rather than text laid over the
 * drawing: the browser draws SVG text with the same engine as the page, and the
 * drawing as a whole is named by its source for assistive technology.
 */
import { diagramLineHeight, type DiagramText } from '@hermie/markdown/mermaid/labels'
import type { ReactNode } from 'react'

/** The body size every layout is made at; the drawing's size is given in em of the text round it. */
export const LAYOUT_SIZE = 16

/** Where a line of text sits in its line box: the baseline, about a third of the size below the middle. */
const BASELINE = 0.35

export function polyline(points: readonly { x: number; y: number }[]): string {
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x},${point.y}`).join(' ')
}

/** Several lines, centred together in a box, each its own `text` (an SVG `text` does not wrap). */
export function BoxedLines({
  lines,
  x,
  y,
  width,
  height,
  size,
  align,
  className
}: {
  lines: readonly string[]
  x: number
  y: number
  width: number
  height: number
  size: number
  align: DiagramText['align']
  className: string
}) {
  const lineHeight = diagramLineHeight(size)
  const top = y + (height - lines.length * lineHeight) / 2
  const anchor = align === 'center' ? 'middle' : align === 'right' ? 'end' : 'start'
  const at = align === 'center' ? x + width / 2 : align === 'right' ? x + width : x

  return (
    <>
      {lines.map((line, index) => (
        <text
          className={className}
          fontSize={size}
          key={index}
          textAnchor={anchor}
          x={round(at)}
          y={round(top + index * lineHeight + lineHeight / 2 + BASELINE * size)}
        >
          {line}
        </text>
      ))}
    </>
  )
}

const round = (value: number): number => Math.round(value * 100) / 100

/** Every placed label of a sequence diagram or a pie, over the shapes. */
export function TextLayer({ texts }: { texts: readonly DiagramText[] }) {
  return (
    <>
      {texts.map((text, index) => (
        <g key={index}>
          {/* A chip paints the block's own surface behind a label that sits on a line. */}
          {text.chip ? (
            <rect className="md-dg-chip" height={text.height} rx={4} width={text.width} x={text.x} y={text.y} />
          ) : null}
          <BoxedLines
            align={text.align}
            className={text.tone === 'muted' ? 'md-dg-text md-dg-muted' : 'md-dg-text'}
            height={text.height}
            lines={text.lines}
            size={text.size}
            width={text.width}
            x={text.x}
            y={text.y}
          />
        </g>
      ))}
    </>
  )
}

/** The `svg` of one diagram: its natural size in em, scaled down by its box, named by its source. */
export function DiagramFrame({
  layout,
  label,
  kind,
  children
}: {
  layout: { width: number; height: number }
  label: string
  kind: 'flowchart' | 'sequence' | 'pie'
  children: ReactNode
}) {
  return (
    <svg
      aria-label={label}
      className={`md-diagram md-diagram-${kind}`}
      height={`${layout.height / LAYOUT_SIZE}em`}
      role="img"
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      width={`${layout.width / LAYOUT_SIZE}em`}
    >
      {children}
    </svg>
  )
}
