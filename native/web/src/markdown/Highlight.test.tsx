/**
 * Coloured code: the spans of `highlight.ts` as classes, the text unchanged.
 */
import { highlightToLines, resetBlockCache } from '@hermie/markdown'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { HighlightedCode } from './Highlight'
import { highlightRenderer } from './lazy'
import { Markdown } from './Markdown'

const clipboard = vi.hoisted(() => ({ writeClipboard: vi.fn<(text: string) => Promise<boolean>>() }))

vi.mock('../platform/clipboard', () => clipboard)

beforeAll(async () => {
  await highlightRenderer.load()
})

beforeEach(() => {
  resetBlockCache()
  clipboard.writeClipboard.mockReset()
  clipboard.writeClipboard.mockResolvedValue(true)
})

const PYTHON = ['def greet(name: str) -> str:', '    """Say hello."""', "    return f'Hello, {name}!'"].join('\n')

describe('highlighted code', () => {
  it('is exactly the source, span for span as highlight.ts cut it', () => {
    const { container } = render(
      <code>
        <HighlightedCode code={PYTHON} language="python" />
      </code>
    )
    const lines = highlightToLines(PYTHON, 'python')
    const scoped = lines.flat().filter(span => span.scope)

    expect(container.textContent).toBe(PYTHON)
    expect(container.querySelectorAll('.md-hl')).toHaveLength(scoped.length)
    expect(container.querySelector('.md-hl-keyword')?.textContent).toBe('def')
    expect(container.querySelector('.md-hl-string')).not.toBeNull()
  })

  it('colours a fence in a language a grammar knows, by its alias too', () => {
    const { container } = render(<Markdown text={'```ts\nconst a: number = 1 // one\n```'} />)

    expect(container.querySelector('pre code')?.textContent).toBe('const a: number = 1 // one')
    expect(container.querySelector('.md-hl-keyword')?.textContent).toBe('const')
    expect(container.querySelector('.md-hl-comment')?.textContent).toBe('// one')
    expect(container.querySelector('pre code')?.getAttribute('class')).toBe('language-ts')
  })

  it('leaves a fence with no language, or one no grammar knows, plain', () => {
    const { container } = render(<Markdown text={'```\nconst a = 1\n```\n\n```brainfuck\n+++[>+<-]\n```'} />)

    expect(container.querySelector('.md-hl')).toBeNull()
    expect(Array.from(container.querySelectorAll('pre')).map(pre => pre.textContent)).toEqual([
      'const a = 1',
      '+++[>+<-]'
    ])
  })

  it('draws markup in a listing as the characters it is', () => {
    const { container } = render(
      <Markdown text={'```html\n<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n```'} />
    )

    expect(container.querySelector('pre code')?.textContent).toBe(
      '<script>alert(1)</script>\n<img src=x onerror=alert(1)>'
    )
    expect(container.querySelector('script, img')).toBeNull()
    expect(container.querySelector('.md-hl-tag')).not.toBeNull()
  })

  it('copies the source, not the colours', () => {
    render(<Markdown text={'```ts\nconst a = 1\n```'} />)

    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }))

    expect(clipboard.writeClipboard).toHaveBeenCalledWith('const a = 1')
  })

  it('has no toggle: a listing is its own source', () => {
    render(<Markdown text={'```ts\nconst a = 1\n```'} />)

    expect(screen.queryByRole('button', { name: 'Show source' })).toBeNull()
  })
})
