/**
 * On the web the scroll view holds the place by itself, and the app's hold is
 * what moves the reader.
 *
 * `maintainVisibleContentPosition` is not implemented in react-native-web at
 * all, so the reasonable guess is that the web build needs MORE anchoring than
 * the native one. It needs none. An inverted list is
 * `transform: scaleY(-1)` on the scroller plus the same flip on every cell
 * (`VirtualizedList`'s `verticallyInverted`), and a browser preserves
 * `scrollTop` across a content change. Under that flip, a preserved `scrollTop`
 * pins every DOM offset that did not move — which is the whole conversation
 * BELOW the growth, including the `Show more` control itself, because a cell
 * lays its body out at larger DOM offsets than its own footer.
 *
 * Measured on that exact DOM — a 400pt scroller, twelve flipped cells, one body
 * grown by 300 — at three starting offsets and on the way back:
 *
 * | start | growth | `Show more` moves, no hold | with the hold |
 * | ----- | ------ | -------------------------- | ------------- |
 * | 200   | +300   | 0                          | +300          |
 * | 0     | +300   | 0                          | +300          |
 * | 600   | +300   | 0                          | +300          |
 * | 500   | −300   | 0                          | −300          |
 *
 * The newer rows under it move by the same numbers. So the hold is not a
 * correction here, it is the whole displacement: the reader loses their place
 * by exactly the amount the fold grew, every time, which is the report.
 *
 * Nothing replaces it. Doing nothing is also what Reduce Motion asks for —
 * there is no movement left to shorten — and it costs nothing on a reader who
 * never opens a fold.
 */
export const ANCHORS_GROWTH_ITSELF = true
