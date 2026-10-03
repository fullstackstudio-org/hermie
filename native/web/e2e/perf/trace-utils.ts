/**
 * Chromium-side measurement for the transcript performance spec: CPU
 * throttling and a main-thread trace, read for long tasks.
 *
 * The page measures frames, drift and the pin itself (`src/dev/probes.ts`);
 * what a page cannot see reliably is every task on its own main thread, layout
 * and garbage collection included. The trace can: with the `toplevel` category
 * Chromium records one event per task the renderer's main thread runs.
 */
import type { Browser, Page } from '@playwright/test'

/** Slows the page's CPU by `rate` (Chromium only), as DevTools' "4x slowdown" does. */
export async function throttleCpu(page: Page, rate: number): Promise<() => Promise<void>> {
  const session = await page.context().newCDPSession(page)
  await session.send('Emulation.setCPUThrottlingRate', { rate })
  return async () => {
    await session.send('Emulation.setCPUThrottlingRate', { rate: 1 })
    await session.detach()
  }
}

/** The categories the trace needs: one event per task, plus thread names. */
const CATEGORIES = ['toplevel', '__metadata']

export async function startMainThreadTrace(browser: Browser, page: Page): Promise<void> {
  await browser.startTracing(page, { categories: CATEGORIES, screenshots: false })
}

interface TraceEvent {
  name: string
  ph: string
  pid: number
  tid: number
  ts: number
  dur?: number
  args?: { name?: string }
}

/** The names Chromium has given its per-task event over the versions. */
const TASK_EVENTS = new Set(['ThreadControllerImpl::RunTask', 'RunTask'])

export interface MainThreadTasks {
  /** Tasks on the page's main thread. */
  tasks: number
  /** Durations of the tasks over `thresholdMs`, in milliseconds, longest first. */
  long: number[]
  longestMs: number
  /** Milliseconds the main thread was busy, and the traced span in seconds. */
  busyMs: number
  seconds: number
}

/**
 * Reads a trace for the renderer main thread's tasks. A page has one renderer
 * main thread (`CrRendererMain`); when a trace holds more than one (another
 * renderer was alive), the busiest is the page's.
 */
export function mainThreadTasks(buffer: Buffer, thresholdMs = 50): MainThreadTasks {
  const parsed = JSON.parse(buffer.toString('utf8')) as { traceEvents?: TraceEvent[] } | TraceEvent[]
  const events = Array.isArray(parsed) ? parsed : (parsed.traceEvents ?? [])

  const mainThreads = new Set(
    events
      .filter(event => event.ph === 'M' && event.name === 'thread_name' && event.args?.name === 'CrRendererMain')
      .map(event => `${event.pid}:${event.tid}`)
  )

  const byThread = new Map<string, TraceEvent[]>()
  for (const event of events) {
    const thread = `${event.pid}:${event.tid}`
    if (event.ph === 'X' && TASK_EVENTS.has(event.name) && mainThreads.has(thread)) {
      const list = byThread.get(thread) ?? []
      list.push(event)
      byThread.set(thread, list)
    }
  }

  const busy = (tasks: TraceEvent[]) => tasks.reduce((sum, task) => sum + (task.dur ?? 0), 0)
  const tasks = [...byThread.values()].sort((a, b) => busy(b) - busy(a))[0] ?? []
  const durations = tasks.map(task => (task.dur ?? 0) / 1000)
  const first = tasks.reduce((min, task) => Math.min(min, task.ts), Infinity)
  const last = tasks.reduce((max, task) => Math.max(max, task.ts + (task.dur ?? 0)), -Infinity)

  return {
    tasks: tasks.length,
    long: durations.filter(ms => ms > thresholdMs).sort((a, b) => b - a),
    longestMs: durations.reduce((max, ms) => Math.max(max, ms), 0),
    busyMs: busy(tasks) / 1000,
    seconds: tasks.length ? (last - first) / 1e6 : 0
  }
}

/** One line per measure, for the test's output and the plan's spike note. */
export function formatReport(title: string, values: Record<string, unknown>): string {
  const lines = Object.entries(values).map(([key, value]) => {
    const shown = typeof value === 'number' ? Number(value.toFixed(2)) : JSON.stringify(value)
    return `  ${key}: ${shown}`
  })
  return [title, ...lines].join('\n')
}
