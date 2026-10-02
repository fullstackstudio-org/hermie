/**
 * The browser's answer to `desktop-shortcuts.ts`.
 *
 * Read that file first: it is the whole table, and it is a `HermieMac` native
 * module or nothing. In a tab it was nothing — `requireOptionalNativeModule`
 * returns null, `subscribeToShortcuts` subscribed to a module that is not
 * there, and every shortcut in the app was dead on the web. Not only ⌘K: ⌘1…9,
 * ⌘↑/⌘↓, ⇧⌘S and the composer's own bare ↑, ↓ and Tab all came down the same
 * road, so the slash list could not be driven from the keyboard either. Escape
 * kept working because it arrives through `keyboard-modifiers.web.ts`, which is
 * a different seam — which is exactly why nobody noticed.
 *
 * ## The chords are the Mac's, deliberately
 *
 * `HermieMacModule.swift::shortcut(for:input:)` is the source of truth and this
 * is a transcription of it, down to ⇧⌘S accepting Control as well as Command.
 * A browser table that drifted from the window one would be two tables to keep
 * in agreement for a reader who uses both.
 *
 * ## What the browser takes back
 *
 * ⌘W closes the tab and is not preventable, and ⌘, belongs to the browser on
 * some platforms. Those are the user agent's to keep. Everything else is
 * prevented ONLY when a screen actually took it (`handler` says so), so a bare
 * Tab still moves focus while no suggestion list is open, and ⌘K still reaches
 * the address bar on a screen that has no search.
 *
 * ## Capture, like Escape
 *
 * The same reasoning as `subscribeToEscape`: the surface a shortcut is for is
 * usually not the one holding the caret, and a `keydown` that stops at a
 * focused text field would make ⌘K work everywhere except inside the composer.
 */

import { SHORTCUTS, type ShortcutAction, type ShortcutChord, type ShortcutEvent } from './desktop-shortcuts.shared'

export {
  DOUBLE_FIRE_MS,
  isDoubleFire,
  isMenuBarInstalled,
  MENU_CHORDS,
  setMenuBar,
  SHORTCUTS,
  type MenuBarTitles,
  type ShortcutAction,
  type ShortcutChord,
  type ShortcutEvent
} from './desktop-shortcuts.shared'

/** Does this keystroke hold the modifier `chord` asks for, and only that one? */
function modifiersMatch(chord: ShortcutChord, metaKey: boolean, ctrlKey: boolean): boolean {
  switch (chord.modifier) {
    case 'command':
      return metaKey && !ctrlKey
    case 'commandOrControl':
      return metaKey || ctrlKey
    case 'control':
      return ctrlKey && !metaKey
    case 'none':
      return !metaKey && !ctrlKey
  }
}

/**
 * Which action this keystroke is, or null.
 *
 * A walk of `SHORTCUTS` rather than a `switch`, which is the whole point of
 * this round: the chords used to be written out here a second time, and a
 * second copy of a table is a table that disagrees with the first one the next
 * time somebody adds a row. Exported for its own test — synthesising a
 * `keydown` to reach it would be testing the browser instead of the table.
 *
 * Shift is matched EXACTLY, so ⇧⌘K is not ⌘K: a chord that fired for both would
 * steal a keystroke some other part of the app may want later.
 */
export function shortcutForKey(event: {
  key: string
  code: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
}): ShortcutAction | null {
  const { altKey, code, ctrlKey, key, metaKey, shiftKey } = event

  // Option is not on the table at all, and ⌥↓ is a real editing key.
  if (altKey) {
    return null
  }

  const match = SHORTCUTS.find(chord => {
    if (Boolean(chord.shift) !== shiftKey || !modifiersMatch(chord, metaKey, ctrlKey)) {
      return false
    }

    // `code` wins where a chord carries one: the digit row is punctuation on an
    // AZERTY keyboard, and a table keyed on `key` would leave it with no ⌘1…9.
    return chord.code
      ? chord.code === code
      : chord.keys.some(candidate => candidate.toLowerCase() === key.toLowerCase())
  })

  return match?.action ?? null
}

/**
 * Does a text field hold the caret?
 *
 * The same question `HermieMacModule` answers from the responder chain, asked of
 * the document instead. A `contenteditable` counts: the markdown surface uses
 * one, and a reader typing in it is as much "typing" as one in the composer.
 */
export function typingNow(): boolean {
  const active = typeof document === 'undefined' ? null : document.activeElement

  if (!active) {
    return false
  }

  const tag = active.tagName

  return tag === 'INPUT' || tag === 'TEXTAREA' || (active as HTMLElement).isContentEditable === true
}

export function subscribeToShortcuts(handler: (event: ShortcutEvent) => boolean | void): () => void {
  if (typeof window === 'undefined') {
    return () => undefined
  }

  const listener = (event: KeyboardEvent): void => {
    // A key being held down is one press for this table: ⌘K repeating would
    // reopen the search screen under the reader's own typing.
    if (event.repeat) {
      return
    }

    const action = shortcutForKey(event)

    if (!action) {
      return
    }

    if (handler({ action, typing: typingNow() }) === true) {
      event.preventDefault()
    }
  }

  window.addEventListener('keydown', listener, true)

  return () => window.removeEventListener('keydown', listener, true)
}
