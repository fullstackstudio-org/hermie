import { resetBlockCache } from '@hermie/markdown'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetActiveLocale, setActiveLocale } from '../i18n/active-locale'

import { Markdown } from './Markdown'

const clipboard = vi.hoisted(() => ({ writeClipboard: vi.fn<(text: string) => Promise<boolean>>() }))

vi.mock('../platform/clipboard', () => clipboard)

const GATEWAY = 'https://gw.example.test'

beforeEach(() => {
  resetBlockCache()
  clipboard.writeClipboard.mockReset()
  clipboard.writeClipboard.mockResolvedValue(true)
})

afterEach(() => {
  resetActiveLocale()
  vi.useRealTimers()
})

describe('links', () => {
  it('opens an http, https or mailto link in a new tab, without the opener or the referrer', () => {
    const { container } = render(
      <Markdown text="[a](https://example.com/a), [b](http://example.com/b), [c](mailto:someone@example.com) and https://example.com/bare." />
    )
    const anchors = Array.from(container.querySelectorAll('a'))

    expect(anchors.map(anchor => anchor.getAttribute('href'))).toEqual([
      'https://example.com/a',
      'http://example.com/b',
      'mailto:someone@example.com',
      'https://example.com/bare'
    ])

    for (const anchor of anchors) {
      expect(anchor.getAttribute('target')).toBe('_blank')
      expect(anchor.getAttribute('rel')).toBe('noopener noreferrer')
    }
  })

  it('carries the title of a link', () => {
    render(<Markdown text={'[a](https://example.com "where it goes")'} />)

    expect(screen.getByRole('link', { name: 'a' }).getAttribute('title')).toBe('where it goes')
  })

  it('shows any other link as its words', () => {
    const { container } = render(
      <Markdown text="[path](/home/you/notes.md), [script](javascript:alert(1)), [phone](tel:+3112345678) and [file](file:///etc/hosts)" />
    )

    expect(container.querySelector('a')).toBeNull()
    expect(container.textContent).toBe('path, script, phone and file')
  })

  it('keeps the marks inside a link label', () => {
    const { container } = render(<Markdown text="[**bold** and `code`](https://example.com)" />)
    const anchor = container.querySelector('a')

    expect(anchor?.querySelector('strong')?.textContent).toBe('bold')
    expect(anchor?.querySelector('code')?.textContent).toBe('code')
  })
})

describe('images', () => {
  it('loads a gateway path lazily, with its alt text', () => {
    render(<Markdown gatewayBaseUrl={GATEWAY} text="![a chart of weekly runs](/api/files/1.png)" />)

    const image = screen.getByRole('img', { name: 'a chart of weekly runs' })

    expect(image.getAttribute('src')).toBe(`${GATEWAY}/api/files/1.png`)
    expect(image.getAttribute('loading')).toBe('lazy')
  })

  it('loads an absolute address on the gateway origin', () => {
    render(<Markdown gatewayBaseUrl={GATEWAY} text={`![x](${GATEWAY}/api/files/2.png)`} />)

    expect(screen.getByRole('img').getAttribute('src')).toBe(`${GATEWAY}/api/files/2.png`)
  })

  it('shows a remote image as a link with the alt text, and requests nothing', () => {
    const { container } = render(
      <Markdown gatewayBaseUrl={GATEWAY} text="![a remote picture](https://cdn.example.net/p.png)" />
    )

    expect(container.querySelector('img')).toBeNull()

    const link = screen.getByRole('link', { name: 'a remote picture' })

    expect(link.getAttribute('href')).toBe('https://cdn.example.net/p.png')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('names a remote image link by its address when the alt text is empty', () => {
    render(<Markdown gatewayBaseUrl={GATEWAY} text="![](https://cdn.example.net/p.png)" />)

    expect(screen.getByRole('link').textContent).toBe('https://cdn.example.net/p.png')
  })

  it('loads nothing without a gateway to resolve against', () => {
    const { container } = render(<Markdown text="![gone](/api/files/1.png)" />)

    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toBe('gone')
  })

  it('does not nest a link inside a link', () => {
    const { container } = render(
      <Markdown gatewayBaseUrl={GATEWAY} text="[![remote](https://cdn.example.net/p.png)](https://example.com)" />
    )

    expect(container.querySelectorAll('a')).toHaveLength(1)
    expect(container.querySelector('a a')).toBeNull()
    expect(container.querySelector('a')?.textContent).toBe('remote')
  })

  it('falls back to the alt text when the image does not load', () => {
    const { container } = render(<Markdown gatewayBaseUrl={GATEWAY} text="![a chart](/api/files/missing.png)" />)

    fireEvent.error(screen.getByRole('img'))

    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toBe('a chart')
  })
})

describe('code blocks', () => {
  const SOURCE = '```ts\nconst a = 1\nconst b = 2\n```'

  it('shows the language and the source, in a box that scrolls', () => {
    const { container } = render(<Markdown text={SOURCE} />)

    expect(container.querySelector('.md-code-lang')?.textContent).toBe('ts')
    expect(container.querySelector('pre > code')?.textContent).toBe('const a = 1\nconst b = 2')
    expect(container.querySelector('pre > code')?.className).toBe('language-ts')
    // Reachable from the keyboard, which is how a pointer-less reader scrolls it.
    expect(container.querySelector('pre')?.getAttribute('tabindex')).toBe('0')
  })

  it('has no label for a block without a language', () => {
    const { container } = render(<Markdown text={'```\nplain\n```'} />)

    expect(container.querySelector('.md-code-lang')).toBeNull()
    expect(container.querySelector('pre > code')?.getAttribute('class')).toBeNull()
  })

  it('takes the first word of the info string as the language', () => {
    const { container } = render(<Markdown text={'```python title="a.py"\nprint(1)\n```'} />)

    expect(container.querySelector('.md-code-lang')?.textContent).toBe('python')
  })

  it('keeps Markdown inside a fence literal', () => {
    const { container } = render(<Markdown text={'```\n**not bold** [x](https://example.com)\n```'} />)

    expect(container.querySelector('strong, a')).toBeNull()
    expect(container.querySelector('pre')?.textContent).toBe('**not bold** [x](https://example.com)')
  })

  it('shows a mermaid fence and a math block as their source until they are drawn', () => {
    const { container } = render(<Markdown text={'```Mermaid\nflowchart LR\n  A --> B\n```\n\n$$\nE = mc^2\n$$'} />)
    const blocks = Array.from(container.querySelectorAll('.md-code'))

    expect(blocks.map(block => block.getAttribute('data-kind'))).toEqual(['mermaid', 'math'])
    expect(blocks.map(block => block.querySelector('pre')?.textContent)).toEqual([
      'flowchart LR\n  A --> B',
      'E = mc^2'
    ])
    expect(blocks.map(block => block.querySelector('.md-code-lang')?.textContent)).toEqual(['mermaid', 'LaTeX'])
  })

  it('shows inline math as its source in a code chip', () => {
    const { container } = render(<Markdown text="where $a^2 + b^2$ holds" />)

    expect(container.querySelector('code[data-math]')?.textContent).toBe('a^2 + b^2')
  })

  describe('the copy button', () => {
    it('has an accessible name and copies the source', async () => {
      render(<Markdown text={SOURCE} />)

      fireEvent.click(screen.getByRole('button', { name: 'Copy code' }))

      await waitFor(() => expect(clipboard.writeClipboard).toHaveBeenCalledWith('const a = 1\nconst b = 2'))
    })

    it('says "Copied" in a polite live region, then clears it', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      const { container } = render(<Markdown text={SOURCE} />)
      const status = container.querySelector('[role="status"]')

      expect(status?.getAttribute('aria-live')).toBe('polite')
      expect(status?.textContent).toBe('')

      fireEvent.click(screen.getByRole('button', { name: 'Copy code' }))

      await waitFor(() => expect(status?.textContent).toBe('Copied'))

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500)
      })

      expect(status?.textContent).toBe('')
    })

    it('says so when the browser refuses the copy', async () => {
      clipboard.writeClipboard.mockResolvedValue(false)
      const { container } = render(<Markdown text={SOURCE} />)

      fireEvent.click(screen.getByRole('button', { name: 'Copy code' }))

      await waitFor(() => expect(container.querySelector('[role="status"]')?.textContent).toBe('Could not copy'))
    })

    it('copies from the right block when there are several', async () => {
      render(<Markdown text={'```\nfirst\n```\n\n```\nsecond\n```'} />)

      fireEvent.click(screen.getAllByRole('button', { name: 'Copy code' })[1] as HTMLElement)

      await waitFor(() => expect(clipboard.writeClipboard).toHaveBeenCalledWith('second'))
    })

    it('is named in the language the client speaks', () => {
      setActiveLocale('nl')
      render(<Markdown text={SOURCE} />)

      expect(screen.getByRole('button', { name: 'Code kopiëren' })).toBeTruthy()
    })
  })
})

describe('tables', () => {
  const TABLE = '| Name | Status |\n| :--- | ---: |\n| Recovery | Shipped |\n| Search | Planned |'

  it('scrolls inside its own container, which a keyboard can reach', () => {
    const { container } = render(<Markdown text={TABLE} />)
    const scroll = container.querySelector('.md-table-scroll')

    expect(scroll?.getAttribute('tabindex')).toBe('0')
    expect(scroll?.querySelector(':scope > table')).not.toBeNull()
  })

  it('keeps its header semantics', () => {
    render(<Markdown text={TABLE} />)

    const headers = screen.getAllByRole('columnheader')

    expect(headers.map(header => header.textContent)).toEqual(['Name', 'Status'])
    expect(headers.map(header => header.getAttribute('scope'))).toEqual(['col', 'col'])
    expect(screen.getAllByRole('row')).toHaveLength(3)
    expect(screen.getAllByRole('cell').map(cell => cell.textContent)).toEqual([
      'Recovery',
      'Shipped',
      'Search',
      'Planned'
    ])
  })

  it('aligns columns with classes, not inline styles', () => {
    const { container } = render(<Markdown text={'| a | b | c |\n| :-: | --: | --- |\n| 1 | 2 | 3 |'} />)
    const cells = Array.from(container.querySelectorAll('tbody td'))

    expect(cells.map(cell => cell.className)).toEqual(['md-align-center', 'md-align-right', ''])
    expect(container.querySelector('[style]')).toBeNull()
  })
})

describe('lists', () => {
  it('numbers an ordered list from where it starts', () => {
    const { container } = render(<Markdown text={'3. three\n4. four'} />)

    expect(container.querySelector('ol')?.getAttribute('start')).toBe('3')
    expect(container.querySelectorAll('ol > li')).toHaveLength(2)
  })

  it('does not write a start for a list that begins at one', () => {
    const { container } = render(<Markdown text={'1. one\n2. two'} />)

    expect(container.querySelector('ol')?.hasAttribute('start')).toBe(false)
  })

  it('nests', () => {
    const { container } = render(<Markdown text={'- a\n  - b\n    - c'} />)

    expect(container.querySelectorAll('ul')).toHaveLength(3)
    expect(container.querySelector('ul > li > ul > li > ul')).not.toBeNull()
  })

  it('draws no written marker next to the checkbox of a loose task item', () => {
    const { container } = render(<Markdown text={'- [x] first task\n\n- [ ] second task\n\n- plain item'} />)

    expect(Array.from(container.querySelectorAll('li')).map(item => item.textContent)).toEqual([
      'first task',
      'second task',
      'plain item'
    ])
    expect((screen.getAllByRole('checkbox') as HTMLInputElement[]).map(box => box.checked)).toEqual([true, false])
  })

  it('draws a task item as a disabled checkbox with a name', () => {
    render(<Markdown text={'- [x] done thing\n- [ ] open thing'} />)

    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[]

    expect(boxes.map(box => box.checked)).toEqual([true, false])
    expect(boxes.map(box => box.disabled)).toEqual([true, true])
    expect(boxes.map(box => box.getAttribute('aria-label'))).toEqual(['Done', 'Not done'])
  })
})

describe('the rest of the vocabulary', () => {
  it('draws a heading at its level', () => {
    render(<Markdown text={'# one\n\n### three\n\n###### six'} />)

    expect(screen.getAllByRole('heading').map(heading => heading.tagName)).toEqual(['H1', 'H3', 'H6'])
  })

  it('draws emphasis, strong, strike, code and a hard break', () => {
    const { container } = render(<Markdown text={'*a* **b** ~~c~~ `d`  \ne'} />)

    expect(container.querySelector('em')?.textContent).toBe('a')
    expect(container.querySelector('strong')?.textContent).toBe('b')
    expect(container.querySelector('del')?.textContent).toBe('c')
    expect(container.querySelector('code')?.textContent).toBe('d')
    expect(container.querySelector('br')).not.toBeNull()
  })

  it('draws a quote and a rule', () => {
    const { container } = render(<Markdown text={'> quoted\n\n---\n\nafter'} />)

    expect(container.querySelector('blockquote p')?.textContent).toBe('quoted')
    expect(container.querySelector('hr')).not.toBeNull()
  })

  it('shows a raw HTML block and raw inline HTML as the text it is', () => {
    const { container } = render(<Markdown text={'<div>\nraw html\n</div>\n\nand <span class="x">inline</span>'} />)

    expect(container.querySelector('.md-html')?.textContent).toBe('<div>\nraw html\n</div>')
    expect(container.querySelector('p')?.textContent).toBe('and <span class="x">inline</span>')
    expect(container.querySelector('.md div, .md span')).toBeNull()
  })

  it('renders nothing for an empty message', () => {
    const { container } = render(<Markdown text="" />)

    expect(container.firstElementChild?.childElementCount).toBe(0)
  })

  it('hides a reasoning block, as the shared preprocessing does', () => {
    const { container } = render(<Markdown text={'<think>private</think>public'} />)

    expect(container.textContent).toBe('public')
  })

  it('puts the class it is given on its root', () => {
    const { container } = render(<Markdown className="bubble" text="x" />)

    expect(container.firstElementChild?.className).toBe('md bubble')
  })
})

describe('re-rendering', () => {
  it('draws the new text when the text changes', () => {
    const { container, rerender } = render(<Markdown text="# one" />)

    rerender(<Markdown text="# two" />)

    expect(container.querySelector('h1')?.textContent).toBe('two')
  })

  it('reads a gateway change as a new image address', () => {
    const { rerender } = render(<Markdown gatewayBaseUrl={GATEWAY} text="![x](/api/a.png)" />)

    rerender(<Markdown gatewayBaseUrl="https://other.example.test" text="![x](/api/a.png)" />)

    expect(screen.getByRole('img').getAttribute('src')).toBe('https://other.example.test/api/a.png')
  })
})
