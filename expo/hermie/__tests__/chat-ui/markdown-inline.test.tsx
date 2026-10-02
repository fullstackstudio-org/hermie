/**
 * Two inline bugs seen in real replies, pinned with the exact text that broke.
 *
 *   1. `** \`example.nl\` staat op autorenew=off**` rendered as literal
 *      asterisks. The lexer is right to do that — `**` followed by a space is
 *      not a left-flanking delimiter run, so it opens nothing and no `strong`
 *      token is ever emitted — so the repair belongs in `preprocess`.
 *   2. A wrapped inline-code span painted a background-coloured but EMPTY chip
 *      at the end of the previous line, because the chip's fake padding was an
 *      ASCII space and the line broke on it.
 *
 * Both are asserted on the rendered tree. A preprocessed string proves nothing
 * about what a reader sees, and "it renders" proves nothing at all.
 */
import { render } from '@testing-library/react-native'
import { marked } from 'marked'
import type { ReactElement } from 'react'
import { StyleSheet, type TextStyle } from 'react-native'
import type { Token } from 'marked'

import { inlineCodeRegressionItem } from '../../src/chat-ui/fixtures'
import { codeJoinFor } from '../../src/markdown/Inline'
import { Markdown } from '../../src/markdown/Markdown'
import { resetBlockCache } from '../../src/markdown/blocks'
import { MONOSPACE } from '../../src/markdown/context'
import { preprocessMarkdown, repairStrayEmphasisSpaces } from '../../src/markdown/preprocess'
import { ThemeProvider } from '../../src/ui/theme'
import { HAIRLINE, TINT_SUNK } from '../../src/ui/tokens'

/** The reply that started it, character for character. */
const AUTORENEW = '** `example.nl` staat op autorenew=off**'

interface RenderedNode {
  type: string
  props: { style?: unknown }
  children: (RenderedNode | string)[] | null
}

function descendants(node: RenderedNode | string | null): RenderedNode[] {
  if (!node || typeof node === 'string') {
    return []
  }

  return [node, ...(node.children ?? []).flatMap(descendants)]
}

function textOf(node: RenderedNode | string): string {
  if (typeof node === 'string') {
    return node
  }

  return (node.children ?? []).map(textOf).join('')
}

function styleOf(node: RenderedNode): TextStyle {
  return (StyleSheet.flatten(node.props.style as TextStyle) ?? {}) as TextStyle
}

function renderNodes(text: string): RenderedNode[] {
  const view = render(
    <ThemeProvider>
      <Markdown text={text} />
    </ThemeProvider>
  )

  return descendants(view.toJSON() as unknown as RenderedNode)
}

function boldNodes(nodes: RenderedNode[]): RenderedNode[] {
  return nodes.filter(node => styleOf(node).fontWeight === '700')
}

/** Every node painted as inline code: the chip style is the only marker. */
function codeNodes(nodes: RenderedNode[]): RenderedNode[] {
  return nodes.filter(node => styleOf(node).fontFamily === MONOSPACE && styleOf(node).backgroundColor !== undefined)
}

function hasStrong(tokens: Token[]): boolean {
  return tokens.some(token => token.type === 'strong' || hasStrong((token as { tokens?: Token[] }).tokens ?? []))
}

/** Is this text bold once it has been through the whole pipeline? */
function rendersBold(text: string): boolean {
  return hasStrong(marked.lexer(preprocessMarkdown(text)))
}

describe('bold a model opened with a stray space', () => {
  beforeEach(resetBlockCache)

  it('renders the autorenew reply bold, with its code chip intact', () => {
    const nodes = renderNodes(AUTORENEW)
    const bold = boldNodes(nodes)

    expect(bold).toHaveLength(1)

    // Joiners stripped: a code chip inside the bold run is one unbreakable token
    // and carries a word joiner between every pair of characters. See the chip
    // section below for why.
    const boldText = textOf(bold[0] as RenderedNode).replace(/\u2060/gu, '')

    expect(boldText).toContain('example.nl')
    expect(boldText).toContain('staat op autorenew=off')
    // The literal asterisks the reader used to see.
    expect(boldText).not.toContain('**')

    // The chip is INSIDE the bold span, not swallowed by it.
    const chips = codeNodes(descendants(bold[0] as RenderedNode))

    expect(chips).toHaveLength(1)
    expect(textOf(chips[0] as RenderedNode).replace(/\u2060/gu, '')).toContain('example.nl')
  })

  /**
   * The whole sentence, not the fragment.
   *
   * The fragment passed here while the device printed the asterisks, because
   * what broke was the mask over the OTHER two code spans in the same line
   * (see `src/markdown/marked-compat.ts`). Rendering the real reply is the only
   * version of this test that would have caught it.
   */
  it('renders the reply that reported it, every code span in place', () => {
    const nodes = renderNodes(inlineCodeRegressionItem.text ?? '')
    const line = textOf(nodes[0] as RenderedNode)

    expect(line).not.toContain('**')
    // The two characters an off-by-two closing delimiter ate on the device.
    expect(line).toContain('autorenew=off')

    const bold = boldNodes(nodes)

    expect(bold).toHaveLength(1)
    expect(textOf(bold[0] as RenderedNode)).toContain('staat op autorenew=off')

    // All three chips survive: the two outside the bold span and the one in it.
    expect(codeNodes(nodes)).toHaveLength(3)
  })

  it('renders the mirror shape bold too', () => {
    const bold = boldNodes(renderNodes('**autorenew staat op off **'))

    expect(bold).toHaveLength(1)
    expect(textOf(bold[0] as RenderedNode)).toBe('autorenew staat op off')
  })

  it('leaves the arithmetic shape as literal asterisks', () => {
    const nodes = renderNodes('a ** b ** c')

    expect(boldNodes(nodes)).toHaveLength(0)
    expect(textOf(nodes[0] as RenderedNode)).toContain('a ** b ** c')
  })
})

/**
 * preprocess directly, so a future "simplification" trips on the conservative
 * cases rather than on a rendering nobody is looking at.
 */
describe('repairStrayEmphasisSpaces', () => {
  it('drops the space the opening delimiter was broken by', () => {
    expect(repairStrayEmphasisSpaces(AUTORENEW)).toBe('**`example.nl` staat op autorenew=off**')
    expect(repairStrayEmphasisSpaces('** bold**')).toBe('**bold**')
    expect(repairStrayEmphasisSpaces('**  two spaces**')).toBe('**two spaces**')
    expect(repairStrayEmphasisSpaces('__ under__')).toBe('__under__')
  })

  it('drops the space before a broken closing delimiter', () => {
    expect(repairStrayEmphasisSpaces('**bold **')).toBe('**bold**')
    expect(repairStrayEmphasisSpaces('__under __')).toBe('__under__')
  })

  it('repairs each pair on a line independently', () => {
    expect(repairStrayEmphasisSpaces('x ** y** z ** w**')).toBe('x **y** z **w**')
  })

  it('leaves both-ends-broken alone: arithmetic and literal asterisks', () => {
    expect(repairStrayEmphasisSpaces('a ** b ** c')).toBe('a ** b ** c')
    expect(repairStrayEmphasisSpaces('2 ** 3 ** 4')).toBe('2 ** 3 ** 4')
    expect(repairStrayEmphasisSpaces('** bold **')).toBe('** bold **')
    expect(repairStrayEmphasisSpaces('** `a` **')).toBe('** `a` **')
  })

  it('leaves a delimiter with no partner alone', () => {
    expect(repairStrayEmphasisSpaces('** lone')).toBe('** lone')
    expect(repairStrayEmphasisSpaces('ends on **')).toBe('ends on **')
    expect(repairStrayEmphasisSpaces('** one\ntwo **')).toBe('** one\ntwo **')
  })

  it('leaves a bold-italic run and a rule made of asterisks alone', () => {
    expect(repairStrayEmphasisSpaces('*** bold italic ***')).toBe('*** bold italic ***')
    expect(repairStrayEmphasisSpaces('***bold italic***')).toBe('***bold italic***')
    expect(repairStrayEmphasisSpaces('***')).toBe('***')
    expect(repairStrayEmphasisSpaces('* * *')).toBe('* * *')
    expect(repairStrayEmphasisSpaces('___')).toBe('___')
  })

  it('leaves list bullets alone', () => {
    expect(repairStrayEmphasisSpaces('* item\n* other')).toBe('* item\n* other')
    // A bullet whose CONTENT is broken bold is still repaired.
    expect(repairStrayEmphasisSpaces('- ** listed**')).toBe('- **listed**')
  })

  it('never produces a delimiter pair the lexer would still refuse', () => {
    // `see**(x)**` is not left-flanking either: punctuation after, word before.
    expect(repairStrayEmphasisSpaces('see** (x)**')).toBe('see** (x)**')
  })

  it('keeps its hands off inline code and fenced code', () => {
    expect(preprocessMarkdown('`** in code**`')).toBe('`** in code**`')
    expect(preprocessMarkdown('```\n** in fence**\n```')).toBe('```\n** in fence**\n```')
  })

  it('is idempotent', () => {
    for (const input of [AUTORENEW, '**bold **', 'a ** b ** c', '***bold italic***', '- ** listed**']) {
      const once = repairStrayEmphasisSpaces(input)

      expect(repairStrayEmphasisSpaces(once)).toBe(once)
    }
  })
})

/**
 * preprocess runs on the ACCUMULATED text on every flush, so the transform has
 * to settle a half-arrived run rather than flip it. Bold switching on and then
 * off again is the artefact a reader would actually notice.
 */
describe('streaming a stray-space bold', () => {
  function boldStates(text: string): boolean[] {
    return Array.from({ length: text.length }, (_, index) => rendersBold(text.slice(0, index + 1)))
  }

  function flipCount(states: boolean[]): number {
    return states.filter((state, index) => index > 0 && state !== states[index - 1]).length
  }

  it('turns the autorenew reply bold exactly once, at the closing delimiter', () => {
    const states = boldStates(AUTORENEW)

    expect(flipCount(states)).toBe(1)
    expect(states.at(-1)).toBe(true)
  })

  it('turns the mirror shape bold exactly once', () => {
    const states = boldStates('**bold ** and more')

    expect(flipCount(states)).toBe(1)
    expect(states.at(-1)).toBe(true)
  })

  it('never turns the arithmetic shape bold at all', () => {
    expect(boldStates('a ** b ** c').some(Boolean)).toBe(false)
  })
})

/**
 * The empty chip.
 *
 * A background-coloured nested `Text` paints every line fragment of its range,
 * and a fragment holding only the line's trailing whitespace is painted across
 * the whole remaining line width — which is the near-black bar the owner saw in
 * an incoming bubble. Line breaking itself cannot be exercised here (the test
 * renderer does no text layout), so what is asserted is the CAUSE: the chip must
 * contain no breakable and no collapsible whitespace at all.
 */
describe('inline code chips', () => {
  beforeEach(resetBlockCache)

  /** The sentence from the running Mac build that painted the bar. */
  const TESTMAIL = 'Ik zag een testmail van gisteren naar `test@example.com`. Dat is niets om je zorgen over te maken.'

  /** What is actually drawn, with the invisible joiners taken out. */
  const visible = (chip: RenderedNode) => textOf(chip).replace(/[\u2060\u200b]/gu, '')

  it('pads the chip with non-breaking spaces, never an ASCII one', () => {
    const chips = codeNodes(renderNodes(TESTMAIL))

    expect(chips).toHaveLength(1)
    expect(visible(chips[0] as RenderedNode)).toBe('\u00a0test@example.com\u00a0')
  })

  it('leaves no whitespace a line break could strand inside a chip', () => {
    const inputs = [
      TESTMAIL,
      'A long sentence that has to wrap, with `a-rather-long-inline-code-span` near its end.',
      'Run `git commit --amend` again',
      'Spaced ``  padded  `` chip'
    ]

    for (const input of inputs) {
      const chips = codeNodes(renderNodes(input))

      expect(chips.length).toBeGreaterThan(0)

      for (const chip of chips) {
        const content = visible(chip)

        // Every space is non-breaking, so no break can land on one and leave a
        // whitespace-only fragment behind. An ASCII space here is the bug.
        expect(content).not.toMatch(/[ \t]/u)
        // The chip's own edges cannot break at all: it travels whole.
        expect(content.startsWith('\u00a0')).toBe(true)
        expect(content.endsWith('\u00a0')).toBe(true)
        // And it is never padding alone.
        expect(content.replace(/\s/gu, '').length).toBeGreaterThan(0)
      }
    }
  })

  /**
   * The two spans the owner photographed on the iPad build. Both grew EMPTY to
   * the end of the line and continued mid-span on the next one, because UAX #14
   * offers a break after `:` and after `.`, and inside a run of capitals with a
   * space in it — and React Native paints the background of every line fragment
   * of a nested `Text`'s range.
   *
   * Line breaking cannot be exercised here; the test renderer lays out no text.
   * What is asserted is the CAUSE: there is no break opportunity left anywhere
   * inside a chip, so the line breaker has to move the whole thing down.
   */
  it.each([
    ['a domain with a colon and a dot', 'Check `sc-domain:hermie.dev` in Search Console'],
    ['a phrase in capitals', 'Status: `WACHT OP VERIFICATIE` sinds gisteren'],
    ['a path', 'Open `expo/hermie/src/markdown/Inline.tsx` and read it'],
    ['a URL', 'Try `https://hermie.dev/docs?q=1` for the docs']
  ])('offers no break opportunity inside %s', (_name, source) => {
    const chip = codeNodes(renderNodes(source))[0] as RenderedNode
    const content = textOf(chip)
    const points = [...content]

    // A word joiner between EVERY pair, so a break can land nowhere inside —
    // not at the colon, not at the dot, not at a slash, not at a space that was
    // turned into a non-breaking one.
    for (let index = 1; index < points.length; index += 2) {
      expect(points[index]).toBe('\u2060')
    }

    // And nothing that invites one: with no measured width the chip is treated
    // as one that fits, and one that fits is one token that goes to the next
    // line whole.
    expect(content).not.toContain('\u200b')
  })

  it('keeps every character of the code, in order', () => {
    // The joiners are invisible and zero-width; they must not have eaten or
    // reordered anything a reader is looking at.
    const chip = codeNodes(renderNodes('Check `sc-domain:hermie.dev` today'))[0] as RenderedNode

    expect(visible(chip)).toBe('\u00a0sc-domain:hermie.dev\u00a0')
  })

  it('carries a multi-word span across as one token, gaps and all', () => {
    const chips = codeNodes(renderNodes('Run `git commit --amend` again'))

    expect(chips).toHaveLength(1)
    // The gaps keep their WIDTH as non-breaking spaces. They used to carry a
    // zero-width break in front of them so the chip could wrap on its own word
    // boundaries; that is exactly the break the owner did not want.
    expect(visible(chips[0] as RenderedNode)).toBe('\u00a0git\u00a0commit\u00a0--amend\u00a0')
  })

  it('treats whitespace at the edge of the code as padding, not a wrap point', () => {
    const chips = codeNodes(renderNodes('Spaced ``  padded  `` chip'))

    expect(chips).toHaveLength(1)

    const content = visible(chips[0] as RenderedNode)

    expect(content).toContain('padded')
    expect(content.startsWith('\u00a0\u00a0')).toBe(true)
    expect(content.endsWith('\u00a0\u00a0')).toBe(true)
  })
})

/**
 * The chip's colour. It used to borrow the code-BLOCK surface, which the bubble
 * hands in as an opaque near-black in dark mode — a redaction bar through a
 * sentence rather than a code chip.
 */
describe('inline code chip colour', () => {
  beforeEach(resetBlockCache)

  function chipStyle(node: ReactElement): TextStyle {
    const nodes = descendants(render(<ThemeProvider>{node}</ThemeProvider>).toJSON() as unknown as RenderedNode)
    const chips = nodes.filter(candidate => styleOf(candidate).fontFamily === MONOSPACE)

    expect(chips).toHaveLength(1)

    return styleOf(chips[0] as RenderedNode)
  }

  it('defaults to the theme sunk tint, not the code-block surface', () => {
    const style = chipStyle(<Markdown text="a `chip` here" />)

    expect(Object.values(TINT_SUNK)).toContain(style.backgroundColor)
    expect(Object.values(HAIRLINE)).toContain(style.borderColor)
  })

  it('does not take the code-block surface a bubble passes in', () => {
    const style = chipStyle(<Markdown surface="#1B1B1F" text="a `chip` here" />)

    expect(style.backgroundColor).not.toBe('#1B1B1F')
    expect(Object.values(TINT_SUNK)).toContain(style.backgroundColor)
  })

  it('lets a caller override the chip colours per bubble', () => {
    const style = chipStyle(
      <Markdown inlineCodeBackground="rgba(1,2,3,0.1)" inlineCodeBorderColor="rgba(4,5,6,0.2)" text="a `chip` here" />
    )

    expect(style.backgroundColor).toBe('rgba(1,2,3,0.1)')
    expect(style.borderColor).toBe('rgba(4,5,6,0.2)')
  })

  it('keeps the chip text in the body colour and a monospace face', () => {
    const style = chipStyle(<Markdown text="a `chip` here" />)

    expect(style.fontFamily).toBe(MONOSPACE)
    expect(style.color).toBeTruthy()
  })
})

/**
 * The half of the owner's rule the joiner alone could not reach.
 *
 * Verbatim: "if the chip fits on one line, move it whole to the next line so it
 * need not break; if it does not fit on a line, break per letter; never a
 * background without glyphs under it."
 *
 * Gluing every pair says the first clause and, on a chip wider than the line,
 * breaks the third: a run that can never break and can never fit makes the
 * typesetter open a line, put no glyphs on it and try the next one — and React
 * Native paints that empty fragment's background right across the line. So the
 * join is a DECISION, and this is the decision on its own, where the numbers are
 * visible and a test renderer's lack of text layout does not matter.
 */
describe('how wide a chip is allowed to be before it may break', () => {
  // The chip's own size on a 17pt body, and roughly a phone bubble's width.
  const fontSize = 15
  const lineWidth = 250

  it('glues a chip that fits, so it travels to the next line whole', () => {
    expect(codeJoinFor({ characters: 20, fontSize, lineWidth })).toBe('\u2060')
  })

  it('lets a chip wider than the line break, because it has to break somewhere', () => {
    // 0.6 em a character: 28 fit, 29 do not.
    expect(codeJoinFor({ characters: 27, fontSize, lineWidth })).toBe('\u2060')
    expect(codeJoinFor({ characters: 29, fontSize, lineWidth })).toBe('\u200b')
  })

  it('treats an unmeasured paragraph as one the chip fits on', () => {
    // The first frame, and every caller that never measures. Gluing is right for
    // every chip short enough to be common, and wrong for one frame otherwise.
    expect(codeJoinFor({ characters: 400, fontSize })).toBe('\u2060')
    expect(codeJoinFor({ characters: 400, fontSize, lineWidth: 0 })).toBe('\u2060')
  })

  it('scales with the type, not with the character count alone', () => {
    // The same chip, at a size where it no longer fits.
    expect(codeJoinFor({ characters: 25, fontSize: 15, lineWidth })).toBe('\u2060')
    expect(codeJoinFor({ characters: 25, fontSize: 28, lineWidth })).toBe('\u200b')
  })
})
