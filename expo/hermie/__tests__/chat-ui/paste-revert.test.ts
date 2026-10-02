/**
 * `revertStrayPasteText` in isolation — see its own module comment for why this
 * is the one half of the stray-paste-text bug a test can check without a Mac
 * and a Finder.
 */
import { revertStrayPasteText } from '../../src/chat-ui/paste-revert'

describe('revertStrayPasteText', () => {
  it('removes a file path UIKit pasted at the end of an empty field', () => {
    const before = { end: 0, start: 0, value: '' }

    expect(revertStrayPasteText(before, 'file:///.file/id=6571367.77787307')).toEqual({
      caret: 0,
      value: ''
    })
  })

  it('leaves what the reader had already typed on both sides of the caret', () => {
    // "check this " | caret | " before you send" — a file pasted mid-sentence.
    const before = { end: 11, start: 11, value: 'check this  before you send' }

    const pasted = 'check this file:///tmp/a.pdf before you send'

    expect(revertStrayPasteText(before, pasted)).toEqual({
      caret: 11,
      value: 'check this  before you send'
    })
  })

  it('replaces a selected range the same way the paste itself would have', () => {
    // "TODO" selected in "TODO: ship it".
    const before = { end: 4, start: 0, value: 'TODO: ship it' }

    expect(revertStrayPasteText(before, 'file:///tmp/a.pdf: ship it')).toEqual({
      caret: 0,
      value: 'TODO: ship it'
    })
  })

  it('does nothing when the field never changed — the common case, nothing to paste as text', () => {
    const before = { end: 5, start: 5, value: 'hello' }

    expect(revertStrayPasteText(before, 'hello')).toBeNull()
  })

  it('does nothing when the field only shrank — paste never removes text', () => {
    const before = { end: 5, start: 5, value: 'hello' }

    expect(revertStrayPasteText(before, 'hell')).toBeNull()
  })

  it('does nothing when the change does not bracket the old selection — a concurrent edit, not a paste', () => {
    const before = { end: 5, start: 5, value: 'hello' }

    // Typed at the FRONT while the paste was in flight, not around the caret.
    expect(revertStrayPasteText(before, 'zzhello')).toBeNull()
  })

  /**
   * The shape guard, which is what makes the caller's repeated looks safe.
   *
   * A window that watches the field for a few frames sees whatever the reader
   * does in those frames, so "something grew at the caret" stopped being enough
   * evidence that UIKit did it. Only a span that reads as one file reference is
   * treated as UIKit's; everything else belongs to whoever is typing.
   */
  describe('telling UIKit’s insertion apart from the reader’s own typing', () => {
    it('removes the App Sandbox proxy form as readily as a plain file URL', () => {
      const before = { end: 0, start: 0, value: '' }

      expect(revertStrayPasteText(before, 'file:///Users/someone/Documents/report.pdf')).toEqual({
        caret: 0,
        value: ''
      })
    })

    it('removes a bare absolute path with no scheme on it', () => {
      const before = { end: 0, start: 0, value: '' }

      expect(revertStrayPasteText(before, '/Users/someone/Documents/report.pdf')).toEqual({ caret: 0, value: '' })
    })

    it('removes a pasted folder, trailing slash and all', () => {
      const before = { end: 0, start: 0, value: '' }

      expect(revertStrayPasteText(before, '/Users/someone/Documents/')).toEqual({ caret: 0, value: '' })
    })

    it('leaves an ordinary character typed at the caret alone', () => {
      const before = { end: 0, start: 0, value: '' }

      expect(revertStrayPasteText(before, 'h')).toBeNull()
    })

    it('leaves a whole typed word alone, however well it brackets the old caret', () => {
      const before = { end: 5, start: 5, value: 'hello' }

      expect(revertStrayPasteText(before, 'hello there')).toBeNull()
    })

    it('leaves a slash command alone — one segment is a command, two are a path', () => {
      // The composer's own completion list opens on exactly this, and a reader
      // typing it into a field with an open revert window must keep it.
      const before = { end: 0, start: 0, value: '' }

      expect(revertStrayPasteText(before, '/model')).toBeNull()
      expect(revertStrayPasteText(before, '/compact')).toBeNull()
    })

    it('leaves a path with a word typed after it — the span is no longer one reference', () => {
      const before = { end: 0, start: 0, value: '' }

      expect(revertStrayPasteText(before, 'file:///tmp/a.pdf have a look')).toBeNull()
      expect(revertStrayPasteText(before, '/tmp/a.pdf have a look')).toBeNull()
    })

    it('leaves two pasted paths alone — one reference is the rule, and this is not one', () => {
      // Several files in one paste are several attachments, but `UITextView`
      // inserts only `UIPasteboard.string`, which is the FIRST item. A span
      // holding two is a span this has no account of, so it stays.
      const before = { end: 0, start: 0, value: '' }

      expect(revertStrayPasteText(before, '/tmp/a.pdf /tmp/b.pdf')).toBeNull()
    })

    it('still removes a reference the field reported with whitespace around it', () => {
      const before = { end: 0, start: 0, value: '' }

      expect(revertStrayPasteText(before, '\n/tmp/a.pdf\n')).toEqual({ caret: 0, value: '' })
    })
  })
})
