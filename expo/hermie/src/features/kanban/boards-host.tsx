/**
 * Where a door to Boards actually opens the board.
 *
 * ## The board was correct code the app could not reach
 *
 * `KanbanScreen` lays its columns out side by side above `WIDE_BOARD_PX`
 * (700pt) and gains a card drag there. Round R18 measured every door in the
 * shipped app and found none of them that wide:
 *
 * | Door                                 | Width                      |
 * | ------------------------------------ | -------------------------- |
 * | Settings → Boards on an iPad         | 520pt, `OVERLAY_MAX_WIDTH` |
 * | Chat list (…) → Boards               | the sidebar, 300–340pt     |
 * | The phone                            | the window, 402pt          |
 *
 * Both doors render the board IN PLACE — Boards replaces the chat list inside
 * the sidebar, or replaces Settings inside the overlay panel — so the board
 * inherits whatever narrow box its door happens to live in. Every door led to
 * the stacked layout, and the side-by-side one had no home at all.
 *
 * ## So the door asks the shell instead of deciding for itself
 *
 * A shell that has a content column to give — `RegularShell`, on an iPad, a Mac
 * or a wide browser window — provides a `BoardsHost`, and both doors then hand
 * the errand over rather than swapping themselves out. The board lands in the
 * same slot a chat and the Conversations page use: edge to edge, the full width
 * of the window minus the sidebar, which is past 700pt on every wide device.
 *
 * The compact shell provides nothing, so a phone keeps exactly what it had: the
 * board replaces the screen it was opened from, stacked, and the native stack's
 * Back button is the way out. That is why this is a context with a null default
 * rather than a prop threaded through both doors — the phone's answer is "no
 * host", and a missing provider says that without a single line in the phone's
 * shell.
 *
 * `useBoardsOpener` takes the caller's own in-place fallback and hands back one
 * callback with a stable identity, so a door does not have to know which shell
 * it is mounted in and does not re-render when it changes.
 */
import { createContext, useCallback, useContext, useRef, type ReactNode } from 'react'

/** Null where nothing can host a board, which is every compact layout. */
const BoardsHostContext = createContext<(() => void) | null>(null)

export function BoardsHost({ children, open }: { children: ReactNode; open: () => void }) {
  return <BoardsHostContext.Provider value={open}>{children}</BoardsHostContext.Provider>
}

/**
 * One callback for a Boards door: the shell's content column if there is one,
 * the caller's own in-place screen if there is not.
 *
 * The fallback is read through a ref so that the returned callback only changes
 * when the HOST does. Doors pass an arrow function — `() => setShowBoards(true)`
 * — which is a new value on every render, and a menu item whose `onPress`
 * identity churns is a menu that cannot be memoised.
 */
export function useBoardsOpener(fallback: () => void): () => void {
  const host = useContext(BoardsHostContext)
  const latest = useRef(fallback)

  latest.current = fallback

  return useCallback(() => (host ?? latest.current)(), [host])
}

/** Whether a shell is going to take the board, for a door that renders one. */
export function useHasBoardsHost(): boolean {
  return useContext(BoardsHostContext) !== null
}
