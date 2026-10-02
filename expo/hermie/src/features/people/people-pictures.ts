/**
 * The cache behind every `/api/auth/picture` an `Avatar` draws — the signed-in
 * person's own, on Settings → Account, and a colleague's, at the head of their
 * run in the group chat (HERM-120).
 *
 * In memory only, on purpose. There is nothing to persist: the picture is
 * fetched with this launch's own credentials, and a launch that starts over
 * starts this cache over with it — which is the whole of what "refetch on the
 * next app start" means here. `reset` covers the other half, a sign-in:
 * `ChatRuntimeProvider` calls it in the same effect that already clears the
 * roster and the chats for a gateway that just changed.
 *
 * Keyed on `${gatewayId}::${path}`, never on the bare id. Two different
 * gateways can mint the same `provider:sub` for two different people, and a
 * cache that could not tell the gateways apart would hand one of them the
 * other's picture.
 */
import { create } from 'zustand'

/** What `GatewayHttp.fetchAuthenticatedPicture` answers with — narrowed so this file need not import the class. */
export interface PictureFetchOutcome {
  kind: 'ready' | 'missing' | 'error'
  dataUri?: string
}

/** The one method this cache needs off `GatewayHttp`. */
export interface PersonPictureHttp {
  fetchAuthenticatedPicture(path: string): Promise<PictureFetchOutcome>
}

/**
 * `'loading'` while the round trip is in flight; `'unavailable'` for a 404 OR
 * any other failure — this cache does not retry either kind within a session,
 * so the two are one outcome here even though `PictureFetchOutcome` still
 * tells them apart for anyone that cares which.
 */
export type PersonPictureEntry = 'loading' | 'unavailable' | { uri: string }

interface PeoplePicturesState {
  byKey: Record<string, PersonPictureEntry>
  /**
   * Fire the fetch for `key` unless something is already known about it —
   * loading, ready, or a cached miss. Fire-and-forget: nothing here awaits the
   * result, a caller reads it back off `byKey` on the next render, the way
   * `usePersonPictureUri` does.
   */
  ensure: (key: string, http: PersonPictureHttp, path: string) => void
  reset: () => void
}

/** The cache key: gateway-scoped, so two gateways never share a picture. */
export const personPictureKey = (gatewayId: string, path: string): string => `${gatewayId}::${path}`

export const usePeoplePicturesStore = create<PeoplePicturesState>((set, get) => ({
  byKey: {},

  ensure: (key, http, path) => {
    if (get().byKey[key]) {
      return
    }

    // Set BEFORE the round trip starts: a second caller in the same tick, or
    // on the very next render, sees `'loading'` here and asks nothing of the
    // network. This is the whole of the de-duplication — no separate
    // in-flight map, because this assignment already closes the window.
    set(state => ({ byKey: { ...state.byKey, [key]: 'loading' } }))

    void http
      .fetchAuthenticatedPicture(path)
      .catch((): PictureFetchOutcome => ({ kind: 'error' }))
      .then(outcome => {
        set(state => ({
          byKey: {
            ...state.byKey,
            [key]: outcome.kind === 'ready' && outcome.dataUri ? { uri: outcome.dataUri } : 'unavailable'
          }
        }))
      })
  },

  reset: () => set({ byKey: {} })
}))

/** The `uri` an `Avatar` can draw, or `undefined` — loading, unavailable, or not asked for yet. */
export function personPictureUri(entry: PersonPictureEntry | undefined): string | undefined {
  return entry && typeof entry === 'object' ? entry.uri : undefined
}
