import { describe, expect, it, vi } from 'vitest'

import {
  distanceFromBottom,
  holdCorrection,
  REACH_TOP_FRACTION,
  ScrollAnchor,
  STICK_THRESHOLD,
  type ScrollSurface
} from './scroll-anchor'

/**
 * A scroller modelled the way `transcript-list.css` lays one out: rows stacked
 * from the top, pushed to the bottom of the viewport while they do not fill it,
 * and an offset the "browser" clamps to the content.
 */
class ModelScroller implements ScrollSurface {
  rows: { key: string; height: number }[] = []
  top = 0

  constructor(public viewport = 600) {}

  static of(count: number, height = 100, viewport = 600): ModelScroller {
    const model = new ModelScroller(viewport)
    model.rows = Array.from({ length: count }, (_, index) => ({ key: `r${index}`, height }))
    return model
  }

  private total(): number {
    return this.rows.reduce((sum, row) => sum + row.height, 0)
  }

  /** Where a row starts in content coordinates. */
  contentTop(key: string): number | null {
    let y = Math.max(0, this.viewport - this.total())
    for (const row of this.rows) {
      if (row.key === key) {
        return y
      }
      y += row.height
    }
    return null
  }

  /** The browser's own clamp, applied whenever content changes. */
  clamp(): void {
    this.top = Math.min(Math.max(0, this.top), this.scrollHeight() - this.viewport)
  }

  scrollTop = () => this.top
  setScrollTop = (value: number) => {
    this.top = value
    this.clamp()
  }
  scrollHeight = () => Math.max(this.total(), this.viewport)
  clientHeight = () => this.viewport
  firstKey = () => this.rows[0]?.key ?? null
  rowTop = (key: string) => {
    const top = this.contentTop(key)
    return top === null ? null : top - this.top
  }
  firstVisible = () => {
    for (const row of this.rows) {
      const top = this.rowTop(row.key)!
      if (top + row.height > 0) {
        return { key: row.key, top }
      }
    }
    return null
  }

  grow(key: string, by: number): void {
    const row = this.rows.find(candidate => candidate.key === key)!
    row.height += by
    this.clamp()
  }

  prepend(count: number, height = 100): void {
    const first = this.rows.length
    this.rows.unshift(...Array.from({ length: count }, (_, index) => ({ key: `old${first + index}`, height })))
    this.clamp()
  }
}

function settledAtBottom(model: ModelScroller, callbacks = {}) {
  const anchor = new ScrollAnchor(model, callbacks)
  anchor.settle()
  return anchor
}

describe('the scroll anchor', () => {
  it('starts at the bottom and follows a growing tail there', () => {
    const model = ModelScroller.of(50)
    const anchor = settledAtBottom(model)

    expect(anchor.stuck).toBe(true)
    expect(model.top).toBe(5000 - 600)

    model.grow('r49', 37)
    anchor.settle()
    expect(model.top).toBe(5037 - 600)

    model.rows.push({ key: 'r50', height: 80 })
    anchor.settle()
    expect(distanceFromBottom({ scrollTop: model.top, scrollHeight: 5117, clientHeight: 600 })).toBe(0)
  })

  it('stops following once the reader scrolls away, and says so once', () => {
    const model = ModelScroller.of(50)
    const onStickChange = vi.fn()
    const anchor = settledAtBottom(model, { onStickChange })

    model.setScrollTop(2000)
    anchor.readerScrolled()
    anchor.readerScrolled()

    expect(anchor.stuck).toBe(false)
    expect(onStickChange.mock.calls).toEqual([[false]])
  })

  it('leaves a reader in the middle exactly where they are while the tail grows below them', () => {
    const model = ModelScroller.of(50)
    const anchor = settledAtBottom(model)
    model.setScrollTop(2050)
    anchor.readerScrolled()
    const before = model.rowTop('r20')

    for (let delta = 0; delta < 30; delta += 1) {
      model.grow('r49', 23)
      anchor.settle()
    }
    model.rows.push({ key: 'r50', height: 400 })
    anchor.settle()

    expect(model.top).toBe(2050)
    expect(model.rowTop('r20')).toBe(before)
  })

  it('keeps the row in view still when older rows are prepended', () => {
    const model = ModelScroller.of(50)
    const anchor = settledAtBottom(model)
    model.setScrollTop(130)
    anchor.readerScrolled()
    const before = model.rowTop('r1')

    model.prepend(200, 77)
    anchor.settle()

    expect(model.rowTop('r1')).toBe(before)
    expect(model.top).toBe(130 + 200 * 77)
  })

  it('keeps the row in view still when a row above it changes height', () => {
    const model = ModelScroller.of(50)
    const anchor = settledAtBottom(model)
    model.setScrollTop(2050)
    anchor.readerScrolled()
    const before = model.rowTop('r20')

    model.grow('r3', 140)
    anchor.settle()
    model.grow('r4', -60)
    anchor.settle()

    expect(model.rowTop('r20')).toBe(before)
  })

  it('undoes a shift a scroll event laid out before the resize was reported', () => {
    const model = ModelScroller.of(50)
    const anchor = settledAtBottom(model)
    model.setScrollTop(2050)
    anchor.readerScrolled()
    const before = model.rowTop('r20')

    // The event for the list's own offset arrives after a row above changed
    // height, before the resize watch said so.
    model.grow('r5', 808)
    anchor.readerScrolled()

    expect(model.rowTop('r20')).toBe(before)
    expect(anchor.stuck).toBe(false)
  })

  it('stays at the bottom when its own scroll event finds the tail grown', () => {
    const model = ModelScroller.of(50)
    const onStickChange = vi.fn()
    const anchor = settledAtBottom(model, { onStickChange })

    model.grow('r49', 300)
    anchor.readerScrolled()

    expect(anchor.stuck).toBe(true)
    expect(model.top).toBe(5300 - 600)
    expect(onStickChange).not.toHaveBeenCalled()
  })

  it('ignores sub-pixel movement', () => {
    expect(holdCorrection({ contentTop: 100 }, { top: 100.4, scrollTop: 0 })).toBeUndefined()
    expect(holdCorrection({ contentTop: 100 }, { top: 60, scrollTop: 50 })).toBe(60)
  })

  it('honours a scroll whose event has not arrived yet instead of yanking the reader back down', () => {
    const model = ModelScroller.of(50)
    const onStickChange = vi.fn()
    const anchor = settledAtBottom(model, { onStickChange })

    // The wheel moved the offset; the scroll event comes with the next frame.
    model.setScrollTop(model.top - 300)
    model.grow('r49', 50)
    anchor.settle()

    expect(anchor.stuck).toBe(false)
    expect(model.top).toBe(5000 - 600 - 300)
    expect(onStickChange.mock.calls).toEqual([[false]])
  })

  it('treats a nudge within the threshold as still at the bottom', () => {
    const model = ModelScroller.of(50)
    const anchor = settledAtBottom(model)

    model.setScrollTop(model.top - (STICK_THRESHOLD - 2))
    anchor.readerScrolled()
    expect(anchor.stuck).toBe(true)
    model.grow('r49', 40)
    anchor.settle()
    expect(model.top).toBe(5040 - 600)
  })

  it('stays at the bottom when the content shrinks and the browser clamps the offset', () => {
    const model = ModelScroller.of(50)
    const anchor = settledAtBottom(model)

    model.grow('r49', -90)
    anchor.settle()

    expect(anchor.stuck).toBe(true)
    expect(model.top).toBe(4910 - 600)
  })

  it('sits at the bottom of a chat shorter than the viewport and asks for older rows once', () => {
    const model = ModelScroller.of(3)
    const onReachTop = vi.fn()
    const anchor = settledAtBottom(model, { onReachTop })

    anchor.settle()
    anchor.readerScrolled()
    expect(model.top).toBe(0)
    expect(model.rowTop('r2')).toBe(500)
    expect(onReachTop).toHaveBeenCalledTimes(1)

    // A page of older rows arrived: a new first row, so it may ask again.
    model.prepend(2)
    anchor.settle()
    expect(onReachTop).toHaveBeenCalledTimes(2)
  })

  it('asks for older rows near the top, once until the reader leaves and comes back', () => {
    const model = ModelScroller.of(50)
    const onReachTop = vi.fn()
    const anchor = settledAtBottom(model, { onReachTop })
    expect(onReachTop).not.toHaveBeenCalled()

    model.setScrollTop(600 * REACH_TOP_FRACTION + 1)
    anchor.readerScrolled()
    expect(onReachTop).not.toHaveBeenCalled()

    model.setScrollTop(100)
    anchor.readerScrolled()
    model.setScrollTop(50)
    anchor.readerScrolled()
    expect(onReachTop).toHaveBeenCalledTimes(1)

    model.setScrollTop(1000)
    anchor.readerScrolled()
    model.setScrollTop(0)
    anchor.readerScrolled()
    expect(onReachTop).toHaveBeenCalledTimes(2)
  })

  it('goes back to the bottom on request and follows from there', () => {
    const model = ModelScroller.of(50)
    const onStickChange = vi.fn()
    const anchor = settledAtBottom(model, { onStickChange })
    model.setScrollTop(100)
    anchor.readerScrolled()

    anchor.stickToBottom()
    model.grow('r49', 10)
    anchor.settle()

    expect(anchor.stuck).toBe(true)
    expect(model.top).toBe(5010 - 600)
    expect(onStickChange.mock.calls).toEqual([[false], [true]])
  })

  it('does nothing it cannot do when the anchored row is gone', () => {
    const model = ModelScroller.of(50)
    const anchor = settledAtBottom(model)
    model.setScrollTop(2050)
    anchor.readerScrolled()

    model.rows.splice(20, 1)
    anchor.settle()
    expect(model.top).toBe(2050)
  })
})
