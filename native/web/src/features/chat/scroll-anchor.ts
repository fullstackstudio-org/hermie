/**
 * Where the reader is in the transcript, and keeping them there.
 *
 * React-free and DOM-free: it reads and moves a `ScrollSurface`, which
 * `TranscriptList.tsx` builds over the real scroller and the tests build over a
 * model of one. Ported from the Expo app's transcript, which had to do the same
 * on an inverted `FlatList`:
 *
 *  - **Stick to the bottom** while the reader is within `STICK_THRESHOLD` of it
 *    (`AWAY_THRESHOLD` in `expo/hermie/src/chat-ui/TranscriptList.tsx`). A
 *    growing reply, a new row or a smaller viewport keeps the newest line in
 *    view.
 *  - **Otherwise hold the row the reader is looking at.** Anything that changes
 *    size above it (older history prepended, a row above rendered at its real
 *    height for the first time) moves the scroll offset by exactly the same
 *    amount, so the row stays where it is on screen. Growth below it moves
 *    nothing at all, because the scroller's offset is measured from the top.
 *    This is the Expo app's `holdTarget` (`offset + (content - content at the
 *    tap)`), applied to one row's position instead of the whole content height,
 *    which is what lets a growing tail BELOW the reader leave them alone, and
 *    `holdCorrection`'s half-point slop.
 *  - **Ask for older history** when the reader is within 0.4 of a viewport of
 *    the top (`onEndReachedThreshold={0.4}` there), once per first row.
 *
 * Why by hand, when browsers anchor scrolling themselves: Chromium and Firefox
 * do (`overflow-anchor`), WebKit's behaviour differs by version, and none of
 * them sticks to the bottom. The list turns the browser's own anchoring off
 * (`transcript-list.css`) so all three engines run this one rule, and the
 * Expo app's web build is the record of what happens otherwise
 * (`expo/hermie/src/platform/scroll-anchor.web.ts`: a browser that preserves
 * `scrollTop` across growth moves the reader by exactly the growth).
 *
 * Timing is the whole trick. `settle` runs after layout and before paint (from
 * a layout effect after a commit, and from a `ResizeObserver` callback after a
 * row changed size), so the reader never sees the frame in between. A scroll
 * the reader made since the last record is still honoured, because the hold is
 * computed on content positions (row top plus scroll offset), not on screen
 * positions: the reader's own movement is not "drift" to undo.
 */

/** How close to the bottom still counts as "at the bottom", in CSS pixels. */
export const STICK_THRESHOLD = 32

/** Sub-pixel movement is rounding, not a jump (the Expo app's `HOLD_SLOP`). */
export const HOLD_SLOP = 0.5

/** Older history is asked for this many viewport heights from the top. */
export const REACH_TOP_FRACTION = 0.4

/** One row's position, relative to the top edge of the scroller's viewport. */
export interface RowPosition {
  key: string
  top: number
}

/** What the anchor reads and moves. Positions are CSS pixels. */
export interface ScrollSurface {
  scrollTop(): number
  setScrollTop(value: number): void
  scrollHeight(): number
  clientHeight(): number
  /** The first row whose bottom edge is below the viewport's top edge. */
  firstVisible(): RowPosition | null
  /** The top of the row with this key, relative to the viewport's top edge; null when it is gone. */
  rowTop(key: string): number | null
  /** The key of the first (oldest) row, or null when there are none. */
  firstKey(): string | null
}

export interface ScrollAnchorCallbacks {
  onStickChange?: (stuck: boolean) => void
  onReachTop?: () => void
}

interface Record {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  /** The anchor row and its position in content coordinates (row top + scroll offset). */
  anchor: { key: string; contentTop: number } | null
}

/**
 * Where the scroll offset has to go to keep a row still: the offset now, plus
 * how far the row moved in the content since it was recorded. Undefined when
 * it did not move (beyond rounding).
 */
export function holdCorrection(
  recorded: { contentTop: number },
  now: { top: number; scrollTop: number }
): number | undefined {
  const shift = now.top + now.scrollTop - recorded.contentTop
  return Math.abs(shift) <= HOLD_SLOP ? undefined : now.scrollTop + shift
}

/** The distance between the bottom of the viewport and the bottom of the content. */
export function distanceFromBottom(metrics: { scrollTop: number; scrollHeight: number; clientHeight: number }): number {
  return Math.max(0, metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop)
}

export class ScrollAnchor {
  private stuckNow = true
  private last: Record | null = null
  /** The first row's key when older history was last asked for; null when re-armed. */
  private askedAt: string | null = null

  constructor(
    private readonly surface: ScrollSurface,
    private callbacks: ScrollAnchorCallbacks = {}
  ) {}

  /** Whether the list is following the bottom. A new list starts there. */
  get stuck(): boolean {
    return this.stuckNow
  }

  setCallbacks(callbacks: ScrollAnchorCallbacks): void {
    this.callbacks = callbacks
  }

  /**
   * The reader scrolled (a scroll event, which a browser delivers at most once
   * per frame). Decides from where they are now whether they are at the bottom,
   * and records the row they are looking at.
   */
  readerScrolled(): void {
    const metrics = this.metrics()

    // The event for an offset the list set itself, or a scroll that went
    // nowhere: nothing the reader did. Reading the geometry for it may have
    // laid out a change the resize watch has not reported yet (WebKit lays out
    // a chunk entering the viewport here); taking that as the reader's new
    // place would keep the shift instead of undoing it.
    if (this.last && Math.abs(metrics.scrollTop - this.last.scrollTop) <= HOLD_SLOP) {
      this.settle()
      return
    }

    this.setStuck(distanceFromBottom(metrics) <= STICK_THRESHOLD)
    this.record(metrics)
    this.maybeReachTop(metrics)
  }

  /**
   * Content or viewport may have changed size. Puts the reader back where they
   * were: at the bottom when stuck, otherwise with the recorded row where it was
   * on screen. Call after layout and before paint.
   */
  settle(): void {
    const surface = this.surface
    let metrics = this.metrics()
    const last = this.last

    if (this.stuckNow && last) {
      // A scroll the reader made after the last record whose event has not been
      // delivered yet. It is measured against the content as it WAS, because the
      // growth since then is what this call is about to follow. An offset the
      // browser clamped because the content got shorter is not the reader.
      const atBottomNow = distanceFromBottom(metrics) <= HOLD_SLOP
      const moved = Math.abs(metrics.scrollTop - last.scrollTop) > HOLD_SLOP && !atBottomNow
      if (moved && distanceFromBottom({ ...last, scrollTop: metrics.scrollTop }) > STICK_THRESHOLD) {
        this.setStuck(false)
      }
    }

    if (this.stuckNow) {
      const bottom = Math.max(0, metrics.scrollHeight - metrics.clientHeight)
      if (Math.abs(metrics.scrollTop - bottom) > HOLD_SLOP) {
        surface.setScrollTop(bottom)
        metrics = this.metrics()
      }
    } else if (last?.anchor) {
      const top = surface.rowTop(last.anchor.key)
      const target = top === null ? undefined : holdCorrection(last.anchor, { top, scrollTop: metrics.scrollTop })
      if (target !== undefined) {
        surface.setScrollTop(target)
        metrics = this.metrics()
      }
    }

    this.record(metrics)
    this.maybeReachTop(metrics)
  }

  /** Go to the newest row and follow it from now on. */
  stickToBottom(): void {
    this.setStuck(true)
    const metrics = this.metrics()
    this.surface.setScrollTop(Math.max(0, metrics.scrollHeight - metrics.clientHeight))
    const after = this.metrics()
    this.record(after)
  }

  private metrics() {
    return {
      scrollTop: this.surface.scrollTop(),
      scrollHeight: this.surface.scrollHeight(),
      clientHeight: this.surface.clientHeight()
    }
  }

  private record(metrics: { scrollTop: number; scrollHeight: number; clientHeight: number }): void {
    const visible = this.surface.firstVisible()
    this.last = {
      ...metrics,
      anchor: visible ? { key: visible.key, contentTop: visible.top + metrics.scrollTop } : null
    }
  }

  private setStuck(stuck: boolean): void {
    if (stuck !== this.stuckNow) {
      this.stuckNow = stuck
      this.callbacks.onStickChange?.(stuck)
    }
  }

  private maybeReachTop(metrics: { scrollTop: number; clientHeight: number }): void {
    if (metrics.scrollTop > metrics.clientHeight * REACH_TOP_FRACTION) {
      this.askedAt = null
      return
    }

    const first = this.surface.firstKey()
    if (first !== null && first !== this.askedAt) {
      this.askedAt = first
      this.callbacks.onReachTop?.()
    }
  }
}
