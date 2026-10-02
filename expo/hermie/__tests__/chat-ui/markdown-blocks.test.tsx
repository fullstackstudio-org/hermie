/**
 * The streaming contract of the Markdown renderer.
 *
 * Two claims are load-bearing and neither is visible on screen, so they are
 * asserted here: a settled block keeps its exact source across flushes, and
 * `Markdown` hands each block stable props, so a memoized block is not
 * re-rendered while the tail of a long reply arrives.
 *
 * The block component is replaced by a memoized recorder. That is the honest
 * seam: what is under test is what `Markdown` PASSES, and a real block would
 * only add its own lexing to the measurement.
 */
import { render } from '@testing-library/react-native'
import { useEffect, useState } from 'react'

import { Markdown } from '../../src/markdown/Markdown'
import { resetBlockCache, splitBlocks } from '../../src/markdown/blocks'
import { preprocessMarkdown } from '../../src/markdown/preprocess'
import { ThemeProvider } from '../../src/ui/theme'

const mockBlockRenders: string[] = []

jest.mock('../../src/markdown/Block', () => {
  const React = require('react')
  const { Text } = require('react-native')

  return {
    MarkdownBlock: React.memo(function MockMarkdownBlock({ raw }: { raw: string }) {
      mockBlockRenders.push(raw)

      return React.createElement(Text, null, raw)
    })
  }
})

function buildReply(paragraphs: number): string {
  return Array.from(
    { length: paragraphs },
    (_, index) => `## Section ${index}\n\nParagraph ${index} with some **bold** text and a \`token\`.`
  ).join('\n\n')
}

/** Drives `text` from inside one component, the way a delta stream would. */
function StreamingHarness({ chunks }: { chunks: string[] }) {
  const [index, setIndex] = useState(0)

  useEffect(() => {
    if (index < chunks.length - 1) {
      setIndex(current => current + 1)
    }
  }, [chunks.length, index])

  return <Markdown text={chunks[index] ?? ''} />
}

describe('markdown block splitting', () => {
  beforeEach(() => {
    resetBlockCache()
    mockBlockRenders.length = 0
  })

  it('cuts the source into blocks that reconstruct it exactly', () => {
    const text = buildReply(6)
    const blocks = splitBlocks(text)

    expect(blocks.length).toBeGreaterThan(6)
    expect(blocks.join('')).toBe(text)
  })

  it('returns the same array identity for the same text', () => {
    const text = buildReply(3)

    expect(splitBlocks(text)).toBe(splitBlocks(text))
  })

  it('reuses settled blocks when the text only grew', () => {
    // Long enough to cross the append cache's minimum length, which is what
    // the incremental path is gated on.
    const settled = buildReply(40)
    const grown = `${settled}\n\nParagraph 40 arrives.`

    const before = splitBlocks(settled)
    const after = splitBlocks(grown)

    expect(after.join('')).toBe(grown)
    expect(after.slice(0, before.length - 3)).toEqual(before.slice(0, before.length - 3))
  })

  it('keeps an unterminated fence a code block', () => {
    const blocks = splitBlocks(preprocessMarkdown('Here you go:\n\n```ts\nconst a = 1'))

    expect(blocks.some(block => block.startsWith('```ts'))).toBe(true)
  })
})

describe('Markdown streaming', () => {
  beforeEach(() => {
    resetBlockCache()
    mockBlockRenders.length = 0
  })

  it('renders a 20 KB reply without re-rendering settled blocks', () => {
    const full = buildReply(320)

    expect(full.length).toBeGreaterThan(20 * 1024)

    // 40 flushes, the way a stream of deltas arrives.
    const chunks = Array.from({ length: 40 }, (_, step) => full.slice(0, Math.round(((step + 1) / 40) * full.length)))

    render(
      <ThemeProvider>
        <StreamingHarness chunks={chunks} />
      </ThemeProvider>
    )

    const rendersByRaw = new Map<string, number>()

    for (const raw of mockBlockRenders) {
      rendersByRaw.set(raw, (rendersByRaw.get(raw) ?? 0) + 1)
    }

    const finalBlocks = splitBlocks(preprocessMarkdown(full))
    // The unsettled tail may re-render on every flush; nothing before it may.
    // Four blocks of slack matches the splitter's own settled boundary.
    const settled = finalBlocks.slice(0, Math.max(0, finalBlocks.length - 4)).filter(raw => raw.trim())

    expect(settled.length).toBeGreaterThan(100)

    // ONCE, now that nothing marks the tail. It was twice while the tail
    // carried a streaming caret and rendered again when the caret moved on to
    // the next block; the caret is gone — see `markdown/Block.tsx`. Never
    // per delta — that is the whole point.
    for (const raw of settled) {
      expect(rendersByRaw.get(raw) ?? 0).toBeLessThanOrEqual(1)
    }

    // The budget, stated as a total. Without memoization this would be roughly
    // blocks × flushes; it is a small multiple of the block count instead.
    expect(mockBlockRenders.length).toBeLessThan(finalBlocks.length * 3)
    expect(mockBlockRenders.length).toBeLessThan(finalBlocks.length * chunks.length * 0.1)
  })

  it('renders each non-empty block exactly once when nothing streams', () => {
    const text = buildReply(5)

    const view = render(
      <ThemeProvider>
        <Markdown text={text} />
      </ThemeProvider>
    )

    view.rerender(
      <ThemeProvider>
        <Markdown text={text} />
      </ThemeProvider>
    )

    const counts = new Map<string, number>()

    // Whitespace-only separators all share the raw `\n\n`, so counting them by
    // source would conflate blocks that are genuinely distinct.
    for (const raw of mockBlockRenders.filter(raw => raw.trim())) {
      counts.set(raw, (counts.get(raw) ?? 0) + 1)
    }

    expect(counts.size).toBeGreaterThan(5)

    for (const count of counts.values()) {
      expect(count).toBe(1)
    }
  })
})
