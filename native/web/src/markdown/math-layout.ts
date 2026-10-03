/**
 * A parsed expression (`parseMath`) placed as SVG primitives: text, rules and
 * stroked paths, in the units of the font size it is laid out at.
 *
 * The construction is the Expo app's (`expo/hermie/src/markdown/math/Math.tsx`)
 * with its constants (`@hermie/markdown/math/metrics`): one-dimensional runs are
 * set on one line by `mathRuns` (so `x^2` is `x²` in both apps), and only a
 * fraction, a root, a big operator with limits, a grid, a fence round any of
 * those and the scripts on any of those are opened out into boxes. Where the
 * Expo app lets flexbox settle a box, this computes it, because an SVG has no
 * flexbox; two things follow from that and are better than the original:
 *
 *  - Boxes in a row line up on the maths AXIS (the middle of a fraction bar, the
 *    middle of a `+`), not on their centres, so a fraction whose numerator is
 *    taller than its denominator still has its bar level with the `=` beside it.
 *    For a symmetric construct the two are the same place, and the heights are
 *    the ones `mathHeight` gives.
 *  - A fence round a tall body and a radical sign are drawn as paths the height
 *    of what they enclose, instead of one glyph set larger.
 *
 * Widths come from `measure`, which the renderer answers from the browser's own
 * text metrics (a canvas, synchronously: the faces are system faces, nothing
 * loads), and which a test answers with a fixed advance. Pure and total.
 */
import { containsGrid, mathRuns, type MathRun } from '@hermie/markdown/math/linear'
import {
  FRACTION_GAP,
  GRID_COLUMN_GAP,
  gridRowGap,
  mathLineHeight,
  OPERATOR_SCALE,
  ROOT_GAP,
  RULE,
  SCRIPT_SCALE
} from '@hermie/markdown/math/metrics'
import type { MathNode, MathStyle } from '@hermie/markdown/math/parse'

export { containsGrid }

/** The advance of `text` set in `style` at `size`, in the same units as `size`. */
export type MeasureText = (text: string, style: MathStyle, size: number) => number

/** One line of runs, starting at `x` on the baseline `y`. */
export interface MathText {
  x: number
  y: number
  size: number
  runs: MathRun[]
}

/** A filled bar: a fraction's rule. */
export interface MathRule {
  x: number
  y: number
  width: number
  height: number
}

/** A stroked path: a radical sign, a fence that grows. */
export interface MathStroke {
  d: string
  width: number
}

export interface MathLayout {
  width: number
  height: number
  /** From the top to the maths axis. */
  axis: number
  texts: MathText[]
  rules: MathRule[]
  strokes: MathStroke[]
}

/**
 * How far the axis sits above the baseline, as a fraction of the font size.
 * The middle of `+`, `=` and `−` in a text face, and the axis height of the
 * maths faces (STIX Two and Cambria Math both put it at a quarter of an em).
 */
export const AXIS = 0.25

/** How much taller than a line a body must be before its fence is drawn rather than set. */
const TALL = 1.05

/** A fence and a radical sign are stroked a little heavier than a rule, as their glyphs are. */
function strokeWidth(fontSize: number): number {
  return Math.max(RULE, Math.round(fontSize * 0.07 * 10) / 10)
}

/** Rounds a coordinate to a hundredth, so the output is stable and small. */
const r = (value: number): number => Math.round(value * 100) / 100

const EMPTY: MathLayout = { width: 0, height: 0, axis: 0, texts: [], rules: [], strokes: [] }

/** The primitives of `box`, moved by (`dx`, `dy`), added to `into`. */
function place(into: MathLayout, box: MathLayout, dx: number, dy: number): void {
  for (const text of box.texts) {
    into.texts.push({ ...text, x: text.x + dx, y: text.y + dy })
  }

  for (const rule of box.rules) {
    into.rules.push({ ...rule, x: rule.x + dx, y: rule.y + dy })
  }

  for (const stroke of box.strokes) {
    into.strokes.push({ ...stroke, d: movePath(stroke.d, dx, dy) })
  }
}

/** Every path here is absolute `M`/`L`/`Q` commands with pairs of numbers. */
function movePath(d: string, dx: number, dy: number): string {
  if (!dx && !dy) {
    return d
  }

  return d.replace(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g, (_all, x: string, y: string) => {
    return `${r(Number(x) + dx)},${r(Number(y) + dy)}`
  })
}

function box(width: number, height: number, axis: number): MathLayout {
  return { width, height, axis, texts: [], rules: [], strokes: [] }
}

/**
 * Boxes side by side, lined up on their axes. `gap` is the room between two of
 * them.
 */
function row(children: MathLayout[], gap = 0): MathLayout {
  const parts = children.filter(child => child.width > 0 || child.height > 0)

  if (!parts.length) {
    return EMPTY
  }

  const axis = Math.max(...parts.map(child => child.axis))
  const below = Math.max(...parts.map(child => child.height - child.axis))
  const out = box(0, axis + below, axis)
  let x = 0

  parts.forEach((child, index) => {
    if (index > 0) {
      x += gap
    }

    place(out, child, x, axis - child.axis)
    x += child.width
  })

  out.width = x

  return out
}

/** Runs on one line, in a box one leading tall with the axis in its middle. */
function textLine(runs: MathRun[], fontSize: number, measure: MeasureText): MathLayout {
  if (!runs.length) {
    return EMPTY
  }

  const height = mathLineHeight(fontSize)
  const width = runs.reduce((sum, run) => sum + measure(run.text, run.style, fontSize), 0)
  const out = box(width, height, height / 2)

  out.texts.push({ x: 0, y: height / 2 + AXIS * fontSize, size: fontSize, runs })

  return out
}

/**
 * Whether a node is one this layout opens out into boxes: the Expo renderer's
 * rule, word for word. A `scripts` node is two-dimensional only when its base is.
 */
export function isTwoDimensional(node: MathNode): boolean {
  return (
    node.kind === 'frac' ||
    node.kind === 'sqrt' ||
    node.kind === 'grid' ||
    (node.kind === 'operator' && Boolean(node.upper ?? node.lower)) ||
    (node.kind === 'fenced' && containsTwoDimensional(node.body)) ||
    (node.kind === 'scripts' && containsTwoDimensional(node.base))
  )
}

function containsTwoDimensional(node: MathNode): boolean {
  return node.kind === 'row' ? node.items.some(containsTwoDimensional) : isTwoDimensional(node)
}

function linear(nodes: MathNode[], fontSize: number, measure: MeasureText): MathLayout {
  return textLine(mathRuns({ kind: 'row', items: nodes }), fontSize, measure)
}

function fraction(node: Extract<MathNode, { kind: 'frac' }>, fontSize: number, measure: MeasureText): MathLayout {
  const gap = Math.round(fontSize * FRACTION_GAP)
  const numerator = layoutNode(node.numerator, fontSize, measure)
  const denominator = layoutNode(node.denominator, fontSize, measure)
  const inner = Math.max(numerator.width, denominator.width)
  // Two units of air each side, so the bar is a little wider than what it divides.
  const pad = 2
  const ruleY = numerator.height + gap
  const out = box(inner + 2 * pad, ruleY + RULE + gap + denominator.height, ruleY + RULE / 2)

  place(out, numerator, pad + (inner - numerator.width) / 2, 0)
  out.rules.push({ x: pad, y: ruleY, width: inner, height: RULE })
  place(out, denominator, pad + (inner - denominator.width) / 2, ruleY + RULE + gap)

  return out
}

function root(node: Extract<MathNode, { kind: 'sqrt' }>, fontSize: number, measure: MeasureText): MathLayout {
  const gap = Math.round(fontSize * ROOT_GAP)
  const radicand = layoutNode(node.radicand, fontSize, measure)
  const stroke = strokeWidth(fontSize)
  const sign = Math.round(fontSize * 0.6)
  const pad = 3
  const height = RULE + gap + radicand.height
  const index = node.index ? layoutNode(node.index, Math.round(fontSize * SCRIPT_SCALE), measure) : EMPTY
  // The index sits over the sign's short stroke: its foot half an em above the bottom, and
  // no lower than two fifths of the way up a tall sign.
  const tickY = Math.min(height - Math.round(fontSize * 0.5), Math.round(height * 0.6))
  const lift = Math.max(0, index.height - tickY)
  const signX = Math.max(0, index.width - sign * 0.4)
  const out = box(signX + sign + pad + radicand.width + pad, height + lift, lift + RULE + gap + radicand.axis)
  const top = lift + RULE / 2
  const bottom = lift + height

  if (index.width > 0) {
    place(out, index, 0, lift + tickY - index.height)
  }

  out.strokes.push({
    d: [
      `M${r(signX)},${r(bottom - fontSize * 0.42)}`,
      `L${r(signX + sign * 0.28)},${r(bottom - fontSize * 0.5)}`,
      `L${r(signX + sign * 0.6)},${r(bottom)}`,
      `L${r(signX + sign)},${r(top)}`,
      `L${r(out.width)},${r(top)}`
    ].join(' '),
    width: stroke
  })
  place(out, radicand, signX + sign + pad, lift + RULE + gap)

  return out
}

function operator(node: Extract<MathNode, { kind: 'operator' }>, fontSize: number, measure: MeasureText): MathLayout {
  const limitSize = Math.round(fontSize * SCRIPT_SCALE)
  const symbolSize = Math.round(fontSize * OPERATOR_SCALE)
  const upper = node.upper ? layoutNode(node.upper, limitSize, measure) : EMPTY
  const lower = node.lower ? layoutNode(node.lower, limitSize, measure) : EMPTY
  const glyph = textLine([{ text: node.symbol, style: 'roman' }], symbolSize, measure)
  const inner = Math.max(upper.width, glyph.width, lower.width)
  const pad = 3
  const out = box(inner + 2 * pad, upper.height + glyph.height + lower.height, upper.height + glyph.axis)

  place(out, upper, pad + (inner - upper.width) / 2, 0)
  place(out, glyph, pad + (inner - glyph.width) / 2, upper.height)
  place(out, lower, pad + (inner - lower.width) / 2, upper.height + glyph.height)

  return out
}

/** A path for a fence `height` tall in a box `width` wide, or `null` for one that is set as a glyph. */
function fencePath(character: string, width: number, height: number): string | null {
  const inset = width * 0.2
  const left = inset
  const right = width - inset
  const middle = height / 2
  const top = 1
  const bottom = height - 1
  const point = (x: number, y: number): string => `${r(x)},${r(y)}`

  switch (character) {
    case '(':
      return `M${point(right, top)} Q${point(left - inset, middle)} ${point(right, bottom)}`
    case ')':
      return `M${point(left, top)} Q${point(right + inset, middle)} ${point(left, bottom)}`
    case '[':
      return `M${point(right, top)} L${point(left, top)} L${point(left, bottom)} L${point(right, bottom)}`
    case ']':
      return `M${point(left, top)} L${point(right, top)} L${point(right, bottom)} L${point(left, bottom)}`
    case '⌈':
      return `M${point(right, top)} L${point(left, top)} L${point(left, bottom)}`
    case '⌉':
      return `M${point(left, top)} L${point(right, top)} L${point(right, bottom)}`
    case '⌊':
      return `M${point(left, top)} L${point(left, bottom)} L${point(right, bottom)}`
    case '⌋':
      return `M${point(right, top)} L${point(right, bottom)} L${point(left, bottom)}`
    case '⟨':
      return `M${point(right, top)} L${point(left, middle)} L${point(right, bottom)}`
    case '⟩':
      return `M${point(left, top)} L${point(right, middle)} L${point(left, bottom)}`
    case '|':
      return `M${point(width / 2, top)} L${point(width / 2, bottom)}`
    case '‖':
      return `M${point(width / 3, top)} L${point(width / 3, bottom)} M${point((2 * width) / 3, top)} L${point((2 * width) / 3, bottom)}`
    case '{': {
      const mid = (left + right) / 2

      return [
        `M${point(right, top)}`,
        `Q${point(mid, top)} ${point(mid, top + height * 0.12)}`,
        `L${point(mid, middle - height * 0.1)}`,
        `Q${point(mid, middle)} ${point(left, middle)}`,
        `Q${point(mid, middle)} ${point(mid, middle + height * 0.1)}`,
        `L${point(mid, bottom - height * 0.12)}`,
        `Q${point(mid, bottom)} ${point(right, bottom)}`
      ].join(' ')
    }
    case '}': {
      const mid = (left + right) / 2

      return [
        `M${point(left, top)}`,
        `Q${point(mid, top)} ${point(mid, top + height * 0.12)}`,
        `L${point(mid, middle - height * 0.1)}`,
        `Q${point(mid, middle)} ${point(right, middle)}`,
        `Q${point(mid, middle)} ${point(mid, middle + height * 0.1)}`,
        `L${point(mid, bottom - height * 0.12)}`,
        `Q${point(mid, bottom)} ${point(left, bottom)}`
      ].join(' ')
    }
    default:
      return null
  }
}

/**
 * A fence round a body whose axis is `axis` from its top and which reaches
 * `below` under it: as tall as the body on both sides of the axis.
 *
 * One line tall, it is the face's own glyph. Taller, the fences the notation
 * uses are drawn to the height; any other character is the glyph set larger,
 * which is the Expo app's way (`GrowingDelimiter`), capped at three times the
 * body size.
 */
function fence(character: string, axis: number, below: number, fontSize: number, measure: MeasureText): MathLayout {
  if (!character) {
    return EMPTY
  }

  const height = 2 * Math.max(axis, below)
  const line = mathLineHeight(fontSize)

  if (height <= line * TALL) {
    return textLine([{ text: character, style: 'roman' }], fontSize, measure)
  }

  const width = Math.round(fontSize * (character === '|' ? 0.35 : 0.5))
  const d = fencePath(character, width, height)

  if (d) {
    const out = box(width, height, height / 2)

    out.strokes.push({ d, width: strokeWidth(fontSize) })

    return out
  }

  const size = Math.max(fontSize, Math.min(Math.round(height * 0.78), fontSize * 3))

  return textLine([{ text: character, style: 'roman' }], size, measure)
}

function fenced(node: Extract<MathNode, { kind: 'fenced' }>, fontSize: number, measure: MeasureText): MathLayout {
  const body = layoutNode(node.body, fontSize, measure)
  const below = body.height - body.axis

  return row([
    fence(node.open, body.axis, below, fontSize, measure),
    body,
    fence(node.close, body.axis, below, fontSize, measure)
  ])
}

/**
 * How one column of a grid lines up: `aligned` alternates right and left, so a
 * derivation lines up on its relation signs; `cases` is flush left; the rest
 * are centred. The Expo app's `alignmentOf`.
 */
export function columnAlignment(
  style: Extract<MathNode, { kind: 'grid' }>['style'],
  column: number
): 'start' | 'end' | 'center' {
  if (style === 'aligned') {
    return column % 2 === 0 ? 'end' : 'start'
  }

  return style === 'cases' ? 'start' : 'center'
}

function grid(node: Extract<MathNode, { kind: 'grid' }>, fontSize: number, measure: MeasureText): MathLayout {
  const line = mathLineHeight(fontSize)
  const rowGap = gridRowGap(fontSize)
  const columnGap = Math.round(fontSize * GRID_COLUMN_GAP[node.style])
  const cells = node.rows.map(cells => cells.map(cell => layoutNode(cell, fontSize, measure)))
  const columns = cells.reduce((most, cellsOfRow) => Math.max(most, cellsOfRow.length), 0)
  const widths = Array.from({ length: columns }, (_unused, column) =>
    cells.reduce((widest, cellsOfRow) => Math.max(widest, cellsOfRow[column]?.width ?? 0), 0)
  )
  // Each row is as tall as its tallest cell and at least a line; its cells line up on one axis.
  const rows = cells.map(cellsOfRow => {
    const axis = Math.max(line / 2, ...cellsOfRow.map(cell => cell.axis))
    const below = Math.max(line / 2, ...cellsOfRow.map(cell => cell.height - cell.axis))

    return { axis, height: axis + below }
  })
  const pad = 2
  const innerWidth = widths.reduce((sum, width) => sum + width, 0) + columnGap * Math.max(0, columns - 1)
  const total = rows.reduce((sum, entry) => sum + entry.height, 0) + rowGap * Math.max(0, rows.length - 1)
  const body = box(innerWidth + 2 * pad, total, total / 2)
  let y = 0

  cells.forEach((cellsOfRow, rowIndex) => {
    const entry = rows[rowIndex] as { axis: number; height: number }
    let x = pad

    widths.forEach((width, column) => {
      const cell = cellsOfRow[column]

      if (cell) {
        const align = columnAlignment(node.style, column)
        const dx = align === 'start' ? 0 : align === 'end' ? width - cell.width : (width - cell.width) / 2

        place(body, cell, x + dx, y + entry.axis - cell.axis)
      }

      x += width + columnGap
    })

    y += entry.height + rowGap
  })

  return row([
    fence(node.open, body.axis, body.axis, fontSize, measure),
    body,
    fence(node.close, body.axis, body.axis, fontSize, measure)
  ])
}

function scripted(node: Extract<MathNode, { kind: 'scripts' }>, fontSize: number, measure: MeasureText): MathLayout {
  const base = layoutNode(node.base, fontSize, measure)
  const scriptSize = Math.round(fontSize * SCRIPT_SCALE)
  const sup = node.sup ? layoutNode(node.sup, scriptSize, measure) : EMPTY
  const sub = node.sub ? layoutNode(node.sub, scriptSize, measure) : EMPTY
  // The scripts hang at the top and the foot of the base, as a typesetter hangs them on a tall atom.
  const height = Math.max(base.height, sup.height + sub.height)
  const out = box(base.width + 1 + Math.max(sup.width, sub.width), height, base.axis)

  place(out, base, 0, 0)
  place(out, sup, base.width + 1, 0)
  place(out, sub, base.width + 1, height - sub.height)

  return out
}

function layoutBox(node: MathNode, fontSize: number, measure: MeasureText): MathLayout {
  switch (node.kind) {
    case 'frac':
      return fraction(node, fontSize, measure)
    case 'sqrt':
      return root(node, fontSize, measure)
    case 'operator':
      return operator(node, fontSize, measure)
    case 'fenced':
      return fenced(node, fontSize, measure)
    case 'grid':
      return grid(node, fontSize, measure)
    case 'scripts':
      return scripted(node, fontSize, measure)
    default:
      return linear([node], fontSize, measure)
  }
}

/**
 * One sub-tree: text where it can be, boxes where it must. Neighbouring
 * one-dimensional nodes are one line of text, so `2x + 1` beside a fraction is
 * one run and not five.
 */
export function layoutNode(node: MathNode, fontSize: number, measure: MeasureText): MathLayout {
  const items = node.kind === 'row' ? node.items : [node]

  if (!items.some(containsTwoDimensional)) {
    return linear(items, fontSize, measure)
  }

  const parts: MathLayout[] = []
  let pending: MathNode[] = []

  for (const item of items) {
    if (isTwoDimensional(item)) {
      parts.push(linear(pending, fontSize, measure), layoutBox(item, fontSize, measure))
      pending = []
    } else {
      pending.push(item)
    }
  }

  parts.push(linear(pending, fontSize, measure))

  return row(parts)
}

/**
 * A whole expression, with `margin` of air round it so an italic's overhang
 * and a stroke's half width stay inside the drawing.
 */
export function layoutMath(node: MathNode, fontSize: number, measure: MeasureText, margin = 2): MathLayout {
  const inner = layoutNode(node, fontSize, measure)
  const out = box(r(inner.width + 2 * margin), r(inner.height + 2 * margin), inner.axis + margin)

  place(out, inner, margin, margin)
  out.texts.forEach(text => {
    text.x = r(text.x)
    text.y = r(text.y)
  })
  out.rules.forEach(rule => {
    rule.x = r(rule.x)
    rule.y = r(rule.y)
    rule.width = r(rule.width)
  })

  return out
}

/**
 * A measure with no font: one advance per character. What a test lays out
 * with, and what the renderer falls back on where the browser has no canvas.
 */
export const estimateText: MeasureText = (text, _style, size) => [...text].length * size * 0.55
