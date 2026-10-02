/**
 * How tall a drawn expression is, before it is drawn.
 *
 * ## Why this exists at all, when flexbox sizes everything else
 *
 * Almost nothing in `Math.tsx` needs a number: a fraction is a column, a root is a
 * row, and flexbox settles both synchronously in the same pass that lays the
 * bubble out — which satisfies ADR-0020, because nothing waits for a font or a
 * measurement.
 *
 * A GRID is the one construct flexbox cannot settle on its own. Its columns have
 * to agree about where each row sits, and a column is a `View` per cell: if one
 * cell in the second column is a fraction and the rest are letters, that column's
 * later rows slide down relative to the first column's, and a matrix whose rows do
 * not line up is not a matrix. So a row's height is computed here and applied to
 * every cell in it, which makes the rows agree by construction.
 *
 * The arithmetic MIRRORS the renderer, and the constants it mirrors live here so
 * there is one copy of each rather than two that drift. Where the estimate is a
 * point or two out, a cell's content is centred in a box slightly the wrong size —
 * which is invisible — rather than a row being in the wrong place, which is not.
 *
 * Pure, and total. No React, no theme, and it never throws.
 */

import type { MathNode } from './parse'

/** A script's size, as a fraction of the size it hangs off. */
export const SCRIPT_SCALE = 0.72

/** How thick a fraction bar and a radical's overline are drawn. */
export const RULE = 1

/** Air above and below a fraction bar, as a fraction of the font size. */
export const FRACTION_GAP = 0.18

/** Air above a radical's contents, as a fraction of the font size. */
export const ROOT_GAP = 0.12

/** How much bigger a big operator's glyph is than the expression around it. */
export const OPERATOR_SCALE = 1.35

/** Between two rows of a grid, as a fraction of the font size. */
export const GRID_ROW_GAP = 0.34

/** Between two columns of a grid, as a fraction of the font size. */
export const GRID_COLUMN_GAP = { aligned: 0.18, cases: 0.9, gathered: 0.5, matrix: 0.62 } as const

/** The leading one line of mathematics is set on. */
export function mathLineHeight(fontSize: number): number {
  return Math.round(fontSize * 1.3)
}

/** Between two rows of a grid, in points. */
export function gridRowGap(fontSize: number): number {
  return Math.round(fontSize * GRID_ROW_GAP)
}

/**
 * How tall one sub-tree is drawn, in points.
 *
 * Every branch is the renderer's own construction read as a sum. A node kind the
 * renderer sets on one line is one line tall, whatever is inside it: a script is
 * raised into the Unicode block rather than into a second row, which is the whole
 * of `linear.ts`.
 */
export function mathHeight(node: MathNode, fontSize: number): number {
  const line = mathLineHeight(fontSize)

  switch (node.kind) {
    case 'run':
    case 'space':
    case 'accent':
      return line

    // A script adds nothing to the height: beside a one-line base it is a
    // Unicode character on that same line, and beside a tall one it is a column
    // the renderer stretches to the base's own height.
    case 'scripts':
      return mathHeight(node.base, fontSize)

    case 'row':
      return node.items.reduce((tallest, item) => Math.max(tallest, mathHeight(item, fontSize)), line)

    case 'fenced':
      return mathHeight(node.body, fontSize)

    case 'frac': {
      const gap = Math.round(fontSize * FRACTION_GAP)

      return mathHeight(node.numerator, fontSize) + gap + RULE + gap + mathHeight(node.denominator, fontSize)
    }

    case 'sqrt':
      return mathHeight(node.radicand, fontSize) + RULE + Math.round(fontSize * ROOT_GAP)

    case 'operator': {
      const limit = Math.round(fontSize * SCRIPT_SCALE)
      const glyph = mathLineHeight(Math.round(fontSize * OPERATOR_SCALE))
      const upper = node.upper ? mathHeight(node.upper, limit) : 0
      const lower = node.lower ? mathHeight(node.lower, limit) : 0

      return upper + glyph + lower
    }

    case 'grid':
      return gridHeights(node, fontSize).total
  }
}

/** A grid's row heights, and the height of the whole thing. */
export function gridHeights(
  node: Extract<MathNode, { kind: 'grid' }>,
  fontSize: number
): { rows: number[]; total: number } {
  const line = mathLineHeight(fontSize)
  const rows = node.rows.map(cells =>
    cells.reduce((tallest, cell) => Math.max(tallest, mathHeight(cell, fontSize)), line)
  )
  const gaps = gridRowGap(fontSize) * Math.max(0, rows.length - 1)

  return { rows, total: rows.reduce((sum, height) => sum + height, 0) + gaps }
}

/** How many columns a grid's widest row has. */
export function gridColumns(node: Extract<MathNode, { kind: 'grid' }>): number {
  return node.rows.reduce((most, cells) => Math.max(most, cells.length), 0)
}
