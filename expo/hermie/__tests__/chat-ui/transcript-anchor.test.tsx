/**
 * The one invariant behind "the chat jumps up and scrolls back".
 *
 * **While the reader is at the bottom, a streaming turn must never change the
 * visible offset except by growing the content.**
 *
 * That is not a thing a test renderer can watch, because the correction happens in
 * `RCTScrollViewComponentView`, in two steps around a mounting transaction:
 *
 * ```objc
 * // _prepareForMaintainVisibleScrollPosition, BEFORE the update
 * hasNewView = subview.frame.origin.y + subview.frame.size.height > contentOffset.y
 * // _adjustForMaintainVisibleContentPosition, AFTER it
 * deltaY = _firstVisibleView.frame.origin.y - _prevFirstVisibleFrame.origin.y
 * if (ABS(deltaY) > 0.5) { contentOffset.y += deltaY; if (y <= threshold) scrollToOffset(0, animated) }
 * ```
 *
 * The anchor is a VIEW, and at the bottom of an inverted list every new row is
 * inserted before it, so `deltaY` is the new row's own height. A previous round
 * tried to give that loop a constant view to hold — a one-point
 * `ListHeaderComponent` — and it cannot work: `VirtualizedList` adds one to
 * `minIndexForVisible` whenever a header exists, so the loop starts at the first
 * CELL and the header is unreachable at any value of the prop. Measured on an
 * iPhone 17 Pro with `--hermieTraceScroll`: a 70pt outgoing bubble moved the
 * offset from 0 to 94 and it took ~290ms to animate back.
 *
 * So the invariant is expressed here as the two structural facts it reduces to,
 * both of which ARE observable from JavaScript:
 *
 *  1. the scroll view holds NO `maintainVisibleContentPosition` while the reader
 *     is at the bottom, so there is nothing to correct and nothing to animate —
 *     and it does hold one once they scroll away, where the correction is the
 *     behaviour a reader wants;
 *  2. the list never scrolls ITSELF when a row comes or goes, at either end of
 *     that switch.
 *
 * The typing bubble used to be pinned outside the scroll view and is a CELL now,
 * at index 0, which on an inverted list is the bottom of the conversation. That
 * is only safe because of (1): its height arriving is an insertion like any
 * other, corrected where the reader is up in the history and free where they are
 * at the bottom. So the dots come with their own pair of cases below — inserted
 * and removed, away and at the bottom — and they are the same cases a message
 * row gets.
 */
import { act, fireEvent, screen } from '@testing-library/react-native'
import { FlatList } from 'react-native'

import { TranscriptList } from '../../src/chat-ui'
import { assistantItem, subagentMap, userItem } from '../../src/chat-ui/fixtures'
import { anchorFor, holdCorrection, holdTarget } from '../../src/chat-ui/TranscriptList'
import type { AssistantItem, VisibleItem } from '../../src/chat-ui/types'
import { markdownLeading } from '../../src/markdown'
import { FOLD_LINES, type as typeScale } from '../../src/ui/tokens'
import { renderScreen, withProviders } from '../support/render'

const visible = (items: { id: string }[]): VisibleItem[] =>
  items.map(item => ({ item, presentation: 'collapsed' }) as VisibleItem)

/** The turn as it really arrives: reasoning first, then the first token, then more. */
const thinking: AssistantItem = { ...assistantItem, id: 'a-live', streaming: true, text: '', reasoning: 'Checking…' }
const firstToken: AssistantItem = { ...thinking, text: 'L', version: (thinking.version ?? 0) + 1 }
const moreText: AssistantItem = { ...thinking, text: 'Looking that up', version: (thinking.version ?? 0) + 2 }

/** What the list is holding the scroll view to right now, if anything. */
function anchorProp(): unknown {
  return screen.getByTestId('transcript-list-scroll').props.maintainVisibleContentPosition
}

/** Put the reader `y` points from the bottom of the inverted list. */
function scrollTo(y: number): void {
  fireEvent.scroll(screen.getByTestId('transcript-list-scroll'), {
    nativeEvent: {
      contentOffset: { x: 0, y },
      contentSize: { height: 2000, width: 402 },
      layoutMeasurement: { height: 800, width: 402 }
    }
  })
}

describe('the list’s anchor', () => {
  it('is held by nothing at the bottom, through a whole streaming turn', () => {
    // Every frame of a turn inserts or grows a row at index 0. With an anchor
    // held, each of those is a correction of exactly that row's height followed
    // by an animated scroll back to zero.
    const view = renderScreen(<TranscriptList items={visible([userItem])} subagents={subagentMap} />)

    expect(anchorProp()).toBeUndefined()

    for (const item of [thinking, firstToken, moreText]) {
      view.rerender(
        withProviders(
          <TranscriptList
            items={[...visible([userItem]), { item, presentation: 'full' }]}
            subagents={subagentMap}
            typing
          />
        )
      )

      expect(anchorProp()).toBeUndefined()
    }

    // And when the turn ends and the typing flag drops with it.
    view.rerender(
      withProviders(
        <TranscriptList
          items={[...visible([userItem]), { item: { ...moreText, streaming: false }, presentation: 'full' }]}
          subagents={subagentMap}
        />
      )
    )

    expect(anchorProp()).toBeUndefined()
  })

  it('is held once the reader scrolls away, and let go again at the bottom', () => {
    // The case the prop exists for: a message arriving under a reader who is up
    // in the history must not shove the paragraph they are reading up the screen.
    renderScreen(<TranscriptList items={visible([userItem, assistantItem])} subagents={subagentMap} />)

    scrollTo(400)
    expect(anchorProp()).toEqual({ minIndexForVisible: 0 })

    scrollTo(0)
    expect(anchorProp()).toBeUndefined()
  })

  /**
   * The report this pair exists for: an expanded reply, no fold left to open,
   * and the paragraph the reader is on walking down the screen token by token.
   *
   * On an inverted list cell 0 is the newest row AND it is laid out at content
   * y = 0, so its origin is the one origin a growing cell 0 does not move.
   * Anchored there, the native loop measures no delta, corrects nothing, and
   * every later row — the history, which is what is on screen above — slides by
   * the growth. The anchor has to name a row that is standing still.
   */
  it('anchors past the streaming row, which is the one that is growing', () => {
    const view = renderScreen(
      <TranscriptList
        items={[...visible([userItem]), { item: thinking, presentation: 'full' }]}
        subagents={subagentMap}
      />
    )

    scrollTo(400)
    expect(anchorProp()).toEqual({ minIndexForVisible: 1 })

    // The turn ends: row 0 stops growing and is a perfectly good anchor again.
    view.rerender(
      withProviders(
        <TranscriptList
          items={[...visible([userItem]), { item: { ...moreText, streaming: false }, presentation: 'full' }]}
          subagents={subagentMap}
        />
      )
    )
    scrollTo(400)
    expect(anchorProp()).toEqual({ minIndexForVisible: 0 })
  })

  it('counts the dots in front of the transcript when it names that row', () => {
    renderScreen(
      <TranscriptList
        items={[...visible([userItem]), { item: thinking, presentation: 'full' }]}
        subagents={subagentMap}
        typing
      />
    )

    // Parked messages used to be rows 0 and 1 here; they are a strip over the
    // composer now, so the only thing in front of the transcript is the dots —
    // except that a streaming reply already carries its own, which stands the
    // dots down. Nothing leads, and the row after the streaming one is 1.
    scrollTo(400)
    expect(anchorProp()).toEqual({ minIndexForVisible: 1 })
  })

  it('never carries an autoscroll threshold, which is what animated the jump back', () => {
    // `autoscrollToTopThreshold` only ever fires within its own distance of the
    // bottom — which is exactly where the anchor is now let go — so a value here
    // could only ever re-arm the scroll back down.
    renderScreen(<TranscriptList items={visible([userItem, assistantItem])} subagents={subagentMap} />)

    scrollTo(400)
    expect(anchorProp()).not.toHaveProperty('autoscrollToTopThreshold')
  })

  it('carries the typing bubble as a cell, so it scrolls with the conversation', () => {
    // The dots were a pinned sibling below the scroll view for as long as the
    // anchor was held at the bottom. They are a row now, and a row is inside.
    renderScreen(<TranscriptList items={visible([userItem])} subagents={subagentMap} typing />)

    const scroll = screen.getByTestId('transcript-list-scroll')

    expect(within(scroll, screen.getByTestId('transcript-list-typing-slot'))).toBe(true)
    expect(screen.getByTestId('typing-indicator')).toBeTruthy()
  })

  it('draws no typing row at all once the turn has a bubble of its own', () => {
    // §6.2: one bubble from start to finish. The streaming reply holds the dots,
    // so the row must not exist beside it — an empty row at index 0 is content
    // whose height comes and goes for nothing.
    renderScreen(
      <TranscriptList
        items={[...visible([userItem]), { item: thinking, presentation: 'full' }]}
        subagents={subagentMap}
        typing
      />
    )

    expect(screen.queryByTestId('transcript-list-typing-slot')).toBeNull()
  })
})

/**
 * The typing row, inserted and removed, in both anchor states.
 *
 * This is the whole of what moving it into the list had to prove: at the bottom
 * the list must not move because there is no anchor and inversion pins offset 0;
 * away from the bottom it must not move ITSELF either — the correction there is
 * the native anchor's, applied inside the scroll view, and any `scrollToOffset`
 * from JavaScript on top of it is a second, visible jump.
 */
describe('the typing row coming and going', () => {
  const body = (extra: { typing?: boolean } = {}) => (
    <TranscriptList items={visible([userItem, assistantItem])} subagents={subagentMap} {...extra} />
  )

  function watchScroll(): jest.SpyInstance {
    return jest.spyOn(FlatList.prototype, 'scrollToOffset').mockImplementation(() => {})
  }

  it('moves nothing while the reader is scrolled away, in or out', () => {
    const scrollToOffset = watchScroll()

    try {
      const view = renderScreen(body())

      scrollTo(400)
      expect(anchorProp()).toEqual({ minIndexForVisible: 0 })
      scrollToOffset.mockClear()

      // In: a row appears at index 0 under a reader who is not looking at it.
      view.rerender(withProviders(body({ typing: true })))
      scrollTo(400)
      expect(anchorProp()).toEqual({ minIndexForVisible: 0 })
      expect(scrollToOffset).not.toHaveBeenCalled()

      // Out: the reply arrives and the dots go with it.
      view.rerender(withProviders(body()))
      scrollTo(400)
      expect(scrollToOffset).not.toHaveBeenCalled()
    } finally {
      scrollToOffset.mockRestore()
    }
  })

  it('moves nothing while the reader is at the bottom, in or out', () => {
    const scrollToOffset = watchScroll()

    try {
      const view = renderScreen(body())

      scrollTo(0)
      scrollToOffset.mockClear()

      view.rerender(withProviders(body({ typing: true })))
      scrollTo(0)
      expect(anchorProp()).toBeUndefined()
      expect(scrollToOffset).not.toHaveBeenCalled()

      view.rerender(withProviders(body()))
      scrollTo(0)
      expect(anchorProp()).toBeUndefined()
      expect(scrollToOffset).not.toHaveBeenCalled()
    } finally {
      scrollToOffset.mockRestore()
    }
  })
})

/** Is `node` anywhere under `root`? The test renderer has no `contains`. */
function within(root: { findAll: (predicate: (node: unknown) => boolean) => unknown[] }, node: unknown): boolean {
  return root.findAll(candidate => candidate === node).length > 0
}

/**
 * The second half of the same invariant, for the reader rather than for a turn.
 *
 * **Opening a disclosure must not move the text the reader is looking at.** That
 * is NOT the same as leaving the offset alone, and believing it was is how the
 * owner reported `Show more` twice. An inverted list pins a growing cell's
 * BOTTOM edge, so a body that opens grows upward and carries the line under the
 * finger up with it; leaving the offset where it was keeps the END of the
 * message on screen. Keeping the message's TOP still means moving the offset by
 * exactly the growth — which is why `holdCorrection` takes a target rather than
 * a memory, and why `Fold` reports how much taller it is about to be.
 */
describe('holdTarget', () => {
  it('is the tap’s offset plus however much the content actually grew', () => {
    expect(holdTarget({ content: 2103, offset: 859 }, 3480.7)).toBeCloseTo(2236.7, 1)
  })

  it('answers the SAME place for a growth that arrives in two stages', () => {
    // The reader's line does not care how many layout passes the row took.
    const from = { content: 2103, offset: 859 }

    expect(holdTarget(from, 2103 + 1165.3)).toBeCloseTo(859 + 1165.3, 1)
    expect(holdTarget(from, 2103 + 1377.7)).toBeCloseTo(859 + 1377.7, 1)
  })

  it('never asks for a negative offset', () => {
    expect(holdTarget({ content: 4000, offset: 100 }, 1000)).toBe(0)
  })
})

describe('holdCorrection', () => {
  it('asks for nothing while no place is held', () => {
    expect(holdCorrection(undefined, 0)).toBeUndefined()
    expect(holdCorrection(undefined, 940)).toBeUndefined()
  })

  it('asks for nothing when the offset did not move — the delta a fold must have', () => {
    expect(holdCorrection(420, 420)).toBeUndefined()
  })

  it('treats sub-point drift as rounding, the way UIKit does', () => {
    expect(holdCorrection(420, 420.4)).toBeUndefined()
    expect(holdCorrection(420, 419.6)).toBeUndefined()
  })

  it('puts the list back when the expansion moved it', () => {
    // The reported shape: the growth lands the reader at the newest message.
    expect(holdCorrection(420, 0)).toBe(420)
    expect(holdCorrection(420, 628)).toBe(420)
  })
})

describe('opening a disclosure', () => {
  const HEIGHT = 4000
  const long = { ...assistantItem, id: 'a-long', streaming: false, text: 'x'.repeat(HEIGHT) }

  /** The clip the fold applies, so the growth it reports can be named exactly. */
  const limit = FOLD_LINES.regular * markdownLeading(typeScale.body.fontSize)
  const growth = HEIGHT - limit

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

  it('moves the reader by the growth, so the message opens downward', () => {
    // The owner's report, twice over: `Show more` still threw the transcript to
    // the end of the message. An inverted list pins a growing cell's BOTTOM
    // edge, so holding the offset the finger went down at keeps the END of the
    // message under the finger and sends everything the reader was reading up
    // and off the screen. The target is that offset PLUS the growth, which
    // keeps the message's top edge still.
    const scrollToOffset = jest.spyOn(FlatList.prototype, 'scrollToOffset').mockImplementation(() => {})

    try {
      renderScreen(<TranscriptList items={visible([userItem, long])} subagents={subagentMap} />)

      scrollTo(420)
      press()
      scrollToOffset.mockClear()

      // The growth lands them somewhere else; the list puts them where the top
      // of the message still is.
      scrollTo(0)
      expect(scrollToOffset).toHaveBeenCalledWith({ animated: false, offset: 420 + growth })

      // A drag is the reader deciding where to be, and outranks the hold.
      scrollToOffset.mockClear()
      fireEvent(screen.getByTestId('transcript-list-scroll'), 'scrollBeginDrag')
      scrollTo(0)
      expect(scrollToOffset).not.toHaveBeenCalled()
    } finally {
      scrollToOffset.mockRestore()
    }
  })

  it('never leaves the reader at the end of the message they just opened', () => {
    // The shape of the bug as reported: at the bottom of the conversation the
    // held offset was zero, and zero on an inverted list is the newest content —
    // the END of the reply they had just asked to read.
    const scrollToOffset = jest.spyOn(FlatList.prototype, 'scrollToOffset').mockImplementation(() => {})

    try {
      renderScreen(<TranscriptList items={visible([userItem, long])} subagents={subagentMap} />)

      scrollTo(0)
      press()
      scrollToOffset.mockClear()
      scrollTo(0)

      expect(scrollToOffset).toHaveBeenCalledWith({ animated: false, offset: growth })
      expect(scrollToOffset).not.toHaveBeenCalledWith({ animated: false, offset: 0 })
    } finally {
      scrollToOffset.mockRestore()
    }
  })

  it('holds the top for a reader who has not scrolled the chat at all', () => {
    /*
     * The fourth report of the same sentence, and the one the three cases above
     * could not catch: each of them scrolls first, and a scroll event is what
     * used to be the only thing that wrote the content height down.
     *
     * A reader who opens a chat and presses `Show more` on its last message has
     * produced no scroll event. Offset 0 was right — it is the bottom of an
     * inverted list — and the content height on record was 0, so the measured
     * growth came out as the whole transcript and the hold aimed at a place
     * nobody had ever been. What the reader saw was the fold's own behaviour,
     * uncorrected: the end of the message they had just asked to read.
     */
    const scrollToOffset = jest.spyOn(FlatList.prototype, 'scrollToOffset').mockImplementation(() => {})
    const onScrolledAwayFromBottom = jest.fn()

    try {
      renderScreen(
        <TranscriptList
          items={visible([userItem, long])}
          onScrolledAwayFromBottom={onScrolledAwayFromBottom}
          subagents={subagentMap}
        />
      )

      // The list measuring itself on mount. No scroll, no drag, no pill.
      grewTo(2000)
      expect(onScrolledAwayFromBottom).not.toHaveBeenCalledWith(true)

      press()
      scrollToOffset.mockClear()
      grewTo(2000 + growth)

      expect(scrollToOffset).toHaveBeenCalledWith({ animated: false, offset: growth })
      expect(scrollToOffset).not.toHaveBeenCalledWith({ animated: false, offset: 2000 + growth })

      // And that offset is what takes the reader off the bottom: the message
      // opens downward, they are free to read it, and the pill comes up behind
      // them. Real scroll views report the offset they were moved to.
      scrollTo(growth)
      expect(onScrolledAwayFromBottom).toHaveBeenCalledWith(true)
    } finally {
      scrollToOffset.mockRestore()
    }
  })

  it('follows a row that grows in two stages, not just the one it predicted', () => {
    // The owner's third report: `Show more` on a message containing a TABLE still
    // moved the text up by about 212pt. `Fold` measures its own unclipped body
    // and can say how much taller the TEXT is about to be — the table measures
    // its columns a pass later, and that stage is in nobody's number. Recorded
    // on an iPhone 17 Pro: predicted 1165.3, content grew 1377.7.
    const scrollToOffset = jest.spyOn(FlatList.prototype, 'scrollToOffset').mockImplementation(() => {})
    const TABLE = 212

    try {
      renderScreen(<TranscriptList items={visible([userItem, long])} subagents={subagentMap} />)

      // The offset AND the content height at the tap; the second is what the
      // measured growth is counted from.
      scrollTo(420)
      press()
      scrollToOffset.mockClear()

      // Stage one: what the fold predicted, and nothing more to answer.
      grewTo(2000 + growth)
      expect(scrollToOffset).toHaveBeenCalledWith({ animated: false, offset: 420 + growth })

      // Stage two: the table lays its columns out.
      scrollToOffset.mockClear()
      grewTo(2000 + growth + TABLE)
      expect(scrollToOffset).toHaveBeenCalledWith({ animated: false, offset: 420 + growth + TABLE })

      // A third pass that changes nothing asks for nothing.
      scrollToOffset.mockClear()
      grewTo(2000 + growth + TABLE)
      expect(scrollToOffset).not.toHaveBeenCalled()
    } finally {
      scrollToOffset.mockRestore()
    }
  })

  it('stops following once the hold has been let go', () => {
    // The window is `HOLD_SETTLE_MS`. Content that goes on growing after it — an
    // image landing, a reply streaming — is not the expansion the reader asked
    // for, and must not move them.
    jest.useFakeTimers()

    const scrollToOffset = jest.spyOn(FlatList.prototype, 'scrollToOffset').mockImplementation(() => {})

    try {
      renderScreen(<TranscriptList items={visible([userItem, long])} subagents={subagentMap} />)

      scrollTo(420)
      press()

      act(() => {
        jest.advanceTimersByTime(1000)
      })

      scrollToOffset.mockClear()
      grewTo(4000)

      expect(scrollToOffset).not.toHaveBeenCalled()
    } finally {
      scrollToOffset.mockRestore()
      jest.useRealTimers()
    }
  })

  it('lets the held place go when the typing row arrives under it', () => {
    // A hold is a promise about ONE expansion. The dots are a row now, so their
    // arrival changes the content by their own height as well — and forcing the
    // offset to a target computed before that row existed would undo the
    // correction the anchor just made and move the reader by the row's height.
    const scrollToOffset = jest.spyOn(FlatList.prototype, 'scrollToOffset').mockImplementation(() => {})

    try {
      const view = renderScreen(<TranscriptList items={visible([userItem, long])} subagents={subagentMap} />)

      scrollTo(420)
      press()
      scrollToOffset.mockClear()

      view.rerender(withProviders(<TranscriptList items={visible([userItem, long])} subagents={subagentMap} typing />))
      scrollTo(0)

      expect(scrollToOffset).not.toHaveBeenCalled()
    } finally {
      scrollToOffset.mockRestore()
    }
  })

  it('corrects nothing once the reader is already where they belong', () => {
    const scrollToOffset = jest.spyOn(FlatList.prototype, 'scrollToOffset').mockImplementation(() => {})

    try {
      renderScreen(<TranscriptList items={visible([userItem, long])} subagents={subagentMap} />)

      scrollTo(420)
      press()
      scrollToOffset.mockClear()
      scrollTo(420 + growth)

      expect(scrollToOffset).not.toHaveBeenCalled()
    } finally {
      scrollToOffset.mockRestore()
    }
  })
})

/**
 * The arithmetic on its own, because the render cases above can only show two
 * of its values and identity is not visible from them at all.
 */
describe('anchorFor', () => {
  it('holds row 0 when nothing at row 0 is growing', () => {
    expect(anchorFor(0, false)).toEqual({ minIndexForVisible: 0 })
    expect(anchorFor(3, false)).toEqual({ minIndexForVisible: 0 })
  })

  it('holds the row after the streaming one, parked rows included', () => {
    expect(anchorFor(0, true)).toEqual({ minIndexForVisible: 1 })
    expect(anchorFor(2, true)).toEqual({ minIndexForVisible: 3 })
  })

  it('answers the same object twice, so the scroll view sees no new prop', () => {
    expect(anchorFor(1, true)).toBe(anchorFor(1, true))
    expect(anchorFor(0, false)).toBe(anchorFor(9, false))
  })
})
