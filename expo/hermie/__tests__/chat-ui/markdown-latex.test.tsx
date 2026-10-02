/**
 * The LaTeX a reply actually contains, and the four ways it used to be lost.
 *
 * Each `describe` below is one of them, and each was a real failure rather than a
 * gap somebody imagined:
 *
 *  - `\(…\)` and `\[…\]` were not delimiters at all, so the markdown lexer read
 *    the backslashes as ESCAPES and printed `(E = mc^2)` with the mathematics set
 *    as prose — which is worse than printing the source, because it looks
 *    deliberate;
 *  - `\left( … \right)` never parsed. The row parser consumed the `\right` and
 *    then refused it, so every expression with a growing fence in it — which is
 *    most of them — fell back to a listing;
 *  - the environments (`pmatrix`, `cases`, `aligned`) and the `&` and `\\` that
 *    give them their shape were outside the subset;
 *  - a bare `\\` refused the whole expression, so `x = 1 \\ y = 2` was a listing.
 *
 * And the fifth test in each: what must STILL fall back. A subset is only
 * acceptable because the source is shown when it ends, so `array` and a
 * half-streamed environment are asserted as carefully as the things that draw.
 */
import { render, screen } from '@testing-library/react-native'

import { Markdown } from '../../src/markdown/Markdown'
import { resetBlockCache } from '../../src/markdown/blocks'
import { marked } from '../../src/markdown/marked-compat'
import { containsGrid, mathRuns, mathToPlainText } from '../../src/markdown/math/linear'
import { gridHeights, mathHeight } from '../../src/markdown/math/metrics'
import { parseMath, type MathNode } from '../../src/markdown/math/parse'
import { ThemeProvider } from '../../src/ui/theme'

function draw(text: string) {
  return render(
    <ThemeProvider>
      <Markdown maxContentWidth={320} text={text} />
    </ThemeProvider>
  )
}

/** The inline tokens of the first paragraph, which is where a `\(…\)` lands. */
function inlineTypes(text: string): string[] {
  const tokens = marked.lexer(text)
  const paragraph = tokens[0] as { tokens?: { type: string }[] }

  return (paragraph.tokens ?? []).map(token => token.type)
}

/**
 * The one grid in an expression.
 *
 * An environment inside a line arrives wrapped in the row that line is, and a
 * whole expression that IS a grid does not — so the helper unwraps a row with one
 * item rather than every test knowing which shape it asked for.
 */
function grid(source: string): Extract<MathNode, { kind: 'grid' }> {
  const node = parseMath(source)

  expect(node).not.toBeNull()

  const found = node!.kind === 'row' ? node!.items.find(item => item.kind === 'grid') : node

  expect(found?.kind).toBe('grid')

  return found as Extract<MathNode, { kind: 'grid' }>
}

describe('the backslash delimiters', () => {
  beforeEach(resetBlockCache)

  it('reads an inline expression written with parentheses', () => {
    expect(inlineTypes('Einstein wrote \\(E = mc^2\\) on a board.\n')).toContain('mathInline')

    draw('Einstein wrote \\(E = mc^2\\) on a board.\n')

    // `mc` is one italic run and the `2` is a real superscript character, which
    // is what says the expression was drawn rather than escaped into prose.
    expect(screen.getByText('mc')).toBeTruthy()
    expect(screen.getByText('²')).toBeTruthy()
  })

  it('keeps the spaces the dollar form refuses', () => {
    // `$ x $` is not an expression, because `$` is money more often than it is
    // mathematics. `\( x \)` has no such twin, and the spaced form is how half of
    // all real LaTeX is written.
    expect(inlineTypes('the value \\( x^2 \\) grows\n')).toContain('mathInline')
    expect(inlineTypes('the value $ x^2 $ grows\n')).not.toContain('mathInline')
  })

  it('reads a display expression written with brackets', () => {
    draw('The energy:\n\n\\[\nE = mc^2\n\\]\n')

    expect(screen.getByTestId('markdown-math-block')).toBeTruthy()
    expect(screen.getByText('mc')).toBeTruthy()
  })

  it('leaves a price and a code span alone', () => {
    expect(inlineTypes('It costs $5 and $7 today.\n')).not.toContain('mathInline')
    expect(inlineTypes('call `\\(x\\)` here\n')).not.toContain('mathInline')
  })

  it('declines a fence with nothing in it, which is what the first flush is', () => {
    expect(inlineTypes('half an expression \\( \n')).not.toContain('mathInline')
    expect(marked.lexer('\\[\n').every(token => token.type !== 'mathBlock')).toBe(true)
  })
})

describe('a growing fence', () => {
  it('parses `\\left( … \\right)` with a script hanging off it', () => {
    const node = parseMath('\\left( 1 + \\frac{1}{n} \\right)^n')

    expect(node).not.toBeNull()

    const items = (node as Extract<MathNode, { kind: 'row' }>).items

    expect(items).toHaveLength(1)
    expect(items[0]!.kind).toBe('scripts')

    const scripts = items[0] as Extract<MathNode, { kind: 'scripts' }>

    expect(scripts.base.kind).toBe('fenced')
    // A single-character script needs no group, so it arrives as the run itself.
    expect(scripts.sup).toEqual({ kind: 'run', style: 'italic', text: 'n' })
  })

  it('parses every delimiter pair a model reaches for', () => {
    for (const source of [
      '\\left( x \\right)',
      '\\left[ x \\right]',
      '\\left\\{ x \\right\\}',
      '\\left| x \\right|',
      '\\left\\langle x \\right\\rangle',
      '\\left. x \\right)'
    ]) {
      expect(parseMath(source)).not.toBeNull()
    }
  })

  it('still refuses a fence with no partner, and a plain bracket still works', () => {
    expect(parseMath('\\left( x')).toBeNull()
    expect(parseMath('x \\right)')).toBeNull()
    expect(parseMath('(x)')).not.toBeNull()
  })
})

describe('the grid environments', () => {
  beforeEach(resetBlockCache)

  it('reads a 2x2 pmatrix as rows of cells inside round fences', () => {
    const matrix = grid('\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}')

    expect(matrix.open).toBe('(')
    expect(matrix.close).toBe(')')
    expect(matrix.style).toBe('matrix')
    expect(matrix.rows).toHaveLength(2)
    expect(matrix.rows.map(row => row.length)).toEqual([2, 2])
    expect(mathToPlainText(matrix)).toBe('(a b; c d)')
  })

  it('reads the other matrix fences as the brackets they name', () => {
    expect(grid('\\begin{bmatrix} 1 \\\\ 2 \\end{bmatrix}').open).toBe('[')
    expect(grid('\\begin{Bmatrix} 1 \\\\ 2 \\end{Bmatrix}').open).toBe('{')
    expect(grid('\\begin{vmatrix} 1 \\\\ 2 \\end{vmatrix}').open).toBe('|')
    expect(grid('\\begin{matrix} 1 \\\\ 2 \\end{matrix}').open).toBe('')
  })

  it('reads a cases block, and closes its one-sided brace only in text', () => {
    const cases = grid('f(x) = \\begin{cases} x & \\text{if } x > 0 \\\\ 0 & \\text{otherwise} \\end{cases}')

    expect(cases.style).toBe('cases')
    expect(cases.open).toBe('{')
    // Nothing on the right when it is DRAWN — the rows close it off — and a
    // partner when the same expression has to be set on one line.
    expect(cases.close).toBe('')
    expect(mathToPlainText(cases)).toBe('{x if  x > 0; 0 otherwise}')
  })

  it('reads an aligned pair and lines its columns up on the relation', () => {
    const aligned = grid('\\begin{aligned} a &= b + c \\\\ d &= e \\end{aligned}')

    expect(aligned.style).toBe('aligned')
    expect(aligned.rows).toHaveLength(2)
    expect(aligned.rows.map(row => row.length)).toEqual([2, 2])
  })

  it('reads a bare line break as two centred lines', () => {
    const lines = grid('x = 1 \\\\ y = 2')

    expect(lines.style).toBe('gathered')
    expect(lines.rows).toHaveLength(2)
    expect(lines.open).toBe('')
    // A trailing break is a line nobody has written yet, not a blank one.
    expect(grid('x = 1 \\\\ y = 2 \\\\').rows).toHaveLength(2)
  })

  it('gives every row of a grid one height, so the columns agree', () => {
    // The reason this arithmetic exists: a fraction in one cell must not slide
    // the rest of its column past the others. See `metrics.ts`.
    const matrix = grid('\\begin{pmatrix} \\frac{1}{2} & b \\\\ c & d \\end{pmatrix}')
    const { rows, total } = gridHeights(matrix, 17)

    expect(rows).toHaveLength(2)
    expect(rows[0]!).toBeGreaterThan(rows[1]!)
    expect(total).toBeGreaterThan(rows[0]! + rows[1]!)
    expect(mathHeight(matrix, 17)).toBe(total)
  })

  it('draws a matrix as a block and refuses to draw one inside a sentence', () => {
    draw('$$\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}$$\n')

    expect(screen.getByTestId('markdown-math-block')).toBeTruthy()
    expect(screen.getByText('a')).toBeTruthy()
    expect(screen.getByText('d')).toBeTruthy()

    // Inline, the same expression is the SOURCE in a code chip: rows cannot be
    // set inside a sentence, and a one-line notation for them would say
    // something the author did not write.
    expect(containsGrid(parseMath('\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}')!)).toBe(true)
  })

  it('still falls back on an environment outside the subset or one still arriving', () => {
    // `array` carries a column specification this renderer has no drawing for.
    expect(parseMath('\\begin{array}{cc} a & b \\end{array}')).toBeNull()
    // The `\end` has not streamed yet.
    expect(parseMath('\\begin{pmatrix} a & b')).toBeNull()
    expect(parseMath('\\begin{pmatrix} a & b \\\\')).toBeNull()
    // Mismatched fences would draw brackets the author did not ask for.
    expect(parseMath('\\begin{pmatrix} a \\end{bmatrix}')).toBeNull()
    // A line break carrying a measurement: `\\[6pt]` and `\\ [x]` are the same
    // characters, so neither is guessed at.
    expect(parseMath('\\begin{aligned} a \\\\[6pt] b \\end{aligned}')).toBeNull()
    // An alignment tab with no environment to align in.
    expect(parseMath('a & b')).toBeNull()

    draw('$$\\begin{array}{cc} a & b \\end{array}$$\n')

    expect(screen.queryByTestId('markdown-math-block')).toBeNull()
    expect(screen.getByText(/begin\{array\}/u)).toBeTruthy()
  })
})

describe('the two characters typography cares about', () => {
  it('sets a minus as a minus and not as a hyphen', () => {
    // U+2212, which is the width of the plus it pairs with and sits on the same
    // axis. U+002D is what a keyboard has, and beside a word it reads as a
    // hyphen joining two things.
    expect(mathRuns(parseMath('a - b')!)).toEqual([
      { style: 'italic', text: 'a' },
      { style: 'roman', text: ' \u2212 ' },
      { style: 'italic', text: 'b' }
    ])
    expect(mathToPlainText(parseMath('-\\sin\\theta')!)).toContain('\u2212')
    // `\mathrm` sets mathematics upright; it does not stop it being mathematics.
    expect(mathToPlainText(parseMath('\\mathrm{a-b}')!)).toContain('\u2212')
  })

  it('leaves a hyphen inside a text group alone', () => {
    expect(mathToPlainText(parseMath('\\text{well-known}')!)).toBe('well-known')
    expect(mathToPlainText(parseMath('\\text{well-known} - x')!)).toBe('well-known \u2212 x')
    // Nesting: the depth has to come back down again.
    expect(mathToPlainText(parseMath('\\text{a \\textbf{b-c}} - d')!)).toBe('a b-c \u2212 d')
  })

  it('still raises a negative script, because both spellings are in the table', () => {
    expect(mathRuns(parseMath('x^{-1}')!)).toEqual([
      { style: 'italic', text: 'x' },
      { style: 'roman', text: '\u207b\u00b9' }
    ])
  })

  it('puts a thin space between a function name and its argument', () => {
    // U+2009, the same space every `\,`-family command produces.
    expect(mathToPlainText(parseMath('\\cos\\theta')!)).toBe('cos\u2009θ')
    expect(mathToPlainText(parseMath('\\sin x')!)).toBe('sin\u2009x')
    // The space goes after the SCRIPT, or the subscript would be pushed off the
    // name it belongs to.
    expect(mathToPlainText(parseMath('\\log_2 n')!)).toBe('log_2\u2009n')
    // The name and the raised subscript are upright; the variable after them is
    // a variable, so it is its own italic run.
    expect(mathRuns(parseMath('\\log_2 n')!)).toEqual([
      { style: 'roman', text: 'log₂\u2009' },
      { style: 'italic', text: 'n' }
    ])
  })
})

describe('what was already working', () => {
  it('still draws the constructs the first round shipped', () => {
    for (const source of [
      'E = mc^2',
      '\\frac{a+b}{c}',
      '\\sqrt{x^2 + y^2}',
      '\\sqrt[3]{x}',
      '\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}',
      '\\int_0^\\infty e^{-x} dx = 1',
      '\\text{rate} = \\frac{\\text{hits}}{\\text{total}}',
      '\\alpha + \\beta \\leq \\gamma',
      '\\mathbb{R}^n',
      '\\hat{x} \\cdot \\vec{y}'
    ]) {
      expect(parseMath(source)).not.toBeNull()
    }
  })

  it('still spells a script the superscript block cannot reach', () => {
    expect(mathRuns(parseMath('x^{\\alpha}')!)).toEqual([
      { style: 'italic', text: 'x' },
      { style: 'roman', text: '^α' }
    ])
  })

  it('still answers null on a half-typed expression, whatever the delimiters were', () => {
    expect(parseMath('\\fra')).toBeNull()
    expect(parseMath('x^')).toBeNull()
    expect(parseMath('')).toBeNull()

    // Every prefix of a real expression, because a stream hands the parser one on
    // every flush and none of them may throw.
    const source = '\\left( \\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix} \\right)^{n+1}'

    for (let at = 0; at <= source.length; at += 1) {
      expect(() => parseMath(source.slice(0, at))).not.toThrow()
    }
  })
})
