/**
 * What the Markdown renderer actually paints, with the real block component.
 */
import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { marked } from 'marked'
import { Image } from 'react-native'

import { MarkdownBlock } from '../../src/markdown/Block'
import { Markdown } from '../../src/markdown/Markdown'
import { resetBlockCache } from '../../src/markdown/blocks'
import type { MarkdownContext } from '../../src/markdown/context'
import { highlightToLines, isKnownLanguage } from '../../src/markdown/highlight'
import { resolveImageUri } from '../../src/markdown/context'
import { preprocessMarkdown, trimUrlTail } from '../../src/markdown/preprocess'
import { ThemeProvider } from '../../src/ui/theme'

const DOCUMENT = [
  '# Title',
  '',
  'Body with **bold**, *italic*, ~~struck~~ and `code`.',
  '',
  '- one',
  '  - nested',
  '',
  '1. first',
  '',
  '> quoted',
  '',
  '| Area | Status |',
  '| --- | --- |',
  '| Recovery | Shipped |',
  '',
  '---',
  '',
  '```ts',
  'const a = 1',
  '```',
  '',
  '[link](https://example.com/x)'
].join('\n')

const CONTEXT: MarkdownContext = {
  blockBackground: '#EEEEEE',
  borderColor: '#DDDDDD',
  color: 'text',
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

describe('Markdown rendering', () => {
  beforeEach(resetBlockCache)

  it('renders every supported block kind', () => {
    const view = render(
      <ThemeProvider>
        <Markdown text={DOCUMENT} />
      </ThemeProvider>
    )

    expect(view.getByText('Title')).toBeTruthy()
    expect(view.getByText('quoted')).toBeTruthy()
    expect(view.getByText('nested')).toBeTruthy()
    expect(view.getByText('Recovery')).toBeTruthy()
    // The code block's language label.
    expect(view.getByText('TS')).toBeTruthy()
    expect(view.getByRole('link')).toBeTruthy()
  })

  it('opens a link through the injected handler', () => {
    const onLinkPress = jest.fn()

    const view = render(
      <ThemeProvider>
        <Markdown onLinkPress={onLinkPress} text="[link](https://example.com/x)" />
      </ThemeProvider>
    )

    act(() => {
      view.getByRole('link').props.onPress()
    })

    expect(onLinkPress).toHaveBeenCalledWith('https://example.com/x')
  })

  it('memoizes a block on its source text', () => {
    const lexer = jest.spyOn(marked, 'lexer')

    const view = render(
      <ThemeProvider>
        <MarkdownBlock context={CONTEXT} raw="Settled paragraph." />
      </ThemeProvider>
    )

    const afterFirst = lexer.mock.calls.length

    view.rerender(
      <ThemeProvider>
        <MarkdownBlock context={CONTEXT} raw="Settled paragraph." />
      </ThemeProvider>
    )

    expect(lexer.mock.calls.length).toBe(afterFirst)

    view.rerender(
      <ThemeProvider>
        <MarkdownBlock context={CONTEXT} raw="Settled paragraph. And more." />
      </ThemeProvider>
    )

    expect(lexer.mock.calls.length).toBeGreaterThan(afterFirst)

    lexer.mockRestore()
  })

  it('renders an unterminated fence as a code block while streaming', () => {
    const view = render(
      <ThemeProvider>
        <Markdown streaming text={'Here you go:\n\n```python\nprint("hi")'} />
      </ThemeProvider>
    )

    expect(view.getByText('PYTHON')).toBeTruthy()
  })
})

describe('preprocessMarkdown', () => {
  it('hides an unterminated reasoning block', () => {
    expect(preprocessMarkdown('<think>secret plan')).not.toContain('secret plan')
    expect(preprocessMarkdown('<think>secret</think>Visible.')).toContain('Visible.')
  })

  it('turns a MEDIA tag into a link', () => {
    expect(preprocessMarkdown('MEDIA:/srv/out/report.pdf')).toContain('[report.pdf](/srv/out/report.pdf)')
  })

  it('gives a table the blank line GFM needs', () => {
    const out = preprocessMarkdown('Intro line\n| a | b |\n| --- | --- |\n| 1 | 2 |')

    expect(out).toContain('Intro line\n\n| a | b |')
  })
})

/**
 * The bare-URL autolinker, which used to corrupt two very ordinary shapes: a
 * link whose visible text IS the URL, and a URL inside brackets. Both come out
 * of models constantly, and both rendered as visible `<…>` angle brackets or as
 * a link with a closing parenthesis inside the href.
 */
describe('autolinking bare URLs', () => {
  it('leaves a link whose label is the URL exactly as written', () => {
    expect(preprocessMarkdown('[https://foo.dev](https://foo.dev)')).toBe('[https://foo.dev](https://foo.dev)')
  })

  it('leaves an image and a reference link alone', () => {
    expect(preprocessMarkdown('![chart](https://foo.dev/c.png)')).toBe('![chart](https://foo.dev/c.png)')
  })

  it('gives a closing parenthesis back to the sentence', () => {
    expect(preprocessMarkdown('(see https://example.com)')).toBe('(see <https://example.com>)')
  })

  it('keeps a parenthesis the path itself opened', () => {
    expect(preprocessMarkdown('https://en.wikipedia.org/wiki/Foo_(bar)')).toBe(
      '<https://en.wikipedia.org/wiki/Foo_(bar)>'
    )
  })

  it('gives a trailing full stop back to the sentence', () => {
    expect(preprocessMarkdown('see https://example.com.')).toBe('see <https://example.com>.')
  })

  it('does not autolink an autolink twice', () => {
    expect(preprocessMarkdown('<https://example.com>')).toBe('<https://example.com>')
  })

  it('still links a plain URL in prose', () => {
    expect(preprocessMarkdown('read https://example.com now')).toBe('read <https://example.com> now')
  })
})

describe('trimUrlTail', () => {
  it('balances brackets rather than trusting the last character', () => {
    expect(trimUrlTail('https://x.dev/a)')).toBe('https://x.dev/a')
    expect(trimUrlTail('https://x.dev/a_(b)')).toBe('https://x.dev/a_(b)')
    expect(trimUrlTail('https://x.dev/a]')).toBe('https://x.dev/a')
    expect(trimUrlTail('https://x.dev/a[b]')).toBe('https://x.dev/a[b]')
  })

  it('strips the punctuation a sentence owns', () => {
    expect(trimUrlTail('https://x.dev/a,')).toBe('https://x.dev/a')
    expect(trimUrlTail('https://x.dev/a?!')).toBe('https://x.dev/a')
  })
})

describe('Markdown images', () => {
  it('resolves a gateway-relative source against the gateway', () => {
    expect(resolveImageUri('/api/files/1.png', 'https://gw.example.com')).toBe('https://gw.example.com/api/files/1.png')
    expect(resolveImageUri('/api/files/1.png', 'https://gw.example.com/')).toBe(
      'https://gw.example.com/api/files/1.png'
    )
  })

  it('leaves anything with a scheme of its own alone', () => {
    expect(resolveImageUri('https://cdn.example.com/a.png', 'https://gw.example.com')).toBe(
      'https://cdn.example.com/a.png'
    )
    expect(resolveImageUri('data:image/png;base64,AAAA', 'https://gw.example.com')).toBe('data:image/png;base64,AAAA')
  })

  it('hands a relative source back unchanged when there is no gateway to resolve it against', () => {
    expect(resolveImageUri('/api/files/1.png')).toBe('/api/files/1.png')
  })

  it('carries the gateway headers on the image request', () => {
    const headers = { Authorization: 'Bearer token' }

    render(
      <ThemeProvider>
        <Markdown images={{ baseUrl: 'https://gw.example.com', headers }} text="![chart](/api/files/1.png)" />
      </ThemeProvider>
    )

    const image = screen.UNSAFE_getByType(Image)

    expect(image.props.source).toMatchObject({ uri: 'https://gw.example.com/api/files/1.png', headers })
  })

  it('falls back to the alt text when the image cannot be fetched', () => {
    render(
      <ThemeProvider>
        <Markdown text="![a bar chart of weekly runs](https://gw.example.com/missing.png)" />
      </ThemeProvider>
    )

    act(() => {
      fireEvent(screen.UNSAFE_getByType(Image), 'error')
    })

    expect(screen.UNSAFE_queryAllByType(Image)).toHaveLength(0)
    expect(screen.getByText('a bar chart of weekly runs')).toBeTruthy()
  })
})

describe('highlighting', () => {
  it('knows the registered languages and their aliases', () => {
    expect(isKnownLanguage('ts')).toBe(true)
    expect(isKnownLanguage('yml')).toBe(true)
    expect(isKnownLanguage('dockerfile')).toBe(true)
    expect(isKnownLanguage('brainfuck')).toBe(false)
  })

  it('returns scoped spans per line', () => {
    const lines = highlightToLines('const a = "x"\nlet b = 2', 'ts')

    expect(lines).toHaveLength(2)
    expect(lines[0]?.[0]).toEqual({ scope: 'keyword', text: 'const' })
    expect(
      lines
        .flat()
        .map(span => span.text)
        .join('')
    ).toBe('const a = "x"let b = 2')
  })

  it('degrades to plain text for an unknown language', () => {
    expect(highlightToLines('whatever', 'nope')).toEqual([[{ text: 'whatever' }]])
  })
})
