/**
 * Diagrams and mathematics in a reply, and the four things they must not break.
 *
 * The renderer half is obvious — a `mermaid` fence becomes a picture, `$$…$$`
 * becomes an equation. The rest of this file is the part that is easy to lose:
 *
 *  - a source neither can draw falls back to the fenced LaTeX or the fenced
 *    diagram, never to a blank and never to a guess;
 *  - the selectable flattening (`attributed.ts`) still produces the SOURCE, so a
 *    Mac reader who drags across an equation copies something that pastes back;
 *  - `plainTextBlock`, which the notification preview and Copy text both go
 *    through, is byte-for-byte what it was before any of this existed.
 */
import { render, screen } from '@testing-library/react-native'

import { Markdown } from '../../src/markdown/Markdown'
import { resetBlockCache } from '../../src/markdown/blocks'
import type { MarkdownContext } from '../../src/markdown/context'
import { marked } from '../../src/markdown/marked-compat'
import { runsToPlainText, selectableRuns } from '../../src/markdown/attributed'
import { plainTextBlock, plainTextPreview } from '../../src/markdown/plain-text'
import { parseMath } from '../../src/markdown/math/parse'
import { mathRuns } from '../../src/markdown/math/linear'
import { parseMermaid } from '../../src/markdown/mermaid/parse'
import { layoutMermaid } from '../../src/markdown/mermaid/layout'
import { ThemeProvider } from '../../src/ui/theme'

const CONTEXT: MarkdownContext = {
  blockBackground: '#EEEEEE',
  borderColor: '#DDDDDD',
  color: 'text',
  contentWidth: 320,
  fontSize: 17,
  lineHeight: 25,
  linkColor: '#0063CC',
  mutedColor: 'textMuted',
  mutedTextColor: '#5C5C65',
  onLinkPress: () => undefined,
  scheme: 'light',
  selectable: true,
  textColor: '#17171B'
}

const FLOWCHART = ['```mermaid', 'flowchart TD', '  A[Start] --> B{Ready?}', '  B -->|yes| C[Ship]', '```'].join('\n')

function draw(text: string) {
  return render(
    <ThemeProvider>
      <Markdown maxContentWidth={CONTEXT.contentWidth} text={text} />
    </ThemeProvider>
  )
}

describe('a mermaid fence', () => {
  beforeEach(resetBlockCache)

  it('is drawn as a diagram rather than as a listing', () => {
    draw(FLOWCHART)

    expect(screen.getByTestId('markdown-mermaid')).toBeTruthy()
    // The labels are real text, which is what makes them selectable and
    // readable by a screen reader.
    expect(screen.getByText('Start')).toBeTruthy()
    expect(screen.getByText('Ready?')).toBeTruthy()
    expect(screen.getByText('yes')).toBeTruthy()
  })

  it('places every node and gives the drawing a size before it mounts', () => {
    const graph = parseMermaid('flowchart LR\n  A --> B --> C\n')

    expect(graph).not.toBeNull()

    const layout = layoutMermaid(graph!, 17)

    expect(layout.nodes).toHaveLength(3)
    expect(layout.edges).toHaveLength(2)
    expect(layout.width).toBeGreaterThan(0)
    expect(layout.height).toBeGreaterThan(0)
    // Left to right means the ranks advance on x and share a row.
    const [a, b, c] = layout.nodes

    expect(a!.x).toBeLessThan(b!.x)
    expect(b!.x).toBeLessThan(c!.x)
  })

  it('falls back to the fenced source when the diagram cannot be drawn', () => {
    // A `classDiagram`, which nothing here draws. A `sequenceDiagram` and a `pie`
    // used to be the examples and are now pictures of their own — see
    // `markdown-diagrams.test.tsx`, which pins them and keeps this fallback
    // asserted against a type that is still outside the subset.
    const source = ['```mermaid', 'classDiagram', '  Animal <|-- Duck', '```'].join('\n')

    draw(source)

    expect(screen.queryByTestId('markdown-mermaid')).toBeNull()
    expect(screen.getByText('classDiagram')).toBeTruthy()
  })

  it('refuses a statement it would have to ignore rather than drawing a partial picture', () => {
    expect(parseMermaid('flowchart TD\n  subgraph one\n  A --> B\n  end\n')).toBeNull()
    expect(parseMermaid('flowchart TD\n  A --> B\n  style A fill:#f9f\n')).toBeNull()
    // A fence that has only half arrived, which every flush of a stream carries.
    expect(parseMermaid('flowchart TD\n  A[Start] -->')).toBeNull()
  })
})

describe('mathematics', () => {
  beforeEach(resetBlockCache)

  it('renders a displayed equation as its own block', () => {
    draw('Einstein wrote:\n\n$$E = mc^2$$\n')

    expect(screen.getByTestId('markdown-math-block')).toBeTruthy()
    // Variables are italic and the rest is upright, so the expression arrives as
    // separate runs — and `^2` is a superscript character rather than a caret.
    expect(screen.getByText('mc')).toBeTruthy()
    expect(screen.getByText('²')).toBeTruthy()
  })

  it('renders an inline expression inside the sentence', () => {
    draw('The term $x_i^2$ dominates.\n')

    expect(screen.queryByTestId('markdown-math-block')).toBeNull()
    expect(screen.getByText('ᵢ²')).toBeTruthy()
  })

  it('survives inside a list item', () => {
    draw('- first, where $a_1$ holds\n- second\n')

    expect(screen.getByText('₁')).toBeTruthy()
    expect(screen.getByText('second')).toBeTruthy()
  })

  it('lays a fraction out in two dimensions and a script in one', () => {
    const fraction = parseMath('\\frac{a}{b}')

    expect(fraction).toEqual({
      items: [
        {
          denominator: { items: [{ kind: 'run', style: 'italic', text: 'b' }], kind: 'row' },
          kind: 'frac',
          numerator: { items: [{ kind: 'run', style: 'italic', text: 'a' }], kind: 'row' }
        }
      ],
      kind: 'row'
    })

    expect(mathRuns(parseMath('x^{n+1}')!)).toEqual([
      { style: 'italic', text: 'x' },
      { style: 'roman', text: 'ⁿ⁺¹' }
    ])
  })

  it('spells a script the superscript block cannot reach rather than raising half of it', () => {
    expect(mathRuns(parseMath('x^{\\alpha}')!)).toEqual([
      { style: 'italic', text: 'x' },
      { style: 'roman', text: '^α' }
    ])
  })

  it('falls back to the source when an expression cannot be drawn', () => {
    // `array` carries a column specification this renderer has no drawing for.
    // The matrix environments themselves ARE drawn now — see
    // `markdown-latex.test.tsx` — so the fallback is asserted against the one
    // environment that is still outside the subset.
    expect(parseMath('\\begin{array}{cc} a & b \\end{array}')).toBeNull()
    // A half-typed command, which a streaming reply produces constantly.
    expect(parseMath('\\fra')).toBeNull()
    expect(parseMath('x^')).toBeNull()

    draw('$$\\begin{array}{cc} a \\end{array}$$\n')

    expect(screen.queryByTestId('markdown-math-block')).toBeNull()
    expect(screen.getByText(/begin\{array\}/u)).toBeTruthy()
  })

  it('leaves a price alone', () => {
    const tokens = marked.lexer('It costs $5 and $7 today.\n')
    const paragraph = tokens[0] as { tokens?: { type: string }[] }

    expect(paragraph.tokens?.every(token => token.type !== 'mathInline')).toBe(true)
  })

  it('leaves an expression inside a code span alone', () => {
    const tokens = marked.lexer('call `$x$` here\n')
    const paragraph = tokens[0] as { tokens?: { type: string }[] }

    expect(paragraph.tokens?.some(token => token.type === 'codespan')).toBe(true)
    expect(paragraph.tokens?.every(token => token.type !== 'mathInline')).toBe(true)
  })
})

describe('the surfaces that are not the renderer', () => {
  it('selects mathematics as its source, with the delimiters kept', () => {
    const runs = selectableRuns('The term $x^2$ and\n\n$$a + b$$\n')

    expect(runsToPlainText(runs)).toContain('$x^2$')
    expect(runsToPlainText(runs)).toContain('a + b')
    expect(runs.some(run => run.mono && run.text === '$x^2$')).toBe(true)
    expect(runs.some(run => run.block === 'code' && run.text === 'a + b')).toBe(true)
  })

  it('selects a diagram as the source a reader could paste into a tool that draws it', () => {
    const runs = selectableRuns(FLOWCHART)

    expect(runsToPlainText(runs)).toContain('flowchart TD')
    expect(runs.every(run => run.block === 'code')).toBe(true)
  })

  it('leaves the plain-text flattening exactly as it was', () => {
    // Neither stripper knows about mathematics, deliberately: a preview line and
    // a Copy text want the characters the author typed, and `$x^2$` IS those
    // characters. This pins that nothing in this round reached into them.
    expect(plainTextBlock('The term $x^2$ and `code`.')).toBe('The term $x^2$ and code.')
    expect(plainTextPreview('## Head\n\n$$E = mc^2$$')).toBe('Head $$E = mc^2$$')
    expect(plainTextBlock(FLOWCHART)).toBe('flowchart TD\n  A[Start] --> B{Ready?}\n  B -->|yes| C[Ship]')
  })
})
