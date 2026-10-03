/**
 * The heavy renderers arrive as chunks (`lazy.ts`). Before a chunk is there a
 * block shows its source, which is a correct page; once it arrives the blocks
 * already on the page are drawn, without being written again.
 *
 * Its own file, so no other test has loaded a chunk before these run.
 */
import { resetBlockCache } from '@hermie/markdown'
import { act, render } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { highlightRenderer, mathRenderer, mermaidRenderer } from './lazy'
import { Markdown } from './Markdown'

beforeEach(() => {
  resetBlockCache()
})

const TEXT = [
  '```ts',
  'const a = 1',
  '```',
  '',
  '$$',
  'E = mc^2',
  '$$',
  '',
  'where $a^2 + b^2$ holds',
  '',
  '```Mermaid',
  'flowchart LR',
  '  A --> B',
  '```'
].join('\n')

describe('before and after the chunks arrive', () => {
  it('shows the source first, then the drawings, the colours and the typeset line', async () => {
    const { container } = render(<Markdown text={TEXT} />)
    const math = (): Element | null => container.querySelector('.md-code[data-kind="math"]')
    const diagram = (): Element | null => container.querySelector('.md-code[data-kind="mermaid"]')

    // Nothing has arrived: the listing is plain, the formula and the inline expression are their source.
    expect(highlightRenderer.current()).toBeUndefined()
    expect(mathRenderer.current()).toBeUndefined()
    expect(mermaidRenderer.current()).toBeUndefined()
    expect(container.querySelector('.md-hl')).toBeNull()
    expect(math()?.querySelector('pre')?.textContent).toBe('E = mc^2')
    expect(math()?.querySelector('.md-code-lang')?.textContent).toBe('LaTeX')
    expect(container.querySelector('code[data-math]')?.textContent).toBe('a^2 + b^2')
    expect(diagram()?.querySelector('pre')?.textContent).toBe('flowchart LR\n  A --> B')
    expect(diagram()?.querySelector('.md-code-lang')?.textContent).toBe('mermaid')
    expect(container.querySelector('svg')).toBeNull()

    await act(async () => {
      await Promise.all([highlightRenderer.load(), mathRenderer.load(), mermaidRenderer.load()])
    })

    expect(container.querySelector('.md-hl-keyword')?.textContent).toBe('const')
    expect(container.querySelector('pre code')?.textContent).toBe('const a = 1')
    expect(math()?.querySelector('svg[role="img"]')?.getAttribute('aria-label')).toBe('E = mc^2')
    expect(container.querySelector('code[data-math]')).toBeNull()
    expect(container.querySelector('[role="math"]')?.getAttribute('aria-label')).toBe('a^2 + b^2')
    expect(container.querySelector('[role="math"]')?.textContent).toBe('a² + b²')
    expect(diagram()?.querySelector('svg.md-diagram-flowchart')?.getAttribute('aria-label')).toBe(
      'flowchart LR\n  A --> B'
    )
  })

  it('draws a block rendered after the chunks arrived on its first render', () => {
    const { container } = render(<Markdown text={'$$\nx^2\n$$'} />)

    expect(container.querySelector('svg[role="img"]')).not.toBeNull()
    expect(container.querySelector('pre')).toBeNull()
  })
})
