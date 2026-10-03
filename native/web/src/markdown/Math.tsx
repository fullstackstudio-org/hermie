/**
 * Mathematics: `$$…$$` as an SVG drawing, `$…$` as text in the sentence.
 *
 * A lazy chunk (`lazy.ts`). The parser is the package's (`parseMath`, a LaTeX
 * subset that answers `null` for anything it does not cover), the layout is
 * `math-layout.ts`, and what reaches the DOM is SVG elements made here: `text`
 * and `tspan` whose characters are React text children, `rect` and `path` whose
 * attributes are numbers. No KaTeX, no MathJax, no markup from anywhere.
 *
 * Both follow the Expo app (`expo/hermie/src/markdown/math/Math.tsx`):
 *
 *  - Block math is drawn, centred, in the code block's box, with a "Show source"
 *    toggle and a copy button; its text alternative is the LaTeX source.
 *    Source the parser declines is shown as the source, which is honest and
 *    copyable, never as a guess.
 *  - Inline math is runs of text inside the sentence (`mathRuns`: Unicode scripts
 *    where Unicode has them), so it wraps and sits on the line like the words
 *    around it. An expression with rows in it (a matrix, `cases`) has no honest
 *    one-line form and is shown as its source in a code chip.
 */
import { containsGrid, mathRuns, type MathRun } from '@hermie/markdown/math/linear'
import { parseMath, type MathStyle } from '@hermie/markdown/math/parse'
import { memo, useMemo } from 'react'

import { CodeBlock } from './CodeBlock'
import { estimateText, layoutMath, type MathLayout, type MeasureText } from './math-layout'

/** The label a math block carries in its corner. */
export const MATH_LABEL = 'LaTeX'

/**
 * The faces mathematics is set in. The drawing names them in its own
 * `font-family` attribute and the measure below asks the canvas with the same
 * string, so the widths the layout uses are the widths the browser draws.
 */
export const MATH_FONT =
  "'STIX Two Math', 'STIX Two Text', 'Cambria Math', 'Latin Modern Math', 'Times New Roman', serif"

/** The faces `\texttt` is set in. */
export const MATH_MONO_FONT = "ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace"

/** The size a drawing is laid out at; its width and height are given in em of the text round it. */
const LAYOUT_SIZE = 16

function canvasFont(style: MathStyle, size: number): string {
  const family = style === 'mono' ? MATH_MONO_FONT : MATH_FONT
  const slant = style === 'italic' ? 'italic ' : ''
  const weight = style === 'bold' ? '700 ' : ''

  return `${slant}${weight}${size}px ${family}`
}

let measurer: MeasureText | undefined

/**
 * The browser's own advance for a run, from an offscreen canvas, remembered per
 * run. Where there is no canvas (a test's simulated document) the estimate is
 * used instead, which draws the same shapes a little looser.
 */
function measureText(): MeasureText {
  if (measurer) {
    return measurer
  }

  const context = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(1, 1).getContext('2d') : null

  if (!context) {
    measurer = estimateText

    return measurer
  }

  const cache = new Map<string, number>()

  measurer = (text, style, size) => {
    const key = `${style}|${size}|${text}`
    let width = cache.get(key)

    if (width === undefined) {
      context.font = canvasFont(style, size)
      width = context.measureText(text).width
      cache.set(key, width)
    }

    return width
  }

  return measurer
}

function runAttributes(style: MathStyle) {
  switch (style) {
    case 'italic':
      return { fontStyle: 'italic' }
    case 'bold':
      return { fontWeight: 700 }
    case 'mono':
      return { fontFamily: MATH_MONO_FONT }
    default:
      return {}
  }
}

/** The drawing of a laid-out expression. Every coordinate is a number from the layout. */
export function MathDrawing({ layout, label }: { layout: MathLayout; label: string }) {
  return (
    <svg
      aria-label={label}
      className="md-math-drawing"
      fill="currentColor"
      fontFamily={MATH_FONT}
      height={`${layout.height / LAYOUT_SIZE}em`}
      role="img"
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      width={`${layout.width / LAYOUT_SIZE}em`}
    >
      {layout.rules.map((rule, index) => (
        <rect height={rule.height} key={`rule-${index}`} width={rule.width} x={rule.x} y={rule.y} />
      ))}
      {layout.strokes.map((stroke, index) => (
        <path
          d={stroke.d}
          fill="none"
          key={`stroke-${index}`}
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={stroke.width}
        />
      ))}
      {layout.texts.map((text, index) => (
        <text fontSize={text.size} key={`text-${index}`} x={text.x} y={text.y}>
          {text.runs.map((run, at) => (
            <tspan key={at} {...runAttributes(run.style)}>
              {run.text}
            </tspan>
          ))}
        </text>
      ))}
    </svg>
  )
}

function BlockMathView({ source }: { source: string }) {
  const code = source.trim()
  const layout = useMemo(() => {
    const node = parseMath(code)

    return node ? layoutMath(node, LAYOUT_SIZE, measureText()) : null
  }, [code])

  return (
    <CodeBlock
      code={code}
      kind="math"
      label={MATH_LABEL}
      {...(layout ? { drawing: <MathDrawing label={code} layout={layout} /> } : {})}
    />
  )
}

/** `$$…$$`, drawn; the source when it cannot be. */
export const BlockMath = memo(BlockMathView)

/** The runs of `$…$`, or `null` when it is shown as its source. */
export function inlineMathRuns(source: string): MathRun[] | null {
  const node = parseMath(source)

  return node && !containsGrid(node) ? mathRuns(node) : null
}

function InlineMathView({ source }: { source: string }) {
  const runs = useMemo(() => inlineMathRuns(source), [source])

  if (!runs) {
    return (
      <code className="md-code-inline md-math" data-math="">
        {source}
      </code>
    )
  }

  return (
    <span aria-label={source} className="md-math-inline" role="math">
      {runs.map((run, index) => (
        <span className={`md-math-${run.style}`} key={index}>
          {run.text}
        </span>
      ))}
    </span>
  )
}

/** `$…$`, as text in the sentence; the source in a code chip when it cannot be. */
export const InlineMath = memo(InlineMathView)
