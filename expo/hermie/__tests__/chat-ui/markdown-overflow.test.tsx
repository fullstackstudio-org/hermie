/**
 * Content wider than the bubble it lands in.
 *
 * The owner photographed a table on the phone whose cells ended mid-word at the
 * bubble's right edge, with no way to drag it sideways. Both halves of that were
 * true: it was clipped, and it did not scroll. The cause is one layout rule —
 * `src/markdown/OverflowScroll.tsx` has it, measured on a simulator — and the
 * fix is that the two blocks which can be too wide are told how much room they
 * have instead of being left to find out from content they are themselves
 * sizing.
 *
 * What a component test can and cannot see: the test renderer lays nothing out,
 * so none of this can be asserted from a rendered width. What it CAN assert is
 * the decision — scroll or not, and how wide the box was told to be — which is
 * exactly the part that was wrong.
 */
import { render, screen } from '@testing-library/react-native'

import { MarkdownBlock, tableColumnWidths, tableFitsInline, tableNaturalWidth } from '../../src/markdown/Block'
import { codeNaturalWidth } from '../../src/markdown/CodeBlock'
import { Markdown } from '../../src/markdown/Markdown'
import { resetBlockCache } from '../../src/markdown/blocks'
import { marked } from '../../src/markdown/marked-compat'
import type { MarkdownContext } from '../../src/markdown/context'
import { codeJoinFor } from '../../src/markdown/Inline'
import { ThemeProvider } from '../../src/ui/theme'

const BASE: MarkdownContext = {
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

function context(extra: Partial<MarkdownContext> = {}): MarkdownContext {
  return { ...BASE, ...extra }
}

/** Six columns: wider than a phone bubble and wider than the 640pt one too. */
const WIDE_TABLE = [
  '| Registrar | Domain | Renews | Autorenew | Nameservers | Owner |',
  '| --- | --- | --- | --- | --- | --- |',
  '| Registrar One | docs.example.org | 2026-10-04 | off | ns1.example.net | Operations |'
].join('\n')

/** Two short columns: narrower than any bubble this app draws. */
const NARROW_TABLE = ['| Area | Status |', '| --- | --- |', '| Recovery | Shipped |'].join('\n')

function renderBlock(raw: string, ctx: MarkdownContext) {
  return render(
    <ThemeProvider>
      <MarkdownBlock context={ctx} raw={raw} />
    </ThemeProvider>
  )
}

function widthsOf(source: string): number[] {
  const token = marked.lexer(source)[0]

  return tableColumnWidths(token as Parameters<typeof tableColumnWidths>[0], BASE.fontSize)
}

beforeEach(resetBlockCache)

describe('how wide a table wants to be', () => {
  it('sums its columns and the hairline on each side', () => {
    expect(tableNaturalWidth([100, 200, 50])).toBe(352)
    expect(tableNaturalWidth([])).toBe(2)
  })

  it('derives a column from its longest cell, within a floor and a ceiling', () => {
    const [registrar, domain] = widthsOf(WIDE_TABLE)

    // `Registrar One` is longer than `Registrar`, so the column is the value's.
    expect(registrar).toBeGreaterThan(110)
    expect(domain).toBeGreaterThan(registrar)
    // Nothing is allowed past the ceiling: a prose cell wraps like prose.
    expect(Math.max(...widthsOf(WIDE_TABLE))).toBeLessThanOrEqual(280)
  })

  it('says a narrow table fits and a wide one does not, once the room is known', () => {
    expect(tableFitsInline(tableNaturalWidth(widthsOf(NARROW_TABLE)), 320)).toBe(true)
    expect(tableFitsInline(tableNaturalWidth(widthsOf(WIDE_TABLE)), 320)).toBe(false)
  })

  it('refuses to call it a fit when nobody measured the room', () => {
    // The honest answer for a caller that cannot supply a width: keep the
    // scrolling surface rather than claim the table fits in a width nobody knows.
    expect(tableFitsInline(120, undefined)).toBe(false)
    expect(tableFitsInline(120, 0)).toBe(false)
  })
})

describe('a table in a bubble', () => {
  it('scrolls, at the width it was given, when it is wider than the room', () => {
    renderBlock(WIDE_TABLE, context({ contentWidth: 320 }))

    const scroll = screen.getByTestId('markdown-table-scroll')

    // The width is the whole point. A horizontal scroll view with no frame of
    // its own is as wide as its content and therefore has nothing to scroll.
    expect(scroll.props.style).toEqual(expect.arrayContaining([expect.objectContaining({ width: 320 })]))
  })

  it('gets no scrolling surface at all when it fits', () => {
    renderBlock(NARROW_TABLE, context({ contentWidth: 320 }))

    expect(screen.queryByTestId('markdown-table-scroll')).toBeNull()
    expect(screen.getByText('Recovery')).toBeTruthy()
  })

  it('keeps the scrolling surface where the room is unknown', () => {
    // Every caller that does not measure — a gallery section, a ledger row —
    // keeps exactly the behaviour it had before the width existed.
    renderBlock(NARROW_TABLE, context())

    expect(screen.getByTestId('markdown-table-scroll')).toBeTruthy()
  })

  it('does not let a vertical drag over it scroll sideways instead', () => {
    renderBlock(WIDE_TABLE, context({ contentWidth: 320 }))

    const scroll = screen.UNSAFE_getByProps({ horizontal: true })

    // The transcript under the table has to keep scrolling when a finger moves
    // up or down over it. `nestedScrollEnabled` is the Android half of the rule.
    expect(scroll.props.directionalLockEnabled).toBe(true)
    expect(scroll.props.nestedScrollEnabled).toBe(true)
    expect(scroll.props.showsHorizontalScrollIndicator).toBe(false)
  })
})

describe('how wide a listing wants to be', () => {
  it('measures the longest line, not the whole listing', () => {
    const short = codeNaturalWidth('ok', 13)
    const long = codeNaturalWidth(`ok\n${'x'.repeat(200)}`, 13)

    expect(long).toBeGreaterThan(short)
    // 0.6 em a character, plus the padding on both sides and the hairline.
    expect(long).toBe(Math.ceil(200 * 13 * 0.6) + 26)
  })

  it('counts a surrogate pair as one character', () => {
    expect(codeNaturalWidth('😀😀', 13)).toBe(codeNaturalWidth('ab', 13))
  })
})

describe('a fenced block in a bubble', () => {
  const LONG = ['```sh', `curl --silent https://gateway.example.org/api/v1/${'segment/'.repeat(30)}end`, '```'].join(
    '\n'
  )

  it('never grows past the room it was given', () => {
    renderBlock(LONG, context({ contentWidth: 320 }))

    const scroll = screen.getByTestId('markdown-code-scroll')

    // The box is 320 and the listing's viewport is that minus the hairline on
    // each side; the listing itself is far wider and scrolls inside it.
    expect(scroll.props.style).toEqual(expect.arrayContaining([expect.objectContaining({ width: 318 })]))
  })

  it('still hugs a listing that is shorter than the room', () => {
    renderBlock('```sh\nls\n```', context({ contentWidth: 320 }))

    const scroll = screen.getByTestId('markdown-code-scroll')
    const width = codeNaturalWidth('ls', 13) - 2

    expect(scroll.props.style).toEqual(expect.arrayContaining([expect.objectContaining({ width })]))
  })

  it('keeps its frameless scroll where the room is unknown', () => {
    renderBlock(LONG, context())

    const scroll = screen.getByTestId('markdown-code-scroll')

    expect(scroll.props.style).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ width: expect.anything() })])
    )
  })
})

describe('an unbreakable token in prose', () => {
  it('is one run inside the paragraph, so the paragraph wraps it', () => {
    // A hash has no break opportunity in it at all. Nothing here may put it in
    // a box of its own: inside the paragraph's `Text` the typesetter falls back
    // to a per-character break, and outside one it would clip the bubble.
    const digest = '9f2c41b8e7d6a5039c81be24f7a0d95e3b6c17482fd0ae95c3b1d87f604ea2b1'

    render(
      <ThemeProvider>
        <Markdown maxContentWidth={320} text={`Its digest is ${digest}, from the sweep.`} />
      </ThemeProvider>
    )

    // One `Text` holding the whole sentence, hash included — not a hash in a
    // box beside a sentence, which is the shape that clips.
    const paragraph = screen.getByText(`Its digest is ${digest}, from the sweep.`)

    // No line cap anywhere: a truncated hash is a wrong hash.
    expect(paragraph.props.numberOfLines).toBeUndefined()
  })

  it('lets a code chip too wide for the line break per character', () => {
    const fontSize = 15

    // The chip's own rule, restated here because it is the same complaint: a
    // token that cannot fit must break rather than run off the edge.
    expect(codeJoinFor({ characters: 12, fontSize, lineWidth: 320 })).toBe('⁠')
    expect(codeJoinFor({ characters: 64, fontSize, lineWidth: 320 })).toBe('​')
  })
})
