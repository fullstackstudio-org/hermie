/**
 * Does this platform's scroll view keep its own place when a row grows?
 *
 * `TranscriptList` holds the reader's place across a `Show more` by hand: it
 * records the offset at the tap, waits for the content to be measured, and
 * scrolls to `offset + growth` (`holdPlace` / `settleHold` / `holdTarget`). That
 * arithmetic exists because of what an inverted `UIScrollView` does on its own —
 * it pins the growing cell's BOTTOM edge, so holding the bare offset leaves the
 * reader at the END of the message they just asked to read.
 *
 * A browser does the opposite, which is why this is a seam rather than a
 * constant. See `scroll-anchor.web.ts` for the measurement.
 *
 * False here, and false is the value every native platform wants: iOS, Android,
 * and the Mac build, which is the iPad build.
 */
export const ANCHORS_GROWTH_ITSELF = false
