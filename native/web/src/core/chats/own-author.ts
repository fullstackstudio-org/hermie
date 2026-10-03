/**
 * Who the reader is, in the one spelling a message row's `author.id` uses
 * (HERM-83, D3).
 *
 * A row is the reader's own when its stamped `author.id` equals this. The
 * stamp is `"<provider>:<user_id>"`, and `/api/auth/me` answers with the bare
 * `user_id` and the `provider` separately, so the id is BUILT by `ownAuthorOf`
 * in `@hermie/gateway-client`, which mirrors the gateway's own construction
 * exactly. Comparing the bare id with the stamp is what drew the reader's own
 * messages on the left, under their own name and picture.
 *
 * Read by the three places that ask "is this row mine?": the transcript, the
 * chat-list preview and the optimistic bubble (`ChatController.send`, through
 * the `ownAuthor` option), so an optimistic bubble and the row that replaces it
 * agree.
 *
 * Deliberately not the device context: that keys `ui_meta` and is spelled
 * differently (the bare id, or the email), and the two must not be conflated.
 *
 * Ported from the Expo app's `src/features/chats/own-author.ts`. Deliberate
 * differences:
 *
 *  - **One gateway, so no `byGateway`, `gatewayId` or `bind`.** A page's
 *    gateway is its own origin; an answer filed under the wrong gateway cannot
 *    happen. `set(author)` and the reader `ownAuthorOn()` take no gateway id.
 *  - **Not persisted, so no `hydrate` and no `OWN_AUTHOR_KEY`.** The Expo app
 *    kept the last answer on disk to cover the stretch between a cached paint
 *    and `/api/auth/me` answering. Here the boot reads `/api/auth/me` before
 *    anything renders (`boot/boot.ts`, `signed_in.author`), so that stretch does
 *    not exist, and an identity on disk would only be one more thing a
 *    sign-out has to remember to clear.
 *  - A vanilla zustand store (`ownAuthorStore`, and `createOwnAuthorStore` for
 *    tests), and the hook `useOwnAuthorId` is the selector `ownAuthorId`, which
 *    a component hands to `useStore`: `core/` is React-free.
 */
import type { MessageAuthor } from '@hermie/transcript'
import { createStore, type StoreApi } from 'zustand/vanilla'

export interface OwnAuthorState {
  /** The reader's own author, as this gateway stamps it; `undefined` when unknown. */
  author: MessageAuthor | undefined
  /**
   * File what the gateway answered. `undefined` forgets it, for the cases that
   * actually mean "there is no answer": a gateway that named no provider, and a
   * sign-out.
   */
  set: (author: MessageAuthor | undefined) => void
  reset: () => void
}

export function createOwnAuthorStore(): StoreApi<OwnAuthorState> {
  return createStore<OwnAuthorState>((set, get) => ({
    author: undefined,

    set: author => {
      const current = get().author

      if (current?.id === author?.id && current?.name === author?.name) {
        return
      }

      set({ author })
    },

    reset: () => set({ author: undefined })
  }))
}

/** The page's store. */
export const ownAuthorStore: StoreApi<OwnAuthorState> = createOwnAuthorStore()

/** The reader's own author on this page's gateway, or `undefined` when unknown. */
export function ownAuthorOn(store: StoreApi<OwnAuthorState> = ownAuthorStore): MessageAuthor | undefined {
  return store.getState().author
}

/**
 * The reader's own author id, as a selector — a string, so a row re-renders
 * only when the id itself changes. `undefined` on a gateway that named nobody:
 * every row then draws as the reader's own, unchanged from before `author`
 * existed.
 */
export function ownAuthorId(state: Pick<OwnAuthorState, 'author'>): string | undefined {
  return state.author?.id
}
