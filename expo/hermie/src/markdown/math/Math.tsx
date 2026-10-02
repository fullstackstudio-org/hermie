/**
 * Drawing a parsed expression.
 *
 * Two surfaces, one notation. Inline math is runs inside the sentence's own
 * `Text` (`linear.ts` says why it can be nothing else); block math is the same
 * runs, with boxes for the four constructs that genuinely need a second dimension
 * — a fraction, a root, a big operator's limits, and a grid of cells, which is
 * every environment from `pmatrix` to `cases`.
 *
 * ## Every height here is arithmetic on the font size
 *
 * Nothing measures, nothing loads and nothing settles a frame later. That is the
 * requirement rather than an optimisation: a row on an INVERTED list that grows
 * after it is laid out moves the reader by exactly the growth, which is the
 * displacement `docs/platform-notes.md` measured for `Show more`. A fraction is
 * two leadings and a rule tall the moment it mounts, and stays that tall.
 *
 * ## The theme, not a palette
 *
 * Ink is `context.textColor` and the rules are `context.textColor` too rather
 * than the hairline: a fraction bar that is a border colour disappears against a
 * dark bubble, and the bar is part of the notation rather than part of the
 * furniture. Nothing here carries a colour of its own, so dark mode is whatever
 * the surrounding bubble already decided.
 */
import { Text, View } from 'react-native'

import { CodeBlock } from '../CodeBlock'
import { MONOSPACE, type MarkdownContext } from '../context'
import { containsGrid, mathRuns, type MathRun } from './linear'
import {
  FRACTION_GAP,
  GRID_COLUMN_GAP,
  gridColumns,
  gridHeights,
  gridRowGap,
  mathHeight,
  mathLineHeight,
  OPERATOR_SCALE,
  ROOT_GAP,
  RULE,
  SCRIPT_SCALE
} from './metrics'
import { parseMath, type MathNode, type MathStyle } from './parse'

/** The info string a fenced fallback carries, so the block says what it is. */
export const MATH_LANGUAGE = 'latex'

function textStyle(style: MathStyle, fontSize: number, color: string) {
  return {
    color,
    fontSize,
    ...(style === 'bold' ? { fontWeight: '700' as const } : {}),
    ...(style === 'italic' ? { fontStyle: 'italic' as const } : {}),
    ...(style === 'mono' ? { fontFamily: MONOSPACE } : {})
  }
}

/**
 * A row of runs as nested `Text`.
 *
 * One outer `Text` with the runs inside it, so a long expression wraps with the
 * sentence rather than becoming its own box — which is the same reason
 * `Inline.tsx` nests everything.
 */
export function MathRunsText({
  runs,
  context,
  fontSize
}: {
  runs: readonly MathRun[]
  context: MarkdownContext
  fontSize: number
}) {
  return (
    <>
      {runs.map((run, index) => (
        <Text key={index} style={textStyle(run.style, fontSize, context.textColor)}>
          {run.text}
        </Text>
      ))}
    </>
  )
}

/**
 * Whether a node is one the block renderer opens out into boxes.
 *
 * A `scripts` node is two-dimensional only when its BASE is. `x^2` stays on one
 * line with a Unicode superscript, which is correct at any size and cannot be
 * misread — but `\left( \frac{1}{n} \right)^n` has a fraction inside the fence,
 * and setting the whole thing on one line turns a stacked fraction into `1/n`
 * because one script was hanging off it.
 */
function isTwoDimensional(node: MathNode): boolean {
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
  if (node.kind === 'row') {
    return node.items.some(containsTwoDimensional)
  }

  return isTwoDimensional(node)
}

/**
 * A run of one-dimensional nodes, drawn as text.
 *
 * Grouped rather than emitted one at a time so that `2x + 1` is one `Text` and
 * therefore one line-breaking run: a `View` per atom in a flex row would let a
 * break land between the `2` and the `x`.
 */
function LinearSpan({ nodes, context, fontSize }: { nodes: MathNode[]; context: MarkdownContext; fontSize: number }) {
  const runs = mathRuns({ kind: 'row', items: nodes })

  if (!runs.length) {
    return null
  }

  return (
    <Text selectable={context.selectable} style={{ lineHeight: mathLineHeight(fontSize) }}>
      <MathRunsText context={context} fontSize={fontSize} runs={runs} />
    </Text>
  )
}

function Fraction({ node, context, fontSize }: { node: MathNode; context: MarkdownContext; fontSize: number }) {
  if (node.kind !== 'frac') {
    return null
  }

  const gap = Math.round(fontSize * FRACTION_GAP)

  return (
    <View style={{ alignItems: 'center', paddingHorizontal: 2 }}>
      <View style={{ alignItems: 'center', paddingBottom: gap }}>
        <MathLayout context={context} fontSize={fontSize} node={node.numerator} />
      </View>
      {/*
        The bar spans the wider of the two sides, which `alignSelf: 'stretch'`
        gets for free from the column's own width — and costs no measurement.
      */}
      <View style={{ alignSelf: 'stretch', backgroundColor: context.textColor, height: RULE }} />
      <View style={{ alignItems: 'center', paddingTop: gap }}>
        <MathLayout context={context} fontSize={fontSize} node={node.denominator} />
      </View>
    </View>
  )
}

function Root({ node, context, fontSize }: { node: MathNode; context: MarkdownContext; fontSize: number }) {
  if (node.kind !== 'sqrt') {
    return null
  }

  const gap = Math.round(fontSize * ROOT_GAP)

  return (
    <View style={{ alignItems: 'flex-end', flexDirection: 'row' }}>
      {node.index ? (
        <View style={{ paddingBottom: Math.round(fontSize * 0.5) }}>
          <MathLayout context={context} fontSize={Math.round(fontSize * SCRIPT_SCALE)} node={node.index} />
        </View>
      ) : null}
      {/*
        The radical sign is a character and the overline is a border, because a
        `√` that had to stretch over two lines of a nested fraction would need a
        drawn path and a measurement — and the border already grows with
        whatever it sits over.
      */}
      <Text selectable={context.selectable} style={textStyle('roman', fontSize, context.textColor)}>
        {'√'}
      </Text>
      <View
        style={{
          borderTopColor: context.textColor,
          borderTopWidth: RULE,
          paddingHorizontal: 3,
          paddingTop: gap
        }}
      >
        <MathLayout context={context} fontSize={fontSize} node={node.radicand} />
      </View>
    </View>
  )
}

function BigOperator({ node, context, fontSize }: { node: MathNode; context: MarkdownContext; fontSize: number }) {
  if (node.kind !== 'operator') {
    return null
  }

  const limitSize = Math.round(fontSize * SCRIPT_SCALE)
  // Big enough to read as an operator rather than as a letter, which is what
  // the display style of every typesetter does with these.
  const symbolSize = Math.round(fontSize * OPERATOR_SCALE)

  return (
    <View style={{ alignItems: 'center', paddingHorizontal: 3 }}>
      {node.upper ? <MathLayout context={context} fontSize={limitSize} node={node.upper} /> : null}
      <Text selectable={context.selectable} style={textStyle('roman', symbolSize, context.textColor)}>
        {node.symbol}
      </Text>
      {node.lower ? <MathLayout context={context} fontSize={limitSize} node={node.lower} /> : null}
    </View>
  )
}

/**
 * A fence set at the size of what it encloses.
 *
 * A `(` drawn at the body's own font size beside a two-line matrix is a comma with
 * ambitions, and a fence that does not reach round its contents reads as a
 * different expression. A typesetter answers this by picking a bigger glyph from a
 * font built for it; without those fonts (ADR-0020) the same glyph is simply set
 * larger, which is the same idea with one face instead of four.
 *
 * The size is arithmetic on the height the caller already computed, so nothing is
 * measured and nothing settles late. It is capped, because a sixteen-row matrix
 * would otherwise be fenced by a bracket taller than the bubble — and past a few
 * rows a taller glyph stops adding anything a reader can use.
 */
function GrowingDelimiter({
  character,
  height,
  context,
  fontSize
}: {
  character: string
  height: number
  context: MarkdownContext
  fontSize: number
}) {
  if (!character) {
    return null
  }

  const size = Math.min(Math.round(height * 0.78), fontSize * 3)

  return (
    <Text selectable={context.selectable} style={textStyle('roman', Math.max(fontSize, size), context.textColor)}>
      {character}
    </Text>
  )
}

/**
 * A grid: every environment, and a bare line break.
 *
 * Laid out as a row of COLUMNS rather than a column of rows, which is the one
 * decision in this file worth arguing: a column sized by its own content is
 * exactly as wide as its widest cell, for free and without measuring anything, and
 * that is what makes a matrix's columns line up. The cost is that rows then have
 * to be made to agree, which is why each cell is given its row's computed height —
 * `metrics.ts` has the arithmetic and the reason.
 */
function Grid({ node, context, fontSize }: { node: MathNode; context: MarkdownContext; fontSize: number }) {
  if (node.kind !== 'grid') {
    return null
  }

  const { rows: rowHeights, total } = gridHeights(node, fontSize)
  const rowGap = gridRowGap(fontSize)
  const columnGap = Math.round(fontSize * GRID_COLUMN_GAP[node.style])
  const columns = gridColumns(node)

  return (
    <View style={{ alignItems: 'center', flexDirection: 'row' }}>
      <GrowingDelimiter character={node.open} context={context} fontSize={fontSize} height={total} />
      <View style={{ flexDirection: 'row', paddingHorizontal: 2 }}>
        {Array.from({ length: columns }, (_unused, column) => (
          <View
            key={column}
            style={{ alignItems: alignmentOf(node.style, column), marginLeft: column ? columnGap : 0 }}
          >
            {node.rows.map((cells, row) => (
              <View
                key={row}
                style={{
                  height: rowHeights[row],
                  justifyContent: 'center',
                  marginTop: row ? rowGap : 0
                }}
              >
                {cells[column] ? <MathLayout context={context} fontSize={fontSize} node={cells[column]!} /> : null}
              </View>
            ))}
          </View>
        ))}
      </View>
      <GrowingDelimiter character={node.close} context={context} fontSize={fontSize} height={total} />
    </View>
  )
}

/**
 * How one column of a grid lines up.
 *
 * `aligned` is LaTeX's own rule and the only one that is not uniform: the column
 * before each `&` is set flush right and the one after it flush left, so a
 * derivation lines up on its relation signs. `cases` is flush left throughout,
 * because its second column is a condition and a ragged left edge there reads as
 * a second expression.
 */
function alignmentOf(style: Extract<MathNode, { kind: 'grid' }>['style'], column: number) {
  if (style === 'aligned') {
    return column % 2 === 0 ? 'flex-end' : 'flex-start'
  }

  return style === 'cases' ? 'flex-start' : 'center'
}

/**
 * A box with scripts hanging off it.
 *
 * Only ever reached when the base needs boxes of its own — everything else is set
 * on one line, where a superscript is a Unicode character rather than a smaller
 * run (see `linear.ts`). The scripts are a column beside the base: the row
 * stretches it to the base's height, so the superscript sits at the top of the
 * fence it belongs to and the subscript at the foot, which is where a typesetter
 * puts them on a tall atom.
 */
function Scripted({ node, context, fontSize }: { node: MathNode; context: MarkdownContext; fontSize: number }) {
  if (node.kind !== 'scripts') {
    return null
  }

  const scriptSize = Math.round(fontSize * SCRIPT_SCALE)
  const justify = node.sup && node.sub ? 'space-between' : node.sup ? 'flex-start' : 'flex-end'

  return (
    <View style={{ alignItems: 'stretch', flexDirection: 'row' }}>
      <MathLayout context={context} fontSize={fontSize} node={node.base} />
      <View style={{ justifyContent: justify, paddingLeft: 1 }}>
        {node.sup ? <MathLayout context={context} fontSize={scriptSize} node={node.sup} /> : null}
        {node.sub ? <MathLayout context={context} fontSize={scriptSize} node={node.sub} /> : null}
      </View>
    </View>
  )
}

function Fenced({ node, context, fontSize }: { node: MathNode; context: MarkdownContext; fontSize: number }) {
  if (node.kind !== 'fenced') {
    return null
  }

  // The fence grows with its contents, which for a single line is the same size
  // it has always been drawn at.
  const height = mathHeight(node.body, fontSize)

  return (
    <View style={{ alignItems: 'center', flexDirection: 'row' }}>
      <GrowingDelimiter character={node.open} context={context} fontSize={fontSize} height={height} />
      <MathLayout context={context} fontSize={fontSize} node={node.body} />
      <GrowingDelimiter character={node.close} context={context} fontSize={fontSize} height={height} />
    </View>
  )
}

/**
 * One sub-tree, as boxes where it needs them and as text where it does not.
 *
 * `alignItems: 'center'` is the axis rule: a fraction beside a variable lines up
 * on the middle of the bar, which is where every typesetter puts the maths axis,
 * and getting it from flexbox costs nothing and cannot drift.
 */
export function MathLayout({
  node,
  context,
  fontSize
}: {
  node: MathNode
  context: MarkdownContext
  fontSize: number
}) {
  const items = node.kind === 'row' ? node.items : [node]

  if (!items.some(containsTwoDimensional)) {
    return <LinearSpan context={context} fontSize={fontSize} nodes={items} />
  }

  // Adjacent one-dimensional nodes are collected into one span before the next
  // box, so line breaking still happens between words rather than between atoms.
  const groups: { boxes: MathNode | null; linear: MathNode[] }[] = []
  let pending: MathNode[] = []

  for (const item of items) {
    if (isTwoDimensional(item)) {
      groups.push({ boxes: item, linear: pending })
      pending = []

      continue
    }

    pending.push(item)
  }

  if (pending.length) {
    groups.push({ boxes: null, linear: pending })
  }

  return (
    <View style={{ alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap' }}>
      {groups.map((group, index) => (
        <View key={index} style={{ alignItems: 'center', flexDirection: 'row' }}>
          {group.linear.length ? <LinearSpan context={context} fontSize={fontSize} nodes={group.linear} /> : null}
          {group.boxes ? <Box context={context} fontSize={fontSize} node={group.boxes} /> : null}
        </View>
      ))}
    </View>
  )
}

function Box({ node, context, fontSize }: { node: MathNode; context: MarkdownContext; fontSize: number }) {
  switch (node.kind) {
    case 'frac':
      return <Fraction context={context} fontSize={fontSize} node={node} />

    case 'sqrt':
      return <Root context={context} fontSize={fontSize} node={node} />

    case 'operator':
      return <BigOperator context={context} fontSize={fontSize} node={node} />

    case 'fenced':
      return <Fenced context={context} fontSize={fontSize} node={node} />

    case 'grid':
      return <Grid context={context} fontSize={fontSize} node={node} />

    case 'scripts':
      return <Scripted context={context} fontSize={fontSize} node={node} />

    default:
      return <LinearSpan context={context} fontSize={fontSize} nodes={[node]} />
  }
}

/**
 * `$$…$$` — one expression on its own, centred.
 *
 * A failure is the SOURCE in a code block, never a blank and never a guess. The
 * reader gets what the model wrote, in a box they can already copy out of.
 */
export function BlockMath({ source, context }: { source: string; context: MarkdownContext }) {
  const node = parseMath(source)

  if (!node) {
    return <CodeBlock code={source.trim()} context={context} language={MATH_LANGUAGE} />
  }

  return (
    <View style={{ alignItems: 'center', marginVertical: 8, width: '100%' }} testID="markdown-math-block">
      <MathLayout context={context} fontSize={context.fontSize} node={node} />
    </View>
  )
}

/**
 * The runs for `$…$`, or `null` when the expression cannot be drawn.
 *
 * Runs rather than an element, because the caller is inside a `Text` and has to
 * nest them itself — and because the fallback it chooses is a code chip, which
 * is its own construct and not this module's business.
 */
export function inlineMathRuns(source: string): MathRun[] | null {
  const node = parseMath(source)

  // A matrix, a `cases` block or an aligned derivation is ROWS, and an inline
  // expression has no second dimension to put them in — see `containsGrid`. The
  // caller's fallback is the LaTeX in a code chip, which says what the model wrote
  // rather than inventing a one-line notation for it.
  if (!node || containsGrid(node)) {
    return null
  }

  return mathRuns(node)
}
