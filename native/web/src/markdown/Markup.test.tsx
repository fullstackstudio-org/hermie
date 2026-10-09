/**
 * The structured blocks of a reply as the reader meets them: a chart, a set of cards, a callout.
 *
 * Each is drawn only when its chunk is there and the block validates, and only in a reply (not in what the owner
 * typed); until then, and whenever it does not validate, it is the code block or the quote it was written as. Its own
 * file, so no other test has loaded a chunk before these run.
 */
import { resetBlockCache } from '@hermie/markdown'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetActiveLocale, setActiveLocale } from '../i18n/active-locale'
import { isClosedFence } from './Block'
import { cardsRenderer, chartRenderer } from './lazy'
import { Markdown } from './Markdown'

const clipboard = vi.hoisted(() => ({ writeClipboard: vi.fn<(text: string) => Promise<boolean>>() }))

vi.mock('../platform/clipboard', () => clipboard)

beforeEach(() => {
  resetBlockCache()
  clipboard.writeClipboard.mockReset()
  clipboard.writeClipboard.mockResolvedValue(true)
})

afterEach(() => {
  cleanup()
  resetActiveLocale()
})

const FENCE = '```'

const fence = (language: string, body: string, closed = true): string =>
  `${FENCE}${language}\n${body}${closed ? `\n${FENCE}` : ''}`

const CHART = JSON.stringify({
  type: 'bar',
  title: 'Sales per quarter',
  unit: 'EUR',
  x: ['Q1', 'Q2', 'Q3', 'Q4'],
  series: [
    { name: '2026', values: [12, 15, 9, 20] },
    { name: '2027', values: [14, 18, 11, 24] }
  ]
})

const CARDS = JSON.stringify({
  title: 'Hoe ik het zou opzetten',
  cards: [
    {
      icon: 'server',
      title: 'Gateway per klant',
      subtitle: 'k3s, eigen Postgres',
      tags: ['k3s', 'Postgres'],
      highlight: true,
      next: 'deployt naar'
    },
    { icon: 'globe', title: 'Website', subtitle: 'Next.js standalone' },
    { title: 'Klant' }
  ]
})

async function loadChunks(): Promise<void> {
  await act(async () => {
    await Promise.all([chartRenderer.load(), cardsRenderer.load()])
  })
}

describe('before the chunks arrive', () => {
  it('shows a chart fence and a cards fence as the code they are, then draws them', async () => {
    expect(chartRenderer.current()).toBeUndefined()
    expect(cardsRenderer.current()).toBeUndefined()

    const { container } = render(
      <Markdown text={`${fence('hermie-chart', CHART)}\n\n${fence('hermie-cards', CARDS)}`} />
    )

    expect(container.querySelectorAll('pre')).toHaveLength(2)
    expect(container.querySelector('svg')).toBeNull()
    expect(container.querySelector('.md-code-lang')?.textContent).toBe('hermie-chart')

    await loadChunks()

    expect(container.querySelector('.md-block[data-kind="chart"] svg[role="img"]')).not.toBeNull()
    expect(container.querySelector('.md-block[data-kind="cards"] [role="list"]')).not.toBeNull()
    expect(container.querySelector('pre')).toBeNull()
  })
})

describe('a chart', () => {
  beforeEach(loadChunks)

  it('is one image named by the sentence the native apps speak', () => {
    const { container } = render(<Markdown text={fence('hermie-chart', CHART)} />)
    const image = container.querySelector('svg[role="img"]') as SVGElement

    expect(image.getAttribute('aria-label')).toBe(
      'Bar chart, Sales per quarter. In EUR. 2026: Q1 12, Q2 15, Q3 9, Q4 20. 2027: Q1 14, Q2 18, Q3 11, Q4 24.'
    )
    // The picture is the block: no header bar, no language label, no listing buttons over it.
    expect(container.querySelector('.md-code, .md-code-bar, .md-code-lang')).toBeNull()
    // One bar per value, in two series; the title and the legend are for the eye (the sentence says them).
    expect(container.querySelectorAll('rect.md-chart-bar')).toHaveLength(8)
    expect(container.querySelector('.md-chart-title')?.getAttribute('aria-hidden')).toBe('true')
    expect(container.querySelector('.md-chart-legend')?.getAttribute('aria-hidden')).toBe('true')
    expect([...container.querySelectorAll('.md-chart-legend li')].map(item => item.textContent)).toEqual([
      '2026',
      '2027'
    ])
    expect(container.querySelector('.md-chart-unit')?.textContent).toBe('EUR')
  })

  it('draws a line chart with a mark for every point and a pie as a ring with its legend', () => {
    const line = JSON.stringify({ type: 'line', x: ['a', 'b', 'c'], series: [{ name: 's', values: [1, 3, 2] }] })
    const pie = JSON.stringify({
      type: 'pie',
      unit: '%',
      x: ['Reading', 'Writing'],
      series: [{ name: 's', values: [3, 1] }]
    })
    const { container } = render(<Markdown text={`${fence('hermie-chart', line)}\n\n${fence('hermie-chart', pie)}`} />)

    expect(container.querySelectorAll('.md-chart-line .md-chart-mark')).toHaveLength(3)
    expect(container.querySelectorAll('.md-chart-line-path')).toHaveLength(1)
    expect(container.querySelectorAll('.md-chart-slice')).toHaveLength(2)
    expect(
      [...container.querySelectorAll('.md-chart-pie ~ .md-chart-legend li')].map(item => item.textContent)
    ).toEqual(['Reading3 %', 'Writing1 %'])
  })

  it('says what a slice is worth once: with the unit when there is one, with its share when there is not', () => {
    const pie = (unit?: string): string =>
      fence(
        'hermie-chart',
        JSON.stringify({
          type: 'pie',
          ...(unit ? { unit } : {}),
          x: ['A', 'B'],
          series: [{ name: 's', values: [3, 1] }]
        })
      )
    const legend = (container: HTMLElement): string[] =>
      [...container.querySelectorAll('.md-chart-legend li')].map(item => item.textContent ?? '')

    expect(legend(render(<Markdown text={pie('%')} />).container)).toEqual(['A3 %', 'B1 %'])
    cleanup()
    expect(legend(render(<Markdown text={pie('EUR')} />).container)).toEqual(['A3 EUR', 'B1 EUR'])
    cleanup()
    expect(legend(render(<Markdown text={pie()} />).container)).toEqual(['A3 (75%)', 'B1 (25%)'])
  })

  it('has a "..." button in its corner with Show source and Copy source, closed until it is pressed', async () => {
    const { container } = render(<Markdown text={fence('hermie-chart', CHART)} />)
    const more = screen.getByRole('button', { name: 'More options' })
    const panel = container.querySelector('.md-block-panel') as HTMLElement

    expect(more.getAttribute('aria-expanded')).toBe('false')
    expect(more.getAttribute('aria-controls')).toBe(panel.id)
    expect(panel.hidden).toBe(true)
    // Nothing else is a button: the block has no header bar.
    expect(container.querySelectorAll('.md-block-menu > button')).toHaveLength(1)

    fireEvent.click(more)

    expect(more.getAttribute('aria-expanded')).toBe('true')
    expect(panel.hidden).toBe(false)

    const toggle = screen.getByRole('button', { name: 'Show source' })

    fireEvent.click(toggle)

    expect(more.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('.md-block')?.getAttribute('data-drawn')).toBe('false')
    expect(container.querySelector('pre')?.textContent).toBe(CHART)
    expect(container.querySelector('svg[role="img"]')).toBeNull()

    // And back: the toggle is pressed while the source shows.
    fireEvent.click(more)
    expect(screen.getByRole('button', { name: 'Show source' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Show source' }))
    expect(container.querySelector('svg[role="img"]')).not.toBeNull()

    fireEvent.click(more)
    fireEvent.click(screen.getByRole('button', { name: 'Copy source' }))
    await act(async () => undefined)

    expect(clipboard.writeClipboard).toHaveBeenCalledWith(CHART)
    expect(screen.getByRole('status').textContent).toBe('Copied')
  })

  it('closes its panel with Escape and puts focus back on the button, and when a press lands elsewhere', () => {
    render(
      <>
        <button type="button">elsewhere</button>
        <Markdown text={fence('hermie-chart', CHART)} />
      </>
    )

    const more = screen.getByRole('button', { name: 'More options' })

    fireEvent.click(more)
    screen.getByRole('button', { name: 'Copy source' }).focus()
    fireEvent.keyDown(screen.getByRole('button', { name: 'Copy source' }), { key: 'Escape' })

    expect(more.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(more)

    fireEvent.click(more)
    fireEvent.pointerDown(screen.getByRole('button', { name: 'elsewhere' }))

    expect(more.getAttribute('aria-expanded')).toBe('false')
  })

  it('says a copy the browser refuses', async () => {
    clipboard.writeClipboard.mockResolvedValue(false)
    render(<Markdown text={fence('hermie-chart', CHART)} />)
    fireEvent.click(screen.getByRole('button', { name: 'More options' }))
    fireEvent.click(screen.getByRole('button', { name: 'Copy source' }))
    await act(async () => undefined)

    expect(screen.getByRole('status').textContent).toBe('Could not copy')
  })

  it('keeps a block that does not validate as the code it is, with its language', () => {
    const invalid = JSON.stringify({ type: 'bar', x: ['a', 'b'], series: [{ name: 's', values: [1] }] })
    const { container } = render(<Markdown text={fence('hermie-chart', invalid)} />)

    expect(container.querySelector('svg')).toBeNull()
    expect(container.querySelector('pre')?.textContent).toBe(invalid)
    expect(container.querySelector('.md-code-lang')?.textContent).toBe('hermie-chart')
    expect(screen.queryByRole('button', { name: 'More options' })).toBeNull()
  })

  it('is drawn for a language written in capitals, and only for this language', () => {
    const { container } = render(<Markdown text={`${fence('Hermie-Chart', CHART)}\n\n${fence('json', CHART)}`} />)

    expect(container.querySelectorAll('svg[role="img"]')).toHaveLength(1)
    expect(container.querySelectorAll('pre')).toHaveLength(1)
  })

  it('says its words in the reader’s language', () => {
    setActiveLocale('nl')

    const { container } = render(<Markdown text={fence('hermie-chart', CHART)} />)

    expect(container.querySelector('svg[role="img"]')?.getAttribute('aria-label')).toMatch(
      /^Staafdiagram, Sales per quarter\./u
    )
    expect(screen.getByRole('button', { name: 'Meer opties' })).not.toBeNull()
  })

  it('puts nothing a reply wrote into an attribute but the name, and never makes an element a reply chose', () => {
    const hostile = JSON.stringify({
      type: 'bar',
      title: '<img src=x onerror=alert(1)>',
      unit: '"><script>',
      x: ['<b>bold</b>', 'javascript:alert(1)'],
      series: [{ name: '</svg><script>alert(1)</script>', values: [1, 2] }]
    })
    const { container } = render(<Markdown text={fence('hermie-chart', hostile)} />)

    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('a')).toBeNull()
    expect(container.querySelector('.md-chart-title')?.textContent).toBe('<img src=x onerror=alert(1)>')
    expect(container.querySelector('[onerror], [onclick], [style]')).toBeNull()
  })
})

describe('cards', () => {
  beforeEach(loadChunks)

  it('is a list with one item per card, each read as one sentence, in order', () => {
    const { container } = render(<Markdown text={fence('hermie-cards', CARDS)} />)
    const list = screen.getByRole('list', { name: 'Hoe ik het zou opzetten' })
    const items = within(list).getAllByRole('listitem')

    expect(items).toHaveLength(3)
    expect(items.map(item => item.querySelector('.md-sr-only')?.textContent)).toEqual([
      'Card 1 of 3, Gateway per klant, k3s, eigen Postgres, highlighted, tags k3s, Postgres, then: deployt naar',
      'Card 2 of 3, Website, Next.js standalone',
      'Card 3 of 3, Klant'
    ])
    // The drawn card says the same in pieces, and is out of the way of the sentence.
    expect(container.querySelectorAll('.md-card[aria-hidden="true"]')).toHaveLength(3)
    expect(container.querySelectorAll('.md-card-link[aria-hidden="true"]')).toHaveLength(2)
    expect(container.querySelector('.md-card[data-highlight="true"] .md-card-title')?.textContent).toBe(
      'Gateway per klant'
    )
    expect(container.querySelector('.md-code, .md-code-bar, .md-code-lang')).toBeNull()
    expect(screen.getByRole('button', { name: 'More options' })).not.toBeNull()
  })

  it('draws a connector with its label between cards, an arrow by default, and none after the last', () => {
    const { container } = render(<Markdown text={fence('hermie-cards', CARDS)} />)
    const links = [...container.querySelectorAll('.md-card-link')]

    expect(links.map(link => link.getAttribute('data-connector'))).toEqual(['arrow', 'arrow'])
    expect(links.map(link => link.querySelector('.md-card-next')?.textContent ?? null)).toEqual(['deployt naar', null])
    expect(links[0]?.querySelectorAll('svg path')).toHaveLength(2)
  })

  it('draws a grid without connectors, a line without an arrowhead and "none" without a line', () => {
    const cards = [{ title: 'A' }, { title: 'B' }]
    const grid = render(<Markdown text={fence('hermie-cards', JSON.stringify({ layout: 'grid', cards }))} />)

    expect(grid.container.querySelector('.md-cards')?.getAttribute('data-layout')).toBe('grid')
    expect(grid.container.querySelector('.md-card-link')).toBeNull()
    cleanup()

    const line = render(<Markdown text={fence('hermie-cards', JSON.stringify({ connector: 'line', cards }))} />)

    expect(line.container.querySelectorAll('.md-card-link svg path')).toHaveLength(1)
    cleanup()

    const none = render(<Markdown text={fence('hermie-cards', JSON.stringify({ connector: 'none', cards }))} />)

    expect(none.container.querySelector('.md-card-link')?.getAttribute('data-connector')).toBe('none')
    expect(none.container.querySelector('.md-card-link svg')).toBeNull()
  })

  it('draws an icon from the vocabulary, the generic glyph for any other name and none without one', () => {
    const source = JSON.stringify({
      cards: [{ title: 'A', icon: 'server' }, { title: 'B', icon: 'not-a-name' }, { title: 'C' }]
    })
    const { container } = render(<Markdown text={fence('hermie-cards', source)} />)
    const paths = [...container.querySelectorAll('.md-card')].map(
      card => card.querySelector('.md-card-icon path')?.getAttribute('d') ?? null
    )

    expect(paths[0]).toMatch(/^M5 4h14/u)
    expect(paths[1]).toBe('M5 5h6v6H5zM13 5h6v6h-6zM5 13h6v6H5zM13 13h6v6h-6z')
    expect(paths[2]).toBeNull()
  })

  it('keeps a block that does not validate as the code it is', () => {
    const invalid = JSON.stringify({ cards: [{ title: 'Alone' }] })
    const { container } = render(<Markdown text={fence('hermie-cards', invalid)} />)

    expect(container.querySelector('[role="list"]')).toBeNull()
    expect(container.querySelector('pre')?.textContent).toBe(invalid)
  })

  it('makes no request and no link, whatever the block says', () => {
    const hostile = JSON.stringify({
      cards: [
        {
          title: '<img src="https://evil.example/x.png">',
          subtitle: '[a](https://evil.example)',
          icon: 'https://evil.example/i.svg'
        },
        { title: 'B', tags: ['<script>x</script>'] }
      ]
    })
    const { container } = render(<Markdown text={fence('hermie-cards', hostile)} />)

    expect(container.querySelector('img, a, script, iframe, object, use, image, foreignObject')).toBeNull()
    expect(container.querySelector('[href], [src], [xlink\\:href]')).toBeNull()
    expect(container.querySelector('.md-card-title')?.textContent).toBe('<img src="https://evil.example/x.png">')
    expect(container.querySelector('.md-card-subtitle')?.textContent).toBe('[a](https://evil.example)')
  })

  it('says its words in the reader’s language', () => {
    setActiveLocale('de')

    const { container } = render(<Markdown text={fence('hermie-cards', CARDS)} />)

    expect(container.querySelector('.md-sr-only')?.textContent).toBe(
      'Karte 1 von 3, Gateway per klant, k3s, eigen Postgres, hervorgehoben, Tags k3s, Postgres, danach: deployt naar'
    )
  })
})

describe('a fence that is still streaming', () => {
  beforeEach(loadChunks)

  it('is code until it closes, and a picture once it has', () => {
    const open = render(<Markdown text={`Here it is.\n\n${fence('hermie-chart', CHART, false)}`} />)

    expect(open.container.querySelector('svg')).toBeNull()
    expect(open.container.querySelector('pre')?.textContent).toBe(CHART)
    open.unmount()

    const closed = render(<Markdown text={`Here it is.\n\n${fence('hermie-chart', CHART, true)}`} />)

    expect(closed.container.querySelector('svg[role="img"]')).not.toBeNull()
  })

  it('is the same for cards, and for a half-written body', () => {
    const half = fence('hermie-cards', CARDS.slice(0, 60), false)
    const open = render(<Markdown text={half} />)

    expect(open.container.querySelector('[role="list"]')).toBeNull()
    expect(open.container.querySelector('pre')).not.toBeNull()
  })

  it('knows a closed fence from one that is not', () => {
    expect(isClosedFence('```hermie-chart\n{}\n```')).toBe(true)
    expect(isClosedFence('```hermie-chart\n{}\n```\n')).toBe(true)
    expect(isClosedFence('~~~hermie-chart\n{}\n~~~')).toBe(true)
    expect(isClosedFence('````hermie-chart\n{}\n````')).toBe(true)
    expect(isClosedFence('```hermie-chart\n```')).toBe(true)
    expect(isClosedFence('```hermie-chart\n{}')).toBe(false)
    expect(isClosedFence('```hermie-chart')).toBe(false)
    expect(isClosedFence('````hermie-chart\n{}\n```')).toBe(false)
    expect(isClosedFence('```hermie-chart\n{}\n~~~')).toBe(false)
    expect(isClosedFence('')).toBe(false)
  })
})

describe('what the owner typed', () => {
  beforeEach(loadChunks)

  it('stays as typed: a chart fence is code, a callout is a quote', () => {
    const text = `${fence('hermie-chart', CHART)}\n\n> [!NOTE]\n> Typed.`
    const { container } = render(<Markdown richBlocks={false} text={text} />)

    expect(container.querySelector('svg')).toBeNull()
    expect(container.querySelector('pre')?.textContent).toBe(CHART)
    expect(container.querySelector('aside')).toBeNull()
    expect(container.querySelector('blockquote')?.textContent).toContain('[!NOTE]')
  })
})

describe('a callout', () => {
  it('is an aside named by its kind, with the marker line gone', () => {
    const { container } = render(<Markdown text={'> [!WARNING]\n> This cannot be undone.\n>\n> - first\n> - second'} />)
    const note = screen.getByRole('note', { name: 'Warning' })

    expect(note.tagName).toBe('ASIDE')
    expect(note.getAttribute('data-kind')).toBe('warning')
    expect(note.textContent).toContain('This cannot be undone.')
    expect(note.textContent).not.toContain('[!WARNING]')
    expect(note.querySelectorAll('li')).toHaveLength(2)
    expect(container.querySelector('blockquote')).toBeNull()
    // The title is for the eye; the name says it.
    expect(note.querySelector('.md-alert-title span')?.getAttribute('aria-hidden')).toBe('true')
    expect(note.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
  })

  it('has all five kinds', () => {
    for (const [marker, name] of [
      ['NOTE', 'Note'],
      ['TIP', 'Tip'],
      ['IMPORTANT', 'Important'],
      ['WARNING', 'Warning'],
      ['CAUTION', 'Caution']
    ]) {
      const { unmount } = render(<Markdown text={`> [!${marker}]\n> Words.`} />)

      expect(screen.getByRole('note', { name })).not.toBeNull()
      unmount()
    }
  })

  it('is a callout with a title only when nothing follows the marker', () => {
    render(<Markdown text="> [!TIP]" />)

    expect(screen.getByRole('note', { name: 'Tip' }).querySelector('.md-alert-body')?.textContent).toBe('')
  })

  it('says its name in the reader’s language', () => {
    setActiveLocale('nl')
    render(<Markdown text={'> [!CAUTION]\n> Pas op.'} />)

    expect(screen.getByRole('note', { name: 'Let op' })).not.toBeNull()
  })

  it('is a quote when the marker is not exactly a marker alone on the first line', () => {
    for (const text of [
      '> [!note]\n> Words.',
      '> [!NOTE] Words.\n> More.',
      '> Words.\n> [!NOTE]\n> More.',
      '> [!DANGER]\n> Words.',
      '> [! NOTE]\n> Words.',
      '[!NOTE]\nNot in a quote.'
    ]) {
      const { container, unmount } = render(<Markdown text={text} />)

      expect(container.querySelector('aside'), text).toBeNull()
      unmount()
    }
  })

  it('keeps a quote inside a callout an ordinary quote', () => {
    const { container } = render(<Markdown text={'> [!NOTE]\n> Outer.\n>\n> > [!TIP]\n> > Inner.'} />)

    expect(container.querySelectorAll('aside')).toHaveLength(1)
    expect(container.querySelector('aside blockquote')?.textContent).toContain('[!TIP]')
  })
})

describe('through axe', () => {
  beforeEach(loadChunks)

  async function violations(): Promise<string[]> {
    // jsdom loads no stylesheet, so contrast is measured in a real browser (`e2e/rich-answers.spec.ts`).
    const result = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } })

    return result.violations.map(
      violation =>
        `${violation.id}: ${violation.help} (${violation.nodes.map(node => node.target.join(' ')).join(', ')})`
    )
  }

  const REPLY = [
    'Here is the plan.',
    '',
    fence('hermie-cards', CARDS),
    '',
    fence('hermie-cards', JSON.stringify({ layout: 'grid', cards: [{ title: 'A', icon: 'star' }, { title: 'B' }] })),
    '',
    fence('hermie-chart', CHART),
    '',
    fence('hermie-chart', JSON.stringify({ type: 'pie', x: ['a', 'b'], series: [{ name: 's', values: [1, 2] }] })),
    '',
    '> [!WARNING]',
    '> Careful.',
    '',
    '> [!TIP]',
    '> A tip.',
    '',
    'A [link](https://example.org/page) and another.'
  ].join('\n')

  for (const locale of ['en', 'nl', 'de'] as const) {
    it(`has no violation in ${locale}`, async () => {
      setActiveLocale(locale)
      render(
        <main>
          <h1>Chat</h1>
          <Markdown headingOffset={2} text={REPLY} />
        </main>
      )

      expect(await violations()).toEqual([])
    })
  }
})
