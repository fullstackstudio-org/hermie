/**
 * A browser has no Quick Look, and this says so.
 *
 * Read `quick-look.ts` first. The whole seam answers one question — "was the
 * file shown?" — and on the web the answer is always no, which sends the caller
 * to `share-file.web.ts` and a download. That is what a tap on an attachment
 * chip does in a tab today and what it should keep doing: a page cannot host a
 * system previewer, and building one out of an `<iframe>` or `<embed>` would be
 * a second viewer with its own list of types it gets wrong.
 *
 * So this file is two constants rather than a feature detection. It is
 * deliberately NOT wired to anything the browser does have — `window.open` on a
 * PDF, say — because "shown" would then mean something different here than it
 * does on the native side, and the caller decides its fallback from this
 * answer.
 */

/** Never. A page cannot host `QLPreviewController` or anything like it. */
export const CAN_QUICK_LOOK = false

/** Always false, so the caller downloads instead. */
export async function openInQuickLook(_uri: string, _name?: string): Promise<boolean> {
  return false
}
