/**
 * `Show more` on the web build, where the hold is the bug rather than the fix.
 *
 * The native list keeps the reader's place across an expansion by hand, because
 * an inverted `UIScrollView` pins the growing cell's BOTTOM edge — see
 * `transcript-anchor.test.tsx`, which pins all four reports of that. A browser
 * pins the other edge on its own: an inverted list is a flipped scroller over
 * flipped cells, `scrollTop` survives a content change, and everything below the
 * growth — the `Show more` control included — therefore does not move. Measured
 * on that DOM, and written down in `platform/scroll-anchor.web.ts`.
 *
 * So the same arithmetic that fixes the native list displaces the web one by
 * exactly the fold's growth. What the seam does is refuse to hold; what this
 * file asserts is that refusing costs the list nothing else.
 */
import { act, fireEvent, screen } from '@testing-library/react-native'
import { FlatList } from 'react-native'

import { TranscriptList } from '../../src/chat-ui'
import { assistantItem, subagentMap, userItem } from '../../src/chat-ui/fixtures'
import type { AssistantItem, VisibleItem } from '../../src/chat-ui/types'
import { renderScreen } from '../support/render'

// Hoisted above the imports by babel, so the list sees the web value from its
// first render. Written here so the import block stays one block.
jest.mock('../../src/platform/scroll-anchor', () => ({ ANCHORS_GROWTH_ITSELF: true }))

const visible = (items: { id: string }[]): VisibleItem[] =>
  items.map(item => ({ item, presentation: 'collapsed' }) as VisibleItem)

const HEIGHT = 4000
const long: AssistantItem = { ...assistantItem, id: 'a-long', streaming: false, text: 'x'.repeat(HEIGHT) }

function scrollTo(y: number): void {
  fireEvent.scroll(screen.getByTestId('transcript-list-scroll'), {
    nativeEvent: {
      contentOffset: { x: 0, y },
      contentSize: { height: 2000, width: 402 },
      layoutMeasurement: { height: 800, width: 402 }
    }
  })
}

/** One layout pass of the CONTENT, the way the scroll view reports it. */
function grewTo(content: number): void {
  act(() => {
    fireEvent(screen.getByTestId('transcript-list-scroll'), 'contentSizeChange', 402, content)
  })
}

function press(): void {
  act(() => {
    fireEvent(screen.getByTestId(`assistant-fold-${long.id}-body`), 'layout', {
      nativeEvent: { layout: { height: HEIGHT } }
    })
  })

  fireEvent.press(screen.getByTestId(`assistant-fold-${long.id}-toggle`))
}

describe('a platform that anchors growth itself', () => {
  let scrollToOffset: jest.SpyInstance

  beforeEach(() => {
    scrollToOffset = jest.spyOn(FlatList.prototype, 'scrollToOffset').mockImplementation(() => {})
  })

  afterEach(() => {
    scrollToOffset.mockRestore()
  })

  it('does not move the list when a fold opens', () => {
    renderScreen(<TranscriptList items={visible([userItem, long])} subagents={subagentMap} />)

    scrollTo(420)
    press()
    scrollToOffset.mockClear()

    // Both routes the hold reaches the scroll view by: the measured content
    // change, and the scroll event behind it.
    grewTo(6000)
    scrollTo(0)

    expect(scrollToOffset).not.toHaveBeenCalled()
  })

  it('does not move it for a reader who never scrolled the chat', () => {
    // The shape that has no scroll event at all before the tap, which on the
    // native list is the report `contentNow` was added for.
    renderScreen(<TranscriptList items={visible([userItem, long])} subagents={subagentMap} />)

    press()
    grewTo(6000)

    expect(scrollToOffset).not.toHaveBeenCalled()
  })

  it('leaves the same list closing a fold alone too', () => {
    renderScreen(<TranscriptList items={visible([userItem, long])} subagents={subagentMap} />)

    scrollTo(420)
    press()
    grewTo(6000)
    press()
    grewTo(2000)

    expect(scrollToOffset).not.toHaveBeenCalled()
  })

  /**
   * The scroll handler answers a held place BEFORE it reads the offset, and
   * returns. With nothing held it has to go on doing its other job, or the jump
   * pill never appears again after a `Show more`.
   */
  it('still notices the reader scrolling away after an expansion', () => {
    const away = jest.fn()

    renderScreen(
      <TranscriptList items={visible([userItem, long])} onScrolledAwayFromBottom={away} subagents={subagentMap} />
    )

    press()
    grewTo(6000)
    away.mockClear()
    scrollTo(900)

    expect(away).toHaveBeenCalledWith(true)
  })
})

describe('the seam itself', () => {
  it('holds by hand on a native platform and not in a browser', () => {
    const native = jest.requireActual('../../src/platform/scroll-anchor') as { ANCHORS_GROWTH_ITSELF: boolean }
    const web = jest.requireActual('../../src/platform/scroll-anchor.web') as { ANCHORS_GROWTH_ITSELF: boolean }

    expect(native.ANCHORS_GROWTH_ITSELF).toBe(false)
    expect(web.ANCHORS_GROWTH_ITSELF).toBe(true)
  })
})
