/**
 * A parsed pie → arcs, swatches and placed labels, in one synchronous pass.
 *
 * ## Why the geometry is computed and not measured
 *
 * The same reason every other drawing in this folder is: the chart's height has to
 * be known before it mounts, or the row it sits in on an INVERTED list moves the
 * reader by whatever it grows (`docs/platform-notes.md`, and ADR-0020 for the
 * decision). A radius is arithmetic on the font size and a legend row is
 * arithmetic on a character count, so there is nothing to wait for.
 *
 * ## A ring, and a legend that carries the numbers
 *
 * The slices are an annulus rather than a full circle because the middle of a pie
 * is where a label would have to go otherwise, and a label inside a 40-point wedge
 * is unreadable at any size a chat bubble can spare. So nothing is written on the
 * chart at all: every label, value and percentage is in the legend beside it,
 * where the text is horizontal and one column wide.
 *
 * Percentages are rounded, and a rounded set does not always total 100. That is
 * visible and accepted: the alternative is either a decimal nobody asked for on
 * every row, or the largest slice silently absorbing the remainder — which would
 * print a number that is not the one the arithmetic gives.
 */

import { diagramFontSize, diagramLineHeight, labelBoxWidth, widestWidth, wrapToWidth, type DiagramText } from './labels'
import type { PieChart } from './pie'

export interface PieArc {
  /** The slice's position in the chart, which is also which colour it takes. */
  index: number
  /** The annulus sector as a path, or empty for a slice with no angle at all. */
  path: string
  /**
   * A slice that is the whole circle.
   *
   * An arc from an angle to itself draws nothing, so the one case where a single
   * slice holds every unit is drawn as a ring instead. The renderer needs to know
   * which it is; the layout is where that is decided.
   */
  full: boolean
}

export interface PieSwatch {
  index: number
  x: number
  y: number
  width: number
  height: number
}

export interface PieLayout {
  width: number
  height: number
  fontSize: number
  centre: { x: number; y: number }
  outerRadius: number
  innerRadius: number
  arcs: PieArc[]
  swatches: PieSwatch[]
  texts: DiagramText[]
}

/** The drawing's own margin. */
const MARGIN = 10

/** The ring's outer radius and its hole, both as multiples of the font size. */
const RADIUS_EM = 4.4
const HOLE = 0.58

/** Between the ring and the legend. */
const LEGEND_GAP = 16

/** A legend swatch, and the air after it. */
const SWATCH = 10
const SWATCH_GAP = 7

/** Between a legend label and the value column, and between two rows. */
const VALUE_GAP = 12
const ROW_GAP = 5

/** How wide a legend label may be before it wraps. */
const LABEL_MAX = 150

/** How much bigger the title is than the labels. */
const TITLE_STEP = 1

/** Below the title, before the ring. */
const TITLE_GAP = 8

/** A slice at least this many degrees short of the full turn is a sector. */
const FULL_TURN = 359.9

function point(centre: { x: number; y: number }, radius: number, degrees: number) {
  // Zero degrees is twelve o'clock, which is where every pie chart starts, and
  // the angle grows clockwise, which is the way every pie chart is read.
  const radians = ((degrees - 90) * Math.PI) / 180

  return {
    x: round(centre.x + radius * Math.cos(radians)),
    y: round(centre.y + radius * Math.sin(radians))
  }
}

/** Two decimals is under a tenth of a point at any size this draws at. */
function round(value: number): number {
  return Math.round(value * 100) / 100
}

/** One annulus sector, from one angle to the next. */
function sector(centre: { x: number; y: number }, outer: number, inner: number, from: number, to: number): string {
  const large = to - from > 180 ? 1 : 0
  const outerFrom = point(centre, outer, from)
  const outerTo = point(centre, outer, to)
  const innerTo = point(centre, inner, to)
  const innerFrom = point(centre, inner, from)

  return [
    `M${outerFrom.x},${outerFrom.y}`,
    `A${outer},${outer} 0 ${large} 1 ${outerTo.x},${outerTo.y}`,
    `L${innerTo.x},${innerTo.y}`,
    `A${inner},${inner} 0 ${large} 0 ${innerFrom.x},${innerFrom.y}`,
    'Z'
  ].join(' ')
}

/** A value as the legend prints it: a whole number stays whole. */
export function formatPieValue(value: number): string {
  return Number.isInteger(value) ? String(value) : String(round(value))
}

/**
 * A share as the legend prints it.
 *
 * Rounded to a whole percent, except where that would print `0%` for a slice
 * that is genuinely there — a row that exists and reads as nothing is the one
 * rounding this must not do.
 */
export function formatPieShare(value: number, total: number): string {
  const share = total > 0 ? (value / total) * 100 : 0
  const whole = Math.round(share)

  return whole === 0 && share > 0 ? `${share.toFixed(1)}%` : `${whole}%`
}

/** Place a parsed pie. */
export function layoutPie(chart: PieChart, bodyFontSize: number): PieLayout {
  const fontSize = diagramFontSize(bodyFontSize)
  const lineHeight = diagramLineHeight(fontSize)
  const titleSize = fontSize + TITLE_STEP
  const titleLineHeight = diagramLineHeight(titleSize)
  const outerRadius = Math.round(fontSize * RADIUS_EM)
  const innerRadius = Math.round(outerRadius * HOLE)
  const total = chart.slices.reduce((sum, slice) => sum + slice.value, 0)

  const rows = chart.slices.map((slice, index) => {
    const lines = wrapToWidth(slice.label, fontSize, LABEL_MAX)
    const value = `${formatPieValue(slice.value)}  ${formatPieShare(slice.value, total)}`

    return {
      height: Math.max(lineHeight, lines.length * lineHeight),
      index,
      labelWidth: labelBoxWidth(lines, fontSize, 0),
      lines,
      value,
      valueWidth: labelBoxWidth([value], fontSize, 0)
    }
  })

  const labelColumn = rows.reduce((most, row) => Math.max(most, row.labelWidth), 0)
  const valueColumn = rows.reduce((most, row) => Math.max(most, row.valueWidth), 0)
  const legendWidth = SWATCH + SWATCH_GAP + labelColumn + VALUE_GAP + valueColumn
  const legendHeight = rows.reduce((sum, row) => sum + row.height, 0) + ROW_GAP * Math.max(0, rows.length - 1)

  const titleLines = chart.title ? wrapToWidth(chart.title, titleSize, outerRadius * 2 + LEGEND_GAP + legendWidth) : []
  const titleHeight = titleLines.length ? titleLines.length * titleLineHeight + TITLE_GAP : 0

  const bodyHeight = Math.max(outerRadius * 2, legendHeight)
  const width = Math.max(
    MARGIN * 2 + outerRadius * 2 + LEGEND_GAP + legendWidth,
    MARGIN * 2 + widestWidth(titleLines, titleSize)
  )
  const height = MARGIN * 2 + titleHeight + bodyHeight

  const bodyTop = MARGIN + titleHeight
  const centre = {
    x: MARGIN + outerRadius,
    y: bodyTop + bodyHeight / 2
  }

  const texts: DiagramText[] = []

  if (titleLines.length) {
    texts.push({
      align: 'center',
      height: titleLines.length * titleLineHeight,
      lines: titleLines,
      size: titleSize,
      tone: 'ink',
      width: width - MARGIN * 2,
      x: MARGIN,
      y: MARGIN
    })
  }

  const arcs: PieArc[] = []
  let angle = 0

  chart.slices.forEach((slice, index) => {
    const sweep = total > 0 ? (slice.value / total) * 360 : 0

    if (sweep <= 0) {
      arcs.push({ full: false, index, path: '' })

      return
    }

    if (sweep >= FULL_TURN) {
      arcs.push({ full: true, index, path: '' })
      angle += sweep

      return
    }

    arcs.push({ full: false, index, path: sector(centre, outerRadius, innerRadius, angle, angle + sweep) })
    angle += sweep
  })

  const swatches: PieSwatch[] = []
  const legendLeft = MARGIN + outerRadius * 2 + LEGEND_GAP
  let at = bodyTop + (bodyHeight - legendHeight) / 2

  for (const row of rows) {
    swatches.push({
      height: SWATCH,
      index: row.index,
      width: SWATCH,
      // Centred on the row's first line rather than on the row, so a label that
      // wrapped to two lines still has its swatch beside the first of them.
      x: legendLeft,
      y: at + (lineHeight - SWATCH) / 2
    })
    texts.push({
      align: 'left',
      height: row.lines.length * lineHeight,
      lines: row.lines,
      size: fontSize,
      tone: 'ink',
      width: labelColumn + 2,
      x: legendLeft + SWATCH + SWATCH_GAP,
      y: at
    })
    texts.push({
      align: 'right',
      height: lineHeight,
      lines: [row.value],
      size: fontSize,
      tone: 'muted',
      width: valueColumn + 2,
      x: legendLeft + SWATCH + SWATCH_GAP + labelColumn + VALUE_GAP,
      y: at
    })

    at += row.height + ROW_GAP
  }

  return {
    arcs,
    centre,
    fontSize,
    height: Math.round(height),
    innerRadius,
    outerRadius,
    swatches,
    texts,
    width: Math.round(width)
  }
}
