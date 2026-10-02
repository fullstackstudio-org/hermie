/**
 * The browser's chord table, against the Mac's.
 *
 * `HermieMacModule.swift::shortcut(for:input:)` is the source of truth and
 * `desktop-shortcuts.web.ts` is a transcription of it. Two tables that mean the
 * same thing is exactly the arrangement that drifts, so every row is pinned
 * here — including the three that exist to REFUSE, which is the half a table
 * loses first.
 *
 * Why the table existed to be written at all: in a tab `subscribeToShortcuts`
 * subscribed to a native module that is not there, so every shortcut in the app
 * was dead on the web. Escape kept working because it comes from a different
 * seam, which is what made it invisible.
 */
import { shortcutForKey } from '../src/platform/desktop-shortcuts.web'

const press = (over: Partial<Parameters<typeof shortcutForKey>[0]>) =>
  shortcutForKey({ key: '', code: '', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...over })

describe('the browser chord table', () => {
  it('reads the Command row the Mac emits', () => {
    expect(press({ key: 'k', metaKey: true })).toBe('search')
    expect(press({ key: ',', metaKey: true })).toBe('settings')
    expect(press({ key: 'w', metaKey: true })).toBe('close')
    expect(press({ key: 'ArrowUp', metaKey: true })).toBe('previousChat')
    expect(press({ key: 'ArrowDown', metaKey: true })).toBe('nextChat')
    expect(press({ key: 'Tab', ctrlKey: true })).toBe('nextChat')
  })

  it('takes ⇧⌘S — and ⌃⇧S, which the Mac also accepts', () => {
    expect(press({ key: 's', metaKey: true, shiftKey: true })).toBe('toggleSidebar')
    expect(press({ key: 'S', ctrlKey: true, shiftKey: true })).toBe('toggleSidebar')
  })

  it('numbers the chats from the PHYSICAL digit row', () => {
    // `code`, not `key`: on AZERTY the unshifted digit row is punctuation, and a
    // table keyed on `key` would leave that keyboard with no ⌘1…9 at all.
    expect(press({ key: '1', code: 'Digit1', metaKey: true })).toBe('chat1')
    expect(press({ key: '&', code: 'Digit1', metaKey: true })).toBe('chat1')
    expect(press({ key: '9', code: 'Digit9', metaKey: true })).toBe('chat9')
    expect(press({ key: '0', code: 'Digit0', metaKey: true })).toBeNull()
  })

  it('carries the composer list keys bare, and nothing else bare', () => {
    expect(press({ key: 'ArrowUp' })).toBe('suggestionUp')
    expect(press({ key: 'ArrowDown' })).toBe('suggestionDown')
    expect(press({ key: 'Tab' })).toBe('suggestionAccept')

    // The whole reason the bare row is allowed to exist: none of these inserts a
    // character, so nothing typed into a field crosses into the app.
    expect(press({ key: 'k' })).toBeNull()
    expect(press({ key: 'a' })).toBeNull()
    expect(press({ key: '1', code: 'Digit1' })).toBeNull()
  })

  it('refuses what the Mac refuses', () => {
    // Shift disqualifies everything except ⇧⌘S, so ⇧⌘K cannot be mistaken for ⌘K.
    expect(press({ key: 'K', metaKey: true, shiftKey: true })).toBeNull()
    expect(press({ key: 'ArrowDown', shiftKey: true })).toBeNull()
    // Option is not on the table at all, and ⌥↓ is a real editing key.
    expect(press({ key: 'ArrowDown', altKey: true })).toBeNull()
    expect(press({ key: 'k', metaKey: true, altKey: true })).toBeNull()
    // Control alone is not Command: ⌃K is "kill to end of line" on a Mac.
    expect(press({ key: 'k', ctrlKey: true })).toBeNull()
  })
})
