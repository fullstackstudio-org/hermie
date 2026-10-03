/**
 * Mathematics as the reader meets it: the drawing matches its layout element for
 * element, carries the source as its text alternative, gives the source back on
 * request, and source the parser declines is shown as source.
 */
import { parseMath, resetBlockCache } from '@hermie/markdown'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { mathRenderer } from './lazy'
import { Markdown } from './Markdown'
import { estimateText, layoutMath } from './math-layout'

const clipboard = vi.hoisted(() => ({ writeClipboard: vi.fn<(text: string) => Promise<boolean>>() }))

vi.mock('../platform/clipboard', () => clipboard)

beforeAll(async () => {
  await mathRenderer.load()
})

beforeEach(() => {
  resetBlockCache()
  clipboard.writeClipboard.mockReset()
  clipboard.writeClipboard.mockResolvedValue(true)
})

const QUADRATIC = String.raw`x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}`

describe('block math', () => {
  it('is an image named by its source, drawn element for element from the layout', () => {
    const { container } = render(<Markdown text={`$$\n${QUADRATIC}\n$$`} />)
    const svg = screen.getByRole('img', { name: QUADRATIC })
    // jsdom has no canvas, so the drawing was measured with the estimate.
    const layout = layoutMath(parseMath(QUADRATIC)!, 16, estimateText)

    expect(svg.getAttribute('viewBox')).toBe(`0 0 ${layout.width} ${layout.height}`)
    expect(svg.getAttribute('width')).toBe(`${layout.width / 16}em`)
    expect(svg.getAttribute('height')).toBe(`${layout.height / 16}em`)
    expect(svg.querySelectorAll('text')).toHaveLength(layout.texts.length)
    expect(svg.querySelectorAll('rect')).toHaveLength(layout.rules.length)
    expect(svg.querySelectorAll('path')).toHaveLength(layout.strokes.length)
    expect(Array.from(svg.querySelectorAll('text')).map(text => text.textContent)).toEqual(
      layout.texts.map(text => text.runs.map(run => run.text).join(''))
    )
    expect(Array.from(svg.querySelectorAll('path')).map(path => path.getAttribute('d'))).toEqual(
      layout.strokes.map(stroke => stroke.d)
    )
    expect(container.querySelector('.md-code')?.getAttribute('data-kind')).toBe('math')
    expect(container.querySelector('.md-code-lang')?.textContent).toBe('LaTeX')
  })

  it('sets variables in italic and names in roman, as runs of the same line', () => {
    const { container } = render(<Markdown text={'$$\n\\sin x\n$$'} />)
    const spans = Array.from(container.querySelectorAll('svg tspan'))

    expect(spans.map(span => [span.textContent, span.getAttribute('font-style')])).toEqual([
      ['sin\u2009', null],
      ['x', 'italic']
    ])
  })

  it('shows its source on request, and the drawing again', () => {
    const { container } = render(<Markdown text={`$$\n${QUADRATIC}\n$$`} />)
    const toggle = screen.getByRole('button', { name: 'Show source' })

    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(toggle)

    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    expect(container.querySelector('svg')).toBeNull()
    expect(container.querySelector('pre')?.textContent).toBe(QUADRATIC)

    fireEvent.click(toggle)

    expect(container.querySelector('svg')).not.toBeNull()
    expect(container.querySelector('pre')).toBeNull()
  })

  it('copies the source, whichever is shown', () => {
    render(<Markdown text={`$$\n${QUADRATIC}\n$$`} />)

    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }))

    expect(clipboard.writeClipboard).toHaveBeenCalledWith(QUADRATIC)
  })

  it('shows source the parser declines as source, with no toggle', () => {
    const { container } = render(<Markdown text={'$$\n\\unknowncommand{x}\n$$'} />)

    expect(container.querySelector('svg')).toBeNull()
    expect(container.querySelector('pre')?.textContent).toBe('\\unknowncommand{x}')
    expect(screen.queryByRole('button', { name: 'Show source' })).toBeNull()
  })

  it('shows a half-typed expression as source while it streams, and draws it once it is whole', () => {
    const { container, rerender } = render(<Markdown text={'$$\n\\frac{1}{\n$$'} />)

    expect(container.querySelector('svg')).toBeNull()

    rerender(<Markdown text={'$$\n\\frac{1}{2}\n$$'} />)

    expect(container.querySelector('svg rect')).not.toBeNull()
  })
})

describe('inline math', () => {
  it('is text in the sentence, named by its source', () => {
    const { container } = render(<Markdown text={String.raw`so $\alpha_i \le \beta^2$ holds`} />)
    const math = screen.getByRole('math', { name: String.raw`\alpha_i \le \beta^2` })

    expect(math.textContent).toBe('αᵢ ≤ β²')
    expect(math.closest('p')?.textContent).toBe('so αᵢ ≤ β² holds')
    expect(container.querySelector('svg')).toBeNull()
  })

  it('sets a variable in italic and a number in roman', () => {
    render(<Markdown text="where $x + 1$ holds" />)

    expect(Array.from(screen.getByRole('math').children).map(child => [child.textContent, child.className])).toEqual([
      ['x', 'md-math-italic'],
      [' + 1', 'md-math-roman']
    ])
  })

  it('shows an expression with rows as its source in a code chip', () => {
    const { container } = render(<Markdown text={String.raw`a $\begin{pmatrix} 1 \\ 2 \end{pmatrix}$ b`} />)

    expect(screen.queryByRole('math')).toBeNull()
    expect(container.querySelector('code[data-math]')?.textContent).toBe(
      String.raw`\begin{pmatrix} 1 \\ 2 \end{pmatrix}`
    )
  })

  it('shows source the parser declines in a code chip', () => {
    const { container } = render(<Markdown text={String.raw`a $\notacommand$ b`} />)

    expect(container.querySelector('code[data-math]')?.textContent).toBe(String.raw`\notacommand`)
  })
})
