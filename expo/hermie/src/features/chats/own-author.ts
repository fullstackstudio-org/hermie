/**
 * Who the reader is, in the one spelling a message row's `author.id` uses
 * (HERM-83, D3).
 *
 * A row is the reader's own when its stamped `author.id` equals this. The
 * stamp is `"<provider>:<user_id>"`, and `/api/auth/me` answers with the bare
 * `user_id` and the `provider` separately, so the id is BUILT here, by
 * `ownAuthorOf` in `@hermie/gateway-client`, which mirrors the gateway's own
 * construction exactly. Comparing the bare id with the stamp is what drew the
 * reader's own messages on the left, under their own name and picture.
 *
 * Owned by `ChatRuntimeProvider`, which feeds it from the `/api/auth/me` read it
 * already does on every ready edge, and read by the three places that ask
 * "is this row mine?": the transcript (`ChatScreen`), the chat-list preview
 * (`row-preview.ts`) and the optimistic bubble (`ChatController.send`, through
 * the `ownAuthor` option), so an optimistic bubble and the row that replaces it
 * agree.
 *
 * Keyed per gateway. Two gateways can mint the same `provider:sub` for two
 * different people, and an `/api/auth/me` answer that lands after the reader
 * has switched gateways must never be read as the new gateway's identity: it
 * is filed under the gateway that answered, and readers look only under the
 * gateway the runtime is bound to.
 *
 * Deliberately not `device-context`: that store's `userId` keys `ui_meta` and
 * is spelled differently (the bare id, or the email), and the two must not be
 * conflated.
 *
 * **Persisted, per gateway, the way `chat-layout.ts` and `store/bots.ts` persist
 * everything else that is namespaced.** The id used to be wiped back to
 * "unknown" the moment a new connection was built, on the theory that a new
 * connection can be a new sign-in and the last one's answer should not be
 * trusted. That theory was right about trust and wrong about the interval it
 * protected: "unknown" reads as "draw everything as my own" (the one safe
 * default before `author` existed at all), so a cold open with a cached
 * transcript painted a colleague's bubbles on the right, under a receipt, for
 * the whole stretch between the first paint and the moment `/api/auth/me`
 * actually answered — visible jank on every launch. The id on disk is not
 * trusted either; it is *shown* while the real answer is in flight, and
 * `readIdentity`'s ready-edge read is still what corrects it. The one thing
 * that changed is that "in flight" now starts from the last good guess instead
 * of from nothing.
 */
import type { MessageAuthor } from '@hermie/transcript'
import { create } from 'zustand'

import type { GatewayNamespace } from '../../gateway/namespace'
import { namespace } from '../../gateway/namespace'
import { keyValueStore } from '../../platform/key-value-store'

/** The namespaced key one gateway's remembered id lives under. */
export const OWN_AUTHOR_KEY = 'hermie.chats.own_author'

interface OwnAuthorState {
  /** Per gateway id: the reader's own author, as that gateway stamps it. */
  byGateway: Record<string, MessageAuthor>
  /** The gateway the running chat runtime is connected to, or `null` for none. */
  gatewayId: string | null
  bind: (gatewayId: string | null) => void
  /**
   * File what `gatewayId` answered, and persist it. `undefined` forgets it —
   * on disk too — for the three cases `readIdentity` and sign-out actually
   * mean by "there is no answer": a refusal, a gateway that named no provider,
   * and a sign-out. A connection merely being rebuilt is not one of them; see
   * the module comment.
   */
  set: (gatewayId: string, author: MessageAuthor | undefined) => void
  /**
   * Load the gateway's last remembered id off disk, for the stretch before
   * `set` is next called. A no-op where memory already holds an answer for
   * this gateway — never overwrites a fresher `set`, whichever order the two
   * happen to resolve in — and where disk holds nothing parseable.
   */
  hydrate: (ns: GatewayNamespace) => Promise<void>
  reset: () => void
}

/** `undefined` unless `value` is a plausible `MessageAuthor`: a non-empty `id`, an optional string `name`. */
function parseStoredAuthor(value: unknown): MessageAuthor | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }

  const { id, name } = value as { id?: unknown; name?: unknown }

  if (typeof id !== 'string' || !id) {
    return undefined
  }

  return typeof name === 'string' && name ? { id, name } : { id }
}

let writeQueue: Promise<void> = Promise.resolve()

/**
 * Serialised like `device-context.ts`'s `persist`: two `set` calls in quick
 * succession — a stale answer followed by the real one — must land on disk in
 * that order, not whichever `setJson` happens to settle first.
 */
function persistOwnAuthor(ns: GatewayNamespace, author: MessageAuthor | undefined): void {
  writeQueue = writeQueue
    .then(() =>
      author ? keyValueStore.setJson(ns.key(OWN_AUTHOR_KEY), author) : keyValueStore.delete(ns.key(OWN_AUTHOR_KEY))
    )
    .catch(() => {
      // An id that fails to persist is read fresh again on the next ready
      // edge; the only cost is the repaint this whole file exists to avoid,
      // once, and that is not worth an error screen.
    })
}

export const useOwnAuthorStore = create<OwnAuthorState>((set, get) => ({
  byGateway: {},
  gatewayId: null,

  bind: gatewayId => {
    if (get().gatewayId !== gatewayId) {
      set({ gatewayId })
    }
  },

  set: (gatewayId, author) => {
    const current = get().byGateway[gatewayId]

    if (current?.id === author?.id && current?.name === author?.name) {
      return
    }

    set(state => {
      const byGateway = { ...state.byGateway }

      if (author) {
        byGateway[gatewayId] = author
      } else {
        delete byGateway[gatewayId]
      }

      return { byGateway }
    })

    persistOwnAuthor(namespace(gatewayId), author)
  },

  hydrate: async ns => {
    const stored = await keyValueStore.getJson<unknown>(ns.key(OWN_AUTHOR_KEY)).catch(() => null)
    const author = parseStoredAuthor(stored)

    if (!author) {
      return
    }

    set(state => {
      // A `set` for this gateway already landed while the disk read was in
      // flight — a very fast `/api/auth/me`, or a test calling it directly.
      // That answer is the fresher one; this read must not undo it.
      if (state.byGateway[ns.id] !== undefined) {
        return state
      }

      return { byGateway: { ...state.byGateway, [ns.id]: author } }
    })
  },

  reset: () => set({ byGateway: {}, gatewayId: null })
}))

/** The reader's own author on `gatewayId`, or `undefined` when unknown. */
export function ownAuthorOn(gatewayId: string | null | undefined): MessageAuthor | undefined {
  return gatewayId ? useOwnAuthorStore.getState().byGateway[gatewayId] : undefined
}

/**
 * The reader's own author id on the gateway the runtime is bound to — a
 * string, so a row re-renders only when the id itself changes. `undefined`
 * before `/api/auth/me` has answered, on a gateway that named nobody, and
 * with no gateway at all: every one of those draws every row as the reader's
 * own, unchanged from before `author` existed.
 */
export function useOwnAuthorId(): string | undefined {
  return useOwnAuthorStore(state => (state.gatewayId ? state.byGateway[state.gatewayId]?.id : undefined))
}
