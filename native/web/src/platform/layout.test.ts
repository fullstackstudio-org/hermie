import { describe, expect, it, vi } from 'vitest'

import { createLayoutClock, type LayoutEnvironment } from './layout'

function timers(): Pick<LayoutEnvironment, 'setTimeout' | 'clearTimeout'> {
  return {
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: handle => clearTimeout(handle)
  }
}

describe('the layout clock', () => {
  it('runs a frame callback once, and not at all once cancelled', () => {
    const queued: FrameRequestCallback[] = []
    const cancelled: number[] = []
    const clock = createLayoutClock({
      ...timers(),
      requestAnimationFrame: callback => queued.push(callback),
      cancelAnimationFrame: handle => cancelled.push(handle)
    })

    const ran = vi.fn()
    clock.nextFrame(ran)
    const cancel = clock.nextFrame(() => ran('second'))
    cancel()
    cancel()

    queued.forEach(callback => callback(0))
    queued.forEach(callback => callback(0))

    expect(ran).toHaveBeenCalledTimes(1)
    expect(cancelled).toEqual([2, 2])
  })

  it('falls back to a timer without requestAnimationFrame, and to nothing without a page', async () => {
    vi.useFakeTimers()
    try {
      const ran = vi.fn()
      createLayoutClock(timers()).nextFrame(ran)
      createLayoutClock(null).nextFrame(ran)()
      vi.advanceTimersByTime(20)
      expect(ran).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('hands resizes of the watched elements to one callback', () => {
    let notify: ResizeObserverCallback = () => {}
    const observed = new Set<Element>()
    class FakeObserver {
      constructor(callback: ResizeObserverCallback) {
        notify = callback
      }
      observe(element: Element) {
        observed.add(element)
      }
      unobserve(element: Element) {
        observed.delete(element)
      }
      disconnect() {
        observed.clear()
      }
    }

    const onResize = vi.fn()
    const watch = createLayoutClock({ ...timers(), ResizeObserver: FakeObserver }).observeResize(onResize)
    expect(watch.observing).toBe(true)
    const a = document.createElement('div')
    const b = document.createElement('div')

    watch.watch(a)
    watch.watch(b)
    watch.unwatch(a)
    expect([...observed]).toEqual([b])

    notify([], {} as ResizeObserver)
    expect(onResize).toHaveBeenCalledTimes(1)

    watch.disconnect()
    expect(observed.size).toBe(0)
  })

  it('watches nothing, without failing, where there is no ResizeObserver', () => {
    const watch = createLayoutClock(timers()).observeResize(() => {})
    expect(watch.observing).toBe(false)
    expect(() => {
      watch.watch(document.createElement('div'))
      watch.disconnect()
    }).not.toThrow()
  })
})
