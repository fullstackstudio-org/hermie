/**
 * Highlighting is paid for once per listing: remembered across mounts, and,
 * while a listing grows, done again at most every STREAM_HIGHLIGHT_MS with the
 * new tail drawn plain in between.
 */
import type * as HighlightModule from '@hermie/markdown/highlight'
import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  cachedLines,
  clearHighlightCache,
  HIGHLIGHT_CACHE_SIZE,
  HighlightedCode,
  STREAM_HIGHLIGHT_MS
} from './Highlight'

const highlight = vi.hoisted(() => ({ calls: 0 }))

vi.mock('@hermie/markdown/highlight', async importOriginal => {
  const actual = await importOriginal<typeof HighlightModule>()

  return {
    ...actual,
    highlightToLines: (code: string, language?: string) => {
      highlight.calls += 1

      return actual.highlightToLines(code, language)
    }
  }
})

beforeEach(() => {
  clearHighlightCache()
  highlight.calls = 0
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the highlight cache', () => {
  it('highlights a listing once, however many times it is drawn', () => {
    const first = render(<HighlightedCode code="const a = 1" language="ts" />)

    first.unmount()
    render(<HighlightedCode code="const a = 1" language="ts" />)
    render(<HighlightedCode code="const a = 1" language="ts" />)

    expect(highlight.calls).toBe(1)
    expect(cachedLines('const a = 1', 'ts')).toBe(cachedLines('const a = 1', 'ts'))
    expect(highlight.calls).toBe(1)
  })

  it('keeps the same text apart per language', () => {
    cachedLines('x = 1', 'ts')
    cachedLines('x = 1', 'python')

    expect(highlight.calls).toBe(2)
  })

  it('forgets the least recently used listing first', () => {
    for (let index = 0; index < HIGHLIGHT_CACHE_SIZE; index += 1) {
      cachedLines(`const a${index} = 1`, 'ts')
    }

    // Touch the oldest, so the second oldest is the one to go.
    cachedLines('const a0 = 1', 'ts')
    cachedLines('const fresh = 1', 'ts')
    highlight.calls = 0

    cachedLines('const a0 = 1', 'ts')
    expect(highlight.calls).toBe(0)
    cachedLines('const a1 = 1', 'ts')
    expect(highlight.calls).toBe(1)
  })
})

describe('a listing that grows', () => {
  it('keeps its coloured part, draws the new tail plain, and colours it again at most every pass', () => {
    vi.useFakeTimers()

    const { container, rerender } = render(<HighlightedCode code="const a = 1" language="ts" />)

    expect(highlight.calls).toBe(1)

    rerender(<HighlightedCode code={'const a = 1\nconst b'} language="ts" />)
    rerender(<HighlightedCode code={'const a = 1\nconst b = 2'} language="ts" />)
    rerender(<HighlightedCode code={'const a = 1\nconst b = 22'} language="ts" />)

    // Three deltas, no new pass yet: the text is whole, the new part is plain.
    expect(highlight.calls).toBe(1)
    expect(container.textContent).toBe('const a = 1\nconst b = 22')
    expect(container.querySelectorAll('.md-hl-keyword')).toHaveLength(1)

    act(() => {
      vi.advanceTimersByTime(STREAM_HIGHLIGHT_MS)
    })

    expect(highlight.calls).toBe(2)
    expect(container.textContent).toBe('const a = 1\nconst b = 22')
    expect(container.querySelectorAll('.md-hl-keyword')).toHaveLength(2)

    // Settled: no further pass without a further change.
    act(() => {
      vi.advanceTimersByTime(STREAM_HIGHLIGHT_MS * 3)
    })
    expect(highlight.calls).toBe(2)
  })

  it('draws a change that is not a growth plain until the next pass', () => {
    vi.useFakeTimers()

    const { container, rerender } = render(<HighlightedCode code="const a = 1" language="ts" />)

    rerender(<HighlightedCode code="let a = 1" language="ts" />)

    expect(container.textContent).toBe('let a = 1')
    expect(container.querySelector('.md-hl')).toBeNull()

    act(() => {
      vi.advanceTimersByTime(STREAM_HIGHLIGHT_MS)
    })

    expect(container.querySelector('.md-hl-keyword')?.textContent).toBe('let')
  })
})
