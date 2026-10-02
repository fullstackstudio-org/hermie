/**
 * A trace of what the transcript's scroll view and its rows actually did.
 *
 * **Why this is in the repository rather than in a scratch patch.** The bug it
 * exists for — the chat jumping up and scrolling itself back down — happens
 * inside `RCTScrollViewComponentView`, one mounting transaction wide, and leaves
 * no trace in any React state. Two rounds were spent reasoning about it from the
 * React Native source with no recording to check the reasoning against, and both
 * rounds fixed something real and missed the remaining case. What closed it was
 * three numbers per frame: the offset before the correction, the offset after it,
 * and which row changed height in between. Those three numbers are cheap enough
 * to keep and expensive enough to re-derive that deleting them again would be a
 * decision to spend a third round the same way.
 *
 * **What it costs when it is off**, which is every build that is not a developer
 * running one flag: nothing reachable. `TRACING` folds to `false` in a production
 * bundle through the same `__DEV__` gate `DEV_LAUNCH_INTENT` is measured to fold
 * through (see `launch-intent.ts`), so the calls compile to `if (false)`. With
 * `__DEV__` true but the flag absent, each call is one boolean test.
 *
 * Turn it on with `--hermieTraceScroll`:
 *
 * ```sh
 * xcrun simctl launch <udid> dev.hermie.app \
 *   --hermieGateway http://localhost:9119 --hermieToken demo \
 *   --hermieOpen chat:researcher --hermieTraceScroll
 * ```
 *
 * Every line is one `console.log` — Metro's terminal, `npx react-native log-ios`
 * and the simulator's own log all carry it — prefixed so a whole session can be
 * pulled out of a noisy log with one `grep`:
 *
 * ```
 * [scroll] +1284 offset=19.7 content=2043.0 view=604.0
 * [row] +1290 assistant-a-7 h=214.3 (+13.0)
 * [scroll] +1291 offset=232.7 content=2256.0 view=604.0   ← the correction
 * [scroll] +1308 offset=180.2 content=2256.0 view=604.0   ← the animated scroll back
 * ```
 *
 * The timestamps are milliseconds since the first traced event, because what
 * matters is the distance between two lines and never the wall clock.
 */
import { DEV_LAUNCH_INTENT } from './launch-intent'

/**
 * Is the trace on?
 *
 * A module constant rather than a function call, so the bundler can see the
 * `__DEV__` half of it and drop everything guarded by it.
 */
export const TRACING: boolean = __DEV__ && DEV_LAUNCH_INTENT?.traceScroll === true

let origin = 0

/** Milliseconds since the first traced line, to one decimal. */
function stamp(): string {
  const now = Date.now()

  if (!origin) {
    origin = now
  }

  return `+${now - origin}`
}

const round = (value: number): string => value.toFixed(1)

/**
 * One scroll event.
 *
 * The three numbers together are what distinguishes the two things that look
 * identical on screen: content GROWING under a list that is already at the bottom
 * (`content` rises, `offset` stays) from the list being MOVED (`offset` changes on
 * its own, with or without `content` changing).
 */
export function traceScroll(offset: number, contentHeight: number, viewHeight: number): void {
  if (!TRACING) {
    return
  }

  // eslint-disable-next-line no-console
  console.log(`[scroll] ${stamp()} offset=${round(offset)} content=${round(contentHeight)} view=${round(viewHeight)}`)
}

const heights = new Map<string, number>()

/**
 * One row's measured height, logged only when it MOVED.
 *
 * The delta is the point of the line. A row that grows while the reader is at the
 * bottom is the ordinary case and explains nothing; a row that grows and then
 * shrinks again by the same amount is a two-pass layout, and that pattern —
 * `(+13.0)` followed by `(-13.0)` on one key inside a frame or two — is what the
 * inline clock's measurement looked like before it was made single-pass.
 */
export function traceRow(key: string, height: number): void {
  if (!TRACING) {
    return
  }

  const before = heights.get(key)

  if (before !== undefined && Math.abs(before - height) < 0.5) {
    return
  }

  heights.set(key, height)

  const delta = before === undefined ? 'new' : `${before < height ? '+' : ''}${round(height - before)}`

  // eslint-disable-next-line no-console
  console.log(`[row] ${stamp()} ${key} h=${round(height)} (${delta})`)
}

/**
 * A row that takes up space and draws nothing.
 *
 * The owner photographed one: sixty points of empty column between a reply and
 * the next message, with nothing in it. A row whose wrapper has height while its
 * contents measure zero is that defect exactly, and it is invisible in a
 * screenshot precisely because there is nothing to see.
 */
export function traceBlankRow(key: string, wrapperHeight: number, contentHeight: number): void {
  if (!TRACING || contentHeight > 0.5 || wrapperHeight <= 0.5) {
    return
  }

  // eslint-disable-next-line no-console
  console.log(`[blank] ${stamp()} ${key} wrapper=${round(wrapperHeight)} content=${round(contentHeight)}`)
}

/** What the list is holding, once per change, so the rows above can be read. */
export function traceItems(summary: string): void {
  if (!TRACING) {
    return
  }

  // eslint-disable-next-line no-console
  console.log(`[items] ${stamp()} ${summary}`)
}
