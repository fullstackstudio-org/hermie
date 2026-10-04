/**
 * The keyboard shortcuts of the page, as a table and a matcher (the Expo app's `desktop-shortcuts.shared.ts`, for a
 * browser): what each key combination is called, and which one a key event is. The page's one listener
 * (`features/shell/use-shortcuts.ts`) acts on what this says, and the help dialog draws the same table, so what it
 * promises is what the listener answers to.
 *
 * ## What a browser lets a page have
 *
 * A shortcut the browser owns never reaches the page, and one that does reach it is the page's to refuse. Chrome,
 * Firefox and Safari keep the commands that make or close a window or a tab and the ones that switch tabs (new
 * window, new tab, close, Control+Tab: the browser's "reserved" shortcuts, which a page cannot see or cancel), and give
 * a page everything else first. So the table is written in two layers, and says so:
 *
 *  - **The familiar chord** of the desktop apps, where the browser does not own it: Cmd/Ctrl+K (search), Cmd/Ctrl+1-9
 *    (the chats) and Cmd/Ctrl+Up and Down (the previous and the next chat).
 *  - **A chord beside it that a browser leaves alone**, for the ones it does own: Cmd/Ctrl+N is a new window, and
 *    Control+Tab switches tabs, so a new conversation is also Cmd/Ctrl+Alt+N, and the chats are also Alt+Up and Down.
 *    The familiar ones stay in the table because a page opened as an installed app has no tabs and no new-window command,
 *    and the browser then lets them through; in a plain tab they are never seen, and the one beside them works.
 *
 * Nothing here cancels a key the page does not act on: a combination that does nothing right now (a new conversation
 * with no chat open) is left to the browser, so Cmd/Ctrl+N still opens a window from the chat list.
 *
 * ## What a text field keeps
 *
 * Typing is not interrupted. The arrow chords are the text's while a field has the caret (Cmd+Up is "to the start" on a
 * Mac), as are the question mark and the plain keys; the chords with a letter or a digit mean nothing to a field and are
 * the page's wherever the caret is. That is the `outsideFields` of a chord.
 *
 * ## How a key is read
 *
 * A letter by what it types (`key`), so a Dvorak or an AZERTY keyboard has its own K; a digit by its place (`code`),
 * because an AZERTY keyboard types punctuation on the unshifted digits; and Option+letter on a Mac by its place too,
 * because Option+N types a dead key and `key` no longer says N. Modifiers are exact: Shift+Cmd+K is not Cmd+K.
 */

/** What a shortcut does. `chat` is one of nine: the Nth chat of the list. */
export type ShortcutAction = 'search' | 'newConversation' | 'previousChat' | 'nextChat' | 'chat' | 'help'

export interface Chord {
  /** A letter or a symbol as it types, `Digit` for 1 to 9, or a named key (`ArrowUp`, `Tab`). */
  key: string
  /** Command on a Mac, Control elsewhere. */
  mod?: true
  /** Control itself, on every platform (a shortcut that is Control+Tab everywhere). */
  ctrl?: true
  alt?: true
  shift?: true | 'any'
  /** Left to a text field while it has the caret. */
  outsideFields?: true
}

export interface Shortcut {
  action: ShortcutAction
  /** In the order the help dialog lists them. */
  chords: readonly Chord[]
}

export const SHORTCUTS: readonly Shortcut[] = [
  { action: 'search', chords: [{ key: 'k', mod: true }] },
  {
    action: 'newConversation',
    chords: [
      { key: 'n', mod: true },
      { key: 'n', mod: true, alt: true }
    ]
  },
  {
    action: 'previousChat',
    chords: [
      { key: 'ArrowUp', mod: true, outsideFields: true },
      { key: 'ArrowUp', alt: true, outsideFields: true },
      { key: 'Tab', ctrl: true, shift: true }
    ]
  },
  {
    action: 'nextChat',
    chords: [
      { key: 'ArrowDown', mod: true, outsideFields: true },
      { key: 'ArrowDown', alt: true, outsideFields: true },
      { key: 'Tab', ctrl: true }
    ]
  },
  { action: 'chat', chords: [{ key: 'Digit', mod: true }] },
  {
    action: 'help',
    chords: [
      { key: '?', shift: 'any', outsideFields: true },
      { key: '/', mod: true }
    ]
  }
]

/** What a matcher needs of a key event. */
export interface KeyEventLike {
  key: string
  code: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

export interface ShortcutHit {
  action: ShortcutAction
  chord: Chord
  /** For `chat`: which one, from 1. */
  index?: number
}

/**
 * A Mac, an iPhone or an iPad: where Command is the key and Option types dead keys.
 *
 * Either of the two ways a page can ask says yes: the platform string is the keyboard's own machine (an iPad that
 * asks for desktop sites says `MacIntel`, which is right: it has a Command key), and the client hints name the same
 * machines `macOS` and `iOS`. A user-agent switcher changes the hints and not the keyboard, so a "no" from one is not
 * believed over a "yes" from the other.
 */
export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') {
    return false
  }

  const hinted = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? ''

  return /mac|iphone|ipad|ipod/iu.test(navigator.platform ?? '') || /mac|ios/iu.test(hinted)
}

function modifiersMatch(chord: Chord, event: KeyEventLike, apple: boolean): boolean {
  const command = apple ? event.metaKey : event.ctrlKey
  const other = apple ? event.ctrlKey : event.metaKey
  const wantsControl = chord.ctrl === true

  // Command (or Control) as the platform's modifier, or Control itself, or neither; never the other one as well.
  if (wantsControl ? !event.ctrlKey || event.metaKey : chord.mod ? !command || other : event.metaKey || event.ctrlKey) {
    return false
  }

  if (event.altKey !== (chord.alt === true)) {
    return false
  }

  return chord.shift === 'any' || event.shiftKey === (chord.shift === true)
}

/** The index (1 to 9) of the digit key a event is, by its place on the keyboard, or `undefined`. */
const digitOf = (event: KeyEventLike): number | undefined => {
  const match = /^(?:Digit|Numpad)([1-9])$/u.exec(event.code)

  return match ? Number(match[1]) : undefined
}

function keyMatches(chord: Chord, event: KeyEventLike, apple: boolean): number | boolean {
  if (chord.key === 'Digit') {
    return digitOf(event) ?? false
  }

  if (chord.key.length > 1) {
    return event.key === chord.key
  }

  if (event.key.toLowerCase() === chord.key) {
    return true
  }

  // Option+letter on a Mac types a dead key or a symbol: the place of the key says which letter it was.
  return apple && chord.alt === true && /^[a-z]$/u.test(chord.key) && event.code === `Key${chord.key.toUpperCase()}`
}

/** The shortcut a key event is, or `null`. Pure: the page's listener and the tests ask the same question. */
export function matchShortcut(event: KeyEventLike, apple: boolean): ShortcutHit | null {
  for (const shortcut of SHORTCUTS) {
    for (const chord of shortcut.chords) {
      if (!modifiersMatch(chord, event, apple)) {
        continue
      }

      const hit = keyMatches(chord, event, apple)

      if (hit !== false) {
        return { action: shortcut.action, chord, ...(typeof hit === 'number' ? { index: hit } : {}) }
      }
    }
  }

  return null
}

/** Whether a key event's target takes text: a field, a text area, a select, or something edited in place. */
export function isTextTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false
  }

  const element = target as HTMLElement

  return (
    element.isContentEditable ||
    (['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) &&
      !['button', 'checkbox', 'radio', 'range', 'file', 'submit', 'reset', 'image', 'color'].includes(
        (element as HTMLInputElement).type
      ))
  )
}
