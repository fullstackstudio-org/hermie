/**
 * In-page measurements for the transcript harness. Development only.
 *
 * The geometry probes sample what the next painted frame will show: right after
 * the list has handled a change, in the same places the list handles it. A probe
 * makes its own `ResizeObserver` and adds its own scroll listener after the list
 * made its own, and a browser delivers both in the order they were made, so the
 * probe always runs after the list's correction and before the paint.
 *
 * Sampling anywhere else reads a page nobody sees. In a frame callback it reads
 * the page between a commit and the list's correction. After the paint it reads
 * whatever a forced layout produces, and WebKit lays out a chunk that just came
 * into view there, one frame before it reports the resize that the list then
 * corrects before painting (the W-8 spike measured a phantom 808 px that way).
 * A frame in which nothing changed size and nothing scrolled moves nothing.
 */

export interface FrameReport {
  /** Frames delivered. */
  frames: number
  /** Frames the page should have had at the measured refresh interval but did not get. */
  dropped: number
  droppedPercent: number
  /** The refresh interval the frames ran at (median), in milliseconds. */
  interval: number
  longestFrame: number
  /** Milliseconds per second spent late (Apple's hitch time ratio), comparable with the native lab. */
  hitchMsPerSecond: number
  seconds: number
}

/** Counts frames and the gaps between them until `stop`. */
export function startFrameMeter(clock = globalThis): { stop(): FrameReport } {
  const stamps: number[] = []
  let handle = 0
  const tick = (time: number) => {
    stamps.push(time)
    handle = clock.requestAnimationFrame(tick)
  }
  handle = clock.requestAnimationFrame(tick)

  return {
    stop() {
      clock.cancelAnimationFrame(handle)
      const gaps = stamps.slice(1).map((time, index) => time - (stamps[index] as number))
      const sorted = [...gaps].sort((a, b) => a - b)
      const interval = sorted.length ? (sorted[Math.floor(sorted.length / 2)] as number) : 1000 / 60
      let dropped = 0
      let late = 0
      for (const gap of gaps) {
        // Half an interval of slack: a frame callback's timestamp jitters.
        dropped += Math.max(0, Math.round(gap / interval) - 1)
        if (gap > interval * 1.5) {
          late += gap - interval
        }
      }
      const seconds = stamps.length > 1 ? ((stamps.at(-1) as number) - (stamps[0] as number)) / 1000 : 0
      return {
        frames: stamps.length,
        dropped,
        droppedPercent: stamps.length ? (100 * dropped) / (dropped + stamps.length) : 0,
        interval,
        longestFrame: sorted.at(-1) ?? 0,
        hitchMsPerSecond: seconds ? late / seconds : 0,
        seconds
      }
    }
  }
}

export interface DriftReport {
  key: string
  samples: number
  /** The largest distance the row moved on screen from where it was at the start, in CSS pixels. */
  maxDrift: number
}

/**
 * Calls `sample` after the list has handled each change of the transcript's
 * size and each scroll, until the returned function is called.
 */
function afterEveryChange(scroller: HTMLElement, sample: () => void): () => void {
  const rows = scroller.querySelector('.transcript-list__rows')
  const observer = new ResizeObserver(() => sample())
  observer.observe(scroller)
  if (rows) {
    observer.observe(rows)
  }
  scroller.addEventListener('scroll', sample, { passive: true })

  return () => {
    observer.disconnect()
    scroller.removeEventListener('scroll', sample)
  }
}

/** Watches one row's position on screen until `stop`. */
export function startDriftProbe(scroller: HTMLElement, key: string): { stop(): DriftReport } {
  const row = scroller.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(key)}"]`)
  if (!row) {
    throw new Error(`no row ${key}`)
  }
  const position = () => row.getBoundingClientRect().top - scroller.getBoundingClientRect().top
  const start = position()
  let samples = 0
  let maxDrift = 0
  const sample = () => {
    samples += 1
    maxDrift = Math.max(maxDrift, Math.abs(position() - start))
  }
  const cancel = afterEveryChange(scroller, sample)

  return {
    stop() {
      cancel()
      sample()
      return { key, samples, maxDrift }
    }
  }
}

export interface PinReport {
  samples: number
  /** The largest gap seen between the newest row's bottom and the viewport's bottom, in CSS pixels. */
  maxGap: number
}

/** Watches the distance from the bottom until `stop`. */
export function startPinProbe(scroller: HTMLElement): { stop(): PinReport } {
  let samples = 0
  let maxGap = 0
  const sample = () => {
    samples += 1
    maxGap = Math.max(maxGap, scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop)
  }
  const cancel = afterEveryChange(scroller, sample)

  return {
    stop() {
      cancel()
      sample()
      return { samples, maxGap }
    }
  }
}

/** Long tasks as the page itself reports them, where the engine can (Chromium). */
export function startLongTaskObserver(): { supported: boolean; stop(): number[] } {
  const supported = PerformanceObserver.supportedEntryTypes?.includes('longtask') ?? false
  const durations: number[] = []
  if (!supported) {
    return { supported, stop: () => durations }
  }
  const observer = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) {
      durations.push(entry.duration)
    }
  })
  observer.observe({ type: 'longtask' })
  return {
    supported,
    stop() {
      for (const entry of observer.takeRecords()) {
        durations.push(entry.duration)
      }
      observer.disconnect()
      return durations
    }
  }
}

/** Resolves after the next frame has been painted (as close as a page can tell). */
export function afterNextPaint(clock = globalThis): Promise<number> {
  return new Promise(resolve => {
    clock.requestAnimationFrame(() => {
      const channel = new MessageChannel()
      channel.port1.onmessage = () => resolve(clock.performance.now())
      channel.port2.postMessage(undefined)
    })
  })
}
