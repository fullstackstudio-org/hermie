/**
 * Frames and resizes: the two browser clocks a scrolling list runs on.
 *
 * `features/chat/TranscriptList.tsx` holds the reader's place by correcting the
 * scroll offset in the same frame a row changed size, before that frame is
 * painted. That needs `ResizeObserver` (its callbacks run after layout and
 * before paint) and `requestAnimationFrame` (to batch scroll events into one
 * read per frame). Both are injected here, so the list's tests can drive them
 * by hand, and a page without them (jsdom, an old engine) gets a list that
 * still renders and simply does not correct.
 *
 * Scroll metrics themselves (`scrollTop`, `getBoundingClientRect`) are element
 * properties, not globals, and are read where the element is.
 */

/** Cancels what it was returned for. Calling it twice is harmless. */
export type Cancel = () => void

export interface LayoutClock {
  /** Runs `callback` before the next paint. */
  nextFrame(callback: () => void): Cancel
  /**
   * Calls `onResize` whenever one of the watched elements changes size, after
   * layout and before paint. Nothing is watched until `watch` is called.
   */
  observeResize(onResize: () => void): ResizeWatch
}

export interface ResizeWatch {
  /** False where there is no `ResizeObserver`: nothing will ever be reported. */
  readonly observing: boolean
  watch(element: Element): void
  unwatch(element: Element): void
  disconnect(): void
}

/** What the clock reads, so a test can hand in its own. */
export interface LayoutEnvironment {
  requestAnimationFrame?: (callback: FrameRequestCallback) => number
  cancelAnimationFrame?: (handle: number) => void
  ResizeObserver?: new (
    callback: ResizeObserverCallback
  ) => Pick<ResizeObserver, 'observe' | 'unobserve' | 'disconnect'>
  setTimeout: (callback: () => void, ms: number) => unknown
  clearTimeout: (handle: never) => void
}

/** Roughly one frame at 60 Hz: the fallback when there is no frame callback at all. */
const FALLBACK_FRAME_MS = 16

const NO_WATCH: ResizeWatch = { observing: false, watch() {}, unwatch() {}, disconnect() {} }

const pageEnvironment = (): LayoutEnvironment | null =>
  typeof window === 'undefined'
    ? null
    : {
        requestAnimationFrame: window.requestAnimationFrame?.bind(window),
        cancelAnimationFrame: window.cancelAnimationFrame?.bind(window),
        ResizeObserver: window.ResizeObserver,
        setTimeout: window.setTimeout.bind(window),
        clearTimeout: window.clearTimeout.bind(window) as (handle: never) => void
      }

export function createLayoutClock(environment: LayoutEnvironment | null = pageEnvironment()): LayoutClock {
  return {
    nextFrame(callback) {
      let done = false
      const run = () => {
        if (!done) {
          done = true
          callback()
        }
      }

      if (environment?.requestAnimationFrame) {
        const handle = environment.requestAnimationFrame(run)
        return () => {
          done = true
          environment.cancelAnimationFrame?.(handle)
        }
      }

      if (environment) {
        const handle = environment.setTimeout(run, FALLBACK_FRAME_MS)
        return () => {
          done = true
          environment.clearTimeout(handle as never)
        }
      }

      return () => {
        done = true
      }
    },

    observeResize(onResize) {
      const Observer = environment?.ResizeObserver
      if (!Observer) {
        return NO_WATCH
      }

      const observer = new Observer(() => onResize())
      return {
        observing: true,
        watch: element => observer.observe(element),
        unwatch: element => observer.unobserve(element),
        disconnect: () => observer.disconnect()
      }
    }
  }
}

/** The page's own clock. */
export const layoutClock: LayoutClock = createLayoutClock()
