/**
 * Undoing what UIKit's own Edit ▸ Paste already did, once a ⌘V turns out to
 * have been a file.
 *
 * `HermiePasteboard.swift` and `native-paste.ts` both say the same thing: a
 * plain-text ⌘V reaches the composer's `UITextView` through the ordinary
 * responder chain, and nothing on the keyboard seam ever intercepts it, because
 * `HermieMacModule`'s GameController handler sits BELOW that chain and only
 * reports — see its module comment. That was written on the assumption that a
 * file or an image has no string representation for `UITextView` to paste, so
 * the ordinary path would simply do nothing for one.
 *
 * The assumption fails for a file. `UIPasteboard.hasStrings` (and `.string`)
 * treats a URL-conforming item as string-representable and synthesises its
 * `absoluteString` on demand — Apple's own coercion between the two, not a
 * Hermie choice — so `canPerformAction(_:withSender:)` answers `true` for a
 * copied file exactly as it would for typed words, and the standard paste
 * inserts the file's path (or, under App Sandbox, its `file:///.file/id=…`
 * proxy) as ordinary text. That happens entirely inside UIKit, before
 * `readPasteboardAttachment` has even been asked anything, so there is no
 * moment at which JavaScript could have said no to it.
 *
 * What JavaScript CAN do is notice, once `readPasteboardAttachment` resolves
 * and says a file was there after all: compare the field against a snapshot
 * taken the instant ⌘V fired, and remove the span that grew in between — but
 * only when that span still looks like the thing UIKit inserts.
 *
 * ## Why the span has to be read, and not just measured
 *
 * "Nothing else runs between the snapshot and the pasteboard answering" was the
 * first version of this rule, and it is not true. The pasteboard answers over a
 * native bridge, which takes as long as it takes, and a reader with a fast
 * keyboard can land a keystroke inside that gap — `Composer.tsx` widens the gap
 * deliberately, into a short window, because the opposite ordering is just as
 * real. So the span is no longer trusted for having grown at the caret: it is
 * read, and it is put back out only when, trimmed, it is exactly ONE file
 * reference and nothing else. Anything else in there is the reader's own words,
 * and their words are worth more than a tidy field.
 *
 * The one thing this cannot tell apart is a character typed flush against the
 * path with no space before it: `/tmp/a.pdfx` is a perfectly good path, and
 * there is no evidence in the string to say the `x` came from a keyboard. That
 * keystroke goes out with the path. Whitespace is the separator that makes the
 * difference visible, and it is the one a reader types without thinking.
 *
 * A pure function, and exported for the same reason `normaliseDroppedFiles`
 * is: it is the one half of this seam a test can check without a Mac and a
 * Finder. `Composer.tsx` is the other half — the snapshot, the window and its
 * cancellation: see the comment on its `paste` shortcut.
 */

/**
 * A file URL as `absoluteString` writes one.
 *
 * Both forms it takes are the same shape to this test: the readable
 * `file:///Users/…/report.pdf` for a document the app can name outright, and
 * the opaque `file:///.file/id=6571367.77787307` proxy App Sandbox hands back
 * for one reached through a security-scoped bookmark. No whitespace anywhere —
 * a URL percent-encodes its spaces, so a raw space in the span came from
 * somebody's keyboard.
 */
const PASTED_FILE_URL = /^file:\/\/\S+$/

/**
 * A bare absolute POSIX path, for the writers that put one on the pasteboard
 * without the scheme.
 *
 * Two segments at minimum (`/tmp/a.pdf`, never `/model`), which is not
 * pedantry about filesystems: this composer's own slash commands are a leading
 * `/` followed by one word, and a reader who types `/model` while a revert
 * window is open would otherwise have it swallowed as a path. A file copied out
 * of Finder always sits under a volume or a home directory and so always has
 * the second segment; a slash command never does. A trailing `/` is allowed
 * because a copied FOLDER has one.
 */
const PASTED_FILE_PATH = /^\/[^\s/]+(?:\/[^\s/]+)+\/?$/

/** The field exactly as it was the instant ⌘V fired. */
export interface PasteSnapshot {
  value: string
  /** The selection's start, which is where an insertion (or a replaced range) begins. */
  start: number
  /** The selection's end — equal to `start` when nothing was selected. */
  end: number
}

/** Where to put the field, and the caret, once the stray paste is undone. */
export interface PasteRevert {
  value: string
  caret: number
}

/**
 * What changed since `before`, if it looks like UIKit's own paste and nothing
 * else.
 *
 * `null` covers four cases on purpose, and they are told apart deliberately
 * rather than lumped into "no change": nothing changed at all (the common
 * case — most builds have no string representation to paste and the field is
 * untouched, and it is also what the caller sees on every look before UIKit's
 * insertion has landed); the field grew or shrank in a shape a caret insertion
 * cannot produce (typing kept happening elsewhere in the meantime, which this
 * must not clobber); the field is merely SHORTER or the same length (paste
 * never removes text, so that is somebody else's edit, not UIKit's); and the
 * span that grew does not read as one file reference, which is the case that
 * makes the caller's repeated looks safe — see the module comment.
 *
 * Only a value that still starts with everything before the old selection,
 * still ends with everything after it, grew, and grew by exactly one file
 * reference is undone — and it is undone by restoring the snapshot whole, so
 * whatever the reader had already typed on both sides comes back untouched.
 */
export function revertStrayPasteText(before: PasteSnapshot, current: string): PasteRevert | null {
  if (current === before.value) {
    return null
  }

  const prefix = before.value.slice(0, before.start)
  const suffix = before.value.slice(before.end)

  if (!current.startsWith(prefix) || !current.endsWith(suffix)) {
    return null
  }

  if (current.length <= prefix.length + suffix.length) {
    return null
  }

  const inserted = current.slice(prefix.length, current.length - suffix.length).trim()

  if (!PASTED_FILE_URL.test(inserted) && !PASTED_FILE_PATH.test(inserted)) {
    return null
  }

  return { caret: before.start, value: before.value }
}
