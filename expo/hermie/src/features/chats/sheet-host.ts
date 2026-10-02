/**
 * Which sheet a chat has on screen, as a state machine with no React in it.
 *
 * The chat used to render four sibling sheets and let each one decide whether
 * it was visible. On iOS that is four sibling `Modal`s: the first one presented
 * wins, and a permission request arriving while the options sheet is open is
 * simply never shown — the agent waits on a question nobody was offered.
 *
 * So there is exactly one sheet, and this decides which. Two rules:
 *
 *  - Priority. A question the agent is BLOCKED on outranks the agents sheet,
 *    which outranks the options sheet. Nothing the reader opened is more
 *    important than the thing that is waiting on them.
 *  - One at a time, in order. A sheet that is on screen when the target changes
 *    is closed first and the next one opens only once it has actually gone
 *    (`settled`). Swapping the body of a presented sheet would move the buttons
 *    under a finger already on its way down.
 */

/** The sheets a chat can present. `request` is an approval or a clarify. */
export type SheetKind = 'none' | 'options' | 'agents' | 'profile' | 'conversations' | 'request'

/** The four a reader opens themselves. */
export type ManualSheet = 'none' | 'options' | 'agents' | 'profile' | 'conversations'

export interface SheetHostState {
  /** The sheet that is mounted right now. */
  presented: SheetKind
  /** The sheet that should be on screen; differs from `presented` mid-swap. */
  target: SheetKind
}

export type SheetHostEvent =
  /** The desired sheet changed — a request arrived, or a button was tapped. */
  | { type: 'target'; target: SheetKind }
  /** The presented sheet finished its slide-out and is off the screen. */
  | { type: 'settled' }

export const initialSheetHostState: SheetHostState = { presented: 'none', target: 'none' }

/**
 * Priority: a blocked agent first, then whatever the reader opened.
 *
 * The profile sheet needs no rank of its own — it is one of the manual sheets,
 * and the only ordering that has ever mattered here is that a question the
 * agent is waiting on outranks all of them.
 */
export function targetSheet(manual: ManualSheet, hasRequest: boolean): SheetKind {
  return hasRequest ? 'request' : manual
}

export function sheetHostReducer(state: SheetHostState, event: SheetHostEvent): SheetHostState {
  switch (event.type) {
    case 'target': {
      if (event.target === state.target) {
        return state
      }

      // Nothing is on screen, so there is nothing to wait for.
      if (state.presented === 'none') {
        return { presented: event.target, target: event.target }
      }

      // Back to the sheet that is still sliding out: cancel the swap.
      if (event.target === state.presented) {
        return { presented: state.presented, target: event.target }
      }

      return { presented: state.presented, target: event.target }
    }

    case 'settled':
      return { presented: state.target, target: state.target }
  }
}

/** The presented sheet is visible only while it is also the one we want. */
export function isSheetVisible(state: SheetHostState): boolean {
  return state.presented !== 'none' && state.presented === state.target
}
