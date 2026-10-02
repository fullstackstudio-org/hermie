/**
 * One desktop shortcut, delivered to whoever registered it last.
 *
 * Deliberately the same shape as `useEscapeKey`, and for the same reason: the
 * event arrives from the keyboard seam with no notion of what is on screen, so
 * something has to decide who gets it. A stack per action does, with the rule a
 * reader already expects — the thing that opened last wins — so ⌘1 typed while a
 * sheet is up can be swallowed by that sheet without the chat list knowing.
 *
 * One native subscription is held for every action rather than one per caller,
 * because the event is global anyway and a listener per registration would make
 * the delivery order depend on the subscription order instead of on this.
 *
 * **`close` is not registrable.** ⌘W is defined as "one level, like Escape", so it
 * is delivered to the Escape stack and nothing else. Two stacks that both claim to
 * mean "close one level" would be two stacks to keep in agreement.
 *
 * ## Two gates in front of the stacks
 *
 * The stacks answer "which screen", and the owner's report from build 163 is that
 * some shortcuts should not have been delivered to ANY screen: a `k` typed into
 * the theme editor, with Settings open over the chat list, moved the caret to the
 * chat list's search field. Three things were wrong at once and only the first is
 * a key table:
 *
 *  1. the modifier was believed to be held when it was not (`HermieMacModule`);
 *  2. the keystroke belonged to the field the caret was in;
 *  3. the surface it switched to was underneath a panel the reader had open.
 *
 * `shortcutIsDeliverable` is (2) and (3), and it is a pure function so that both
 * can be asked without a keyboard. The typing gate is CLOSED by default and the
 * allow-list is short on purpose — the composer's own list keys, which carry no
 * text, and `close`, which has to work from inside a sheet's own text field.
 * Everything else comes back through the menu bar's key equivalents on a Mac and
 * on an iPad, where the responder chain has already arbitrated it.
 */
import { useEffect, useRef } from 'react'

import { subscribeToShortcuts, type ShortcutAction, type ShortcutEvent } from '../platform/desktop-shortcuts'
import { closeTopmost } from './useEscapeKey'

/** Everything a screen may claim. `close` is handled by the Escape stack instead. */
export type RegistrableShortcut = Exclude<ShortcutAction, 'close'>

/**
 * Delivered even while a text input holds the caret.
 *
 * The three list keys are the composer's own — they are bare ↑, ↓ and Tab, they
 * exist FOR a focused field, and they are ignored unless a suggestion list is
 * open. `close` is here because ⌘W means "one level" and the level a reader wants
 * to leave is often the sheet whose field they are typing in. `paste` belongs here
 * for the same reason as the list keys: it exists FOR a focused field — there is
 * no other reason to ask the pasteboard for an image — so a gate written for
 * everything ELSE on the table would refuse the one field it is for.
 */
const DELIVERED_WHILE_TYPING: readonly ShortcutAction[] = [
  'suggestionUp',
  'suggestionDown',
  'suggestionAccept',
  'close',
  'paste'
]

/**
 * Shortcuts that move the reader to a DIFFERENT surface.
 *
 * Suppressed while an overlay, a sheet or Settings is open, because the surface
 * they move to is the one underneath it — the reader would be typing into a field
 * they can no longer see. `close` is not one of them: it is how you leave.
 */
const SWITCHES_SURFACE: readonly ShortcutAction[] = [
  'search',
  'toggleSidebar',
  /*
    ⌘N is not a move, but it belongs here for the same reason the moves do: it
    retires the session and empties the transcript of the chat UNDERNEATH
    whatever is open. A reader who has a sheet up and presses it would come back
    to a conversation that is not the one they left.
  */
  'newConversation',
  'nextChat',
  'previousChat',
  'chat1',
  'chat2',
  'chat3',
  'chat4',
  'chat5',
  'chat6',
  'chat7',
  'chat8',
  'chat9'
]

export interface ShortcutContext {
  /** A text input holds the caret. */
  typing: boolean
  /** How many overlays, sheets and panels are open over the surface underneath. */
  modalDepth: number
}

/** Should this shortcut reach a screen at all? The two gates, as one answer. */
export function shortcutIsDeliverable(action: ShortcutAction, { typing, modalDepth }: ShortcutContext): boolean {
  if (typing && !DELIVERED_WHILE_TYPING.includes(action)) {
    return false
  }

  return !(modalDepth > 0 && SWITCHES_SURFACE.includes(action))
}

type Entry = { fire: () => void }

const stacks = new Map<RegistrableShortcut, Entry[]>()
let detach: (() => void) | null = null
let registrations = 0

/**
 * How many modal scopes are open.
 *
 * A count rather than a boolean: a sheet over a panel is two, and the panel
 * closing under a sheet — which `ChatSheetHost` does — must not reopen the gate
 * while the sheet is still up.
 */
let modalDepth = 0

/** For a test that needs to start from a known surface. Not used by the app. */
export function resetShortcutScopes(): void {
  modalDepth = 0
}

/**
 * Deliver one action, and say whether anything took it.
 *
 * The answer is the browser seam's: it decides `preventDefault` from it, so a
 * bare Tab still moves focus while no suggestion list is open and ⌘K still
 * reaches the address bar on a screen with no search. On the Mac nothing reads
 * it — by the time this runs, the responder chain and GameController have both
 * already had the keystroke.
 */
function deliver(event: ShortcutEvent): boolean {
  if (!shortcutIsDeliverable(event.action, { modalDepth, typing: event.typing })) {
    return false
  }

  if (event.action === 'close') {
    return closeTopmost()
  }

  const stack = stacks.get(event.action)
  const top = stack?.[stack.length - 1]

  top?.fire()

  return Boolean(top)
}

/**
 * Declare that something modal is open while `enabled`.
 *
 * Deliberately NOT the Escape stack, although every caller registers on both. The
 * Escape stack is about WHO takes a key; this is about whether a whole class of
 * key means anything right now, and a handler at the top of a stack cannot
 * express "and nothing under me either" without every screen under it knowing
 * that it exists.
 */
export function useShortcutScope(enabled = true): void {
  useEffect(() => {
    if (!enabled) {
      return
    }

    modalDepth += 1

    return () => {
      modalDepth = Math.max(0, modalDepth - 1)
    }
  }, [enabled])
}

/**
 * Take `action` while `enabled`.
 *
 * `enabled` is the visibility of whatever is registering. Flipping it is what
 * pushes and pops, so a caller never has to think about ordering.
 */
export function useShortcut(action: RegistrableShortcut, handler: () => void, enabled = true): void {
  // The handler is read through a ref so a new closure on every render does not
  // re-order the stack.
  const latest = useRef(handler)

  latest.current = handler

  useEffect(() => {
    if (!enabled) {
      return
    }

    const entry: Entry = { fire: () => latest.current() }
    const stack = stacks.get(action) ?? []

    stack.push(entry)
    stacks.set(action, stack)
    registrations += 1

    if (registrations === 1) {
      detach = subscribeToShortcuts(deliver)
    }

    return () => {
      const index = stack.lastIndexOf(entry)

      if (index >= 0) {
        stack.splice(index, 1)
        registrations -= 1
      }

      if (registrations === 0) {
        detach?.()
        detach = null
      }
    }
  }, [action, enabled])
}

/**
 * ⌘1…9, as one registration.
 *
 * The chat list is the only caller and it always wants all nine, so nine hooks at
 * the call site would be nine chances to get the index wrong. `index` is
 * zero-based, which is what a list wants; the shortcut is one-based, which is what
 * a keyboard has.
 */
export function useNumberedShortcuts(handler: (index: number) => void, enabled = true): void {
  const latest = useRef(handler)

  latest.current = handler

  useShortcut('chat1', () => latest.current(0), enabled)
  useShortcut('chat2', () => latest.current(1), enabled)
  useShortcut('chat3', () => latest.current(2), enabled)
  useShortcut('chat4', () => latest.current(3), enabled)
  useShortcut('chat5', () => latest.current(4), enabled)
  useShortcut('chat6', () => latest.current(5), enabled)
  useShortcut('chat7', () => latest.current(6), enabled)
  useShortcut('chat8', () => latest.current(7), enabled)
  useShortcut('chat9', () => latest.current(8), enabled)
}
